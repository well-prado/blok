/**
 * RedisStreamsAdapter — v0.7 PR 5 — Worker adapter backed by Redis
 * Streams via `ioredis`. Consumes from a stream (the `queue` field)
 * with a consumer group (`consumerGroup`); produces via `XADD`.
 *
 * Semantics:
 *   - **Consumer groups**: required. `consumerGroup` defaults to
 *     `"${queue}-group"`. The group is auto-created (`MKSTREAM` on the
 *     stream too) on first `process()` call, at the `startFrom` cursor
 *     (`"latest"` → `$` default, `"earliest"` → `0`, or `fromBeginning`).
 *   - **Consumer name**: per-process uuid, so multiple instances of
 *     the same worker process don't share pending entries.
 *   - **ACK / retries**: ACK happens exactly once via `job.complete()`
 *     (success) — the consumer loop does NOT double-ACK. A terminal
 *     `job.fail(err, false)` XADDs the payload to `deadLetterQueue`
 *     (when configured) then XACKs the source so it isn't redelivered.
 *     A requeue `job.fail(err, true)` leaves the entry pending (visible
 *     in `XPENDING`) for redrive.
 *   - **ack:false**: the consumer reads with NOACK, so Redis never
 *     adds entries to the group's PEL — at-most-once, no leaked pending.
 *   - **Redrive**: there is NO periodic XAUTOCLAIM loop yet. Entries
 *     left pending by a crashed consumer (or a requeue `fail`) are only
 *     reclaimed if an operator runs XAUTOCLAIM out of band.
 *     // ponytail: add a periodic XAUTOCLAIM redrive loop (claim entries
 *     // idle > config.timeout, re-deliver to a live consumer) if
 *     // crash-recovery without operator intervention is needed.
 *   - **No native delay / priority**: Redis Streams has neither. `addJob`
 *     THROWS on `opts.delay` / `opts.priority` rather than silently
 *     dropping them — use a scheduler trigger for delayed work.
 *   - **Concurrency**: the `concurrency` consumer loops currently share
 *     ONE connection. // ponytail: give each loop its own ioredis
 *     connection if a single blocking XREADGROUP becomes a throughput
 *     bottleneck.
 *
 * Requires `ioredis` as a peer dependency:
 *
 *     bun add ioredis
 *
 * Environment variables:
 *   - `REDIS_HOST` (default `localhost`)
 *   - `REDIS_PORT` (default `6379`)
 *   - `REDIS_PASSWORD`
 *   - `REDIS_DB`
 */

import type { WorkerTriggerOpts } from "@blokjs/helper";
import { v4 as uuid } from "uuid";
import type { WorkerAdapter, WorkerJob, WorkerQueueStats } from "../WorkerTrigger";

export interface RedisStreamsConfig {
	host: string;
	port: number;
	password?: string;
	db?: number;
	blockMs: number;
	count: number;
}

interface RedisClient {
	xadd(stream: string, ...args: string[]): Promise<string>;
	xreadgroup(...args: string[]): Promise<Array<[string, Array<[string, string[]]>]> | null>;
	xgroup(...args: string[]): Promise<string>;
	xack(stream: string, group: string, ...ids: string[]): Promise<number>;
	xlen(stream: string): Promise<number>;
	xpending(stream: string, group: string): Promise<unknown>;
	ping(): Promise<string>;
	quit(): Promise<string>;
}

interface QueueRunner {
	stop: boolean;
	loops: number;
}

interface QueueStatsCounters {
	completed: number;
	failed: number;
	active: number;
}

export class RedisStreamsAdapter implements WorkerAdapter {
	readonly provider = "redis" as const;
	private readonly config: RedisStreamsConfig;
	private client: RedisClient | null = null;
	private runners: Map<string, QueueRunner> = new Map();
	private connected = false;
	private stats: Map<string, QueueStatsCounters> = new Map();
	private consumerName = `blok-${uuid().slice(0, 8)}`;

	constructor(config?: Partial<RedisStreamsConfig>) {
		this.config = {
			host: config?.host ?? process.env.REDIS_HOST ?? "localhost",
			port: config?.port ?? Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
			password: config?.password ?? process.env.REDIS_PASSWORD,
			db: config?.db ?? Number.parseInt(process.env.REDIS_DB ?? "0", 10),
			blockMs: config?.blockMs ?? 5000,
			count: config?.count ?? 10,
		};
	}

	async connect(): Promise<void> {
		if (this.connected) return;
		try {
			// biome-ignore lint/suspicious/noExplicitAny: ioredis is a runtime peer dep.
			const ioredis: any = await import("ioredis");
			const IORedis = ioredis.default ?? ioredis.Redis ?? ioredis;
			this.client = new IORedis({
				host: this.config.host,
				port: this.config.port,
				password: this.config.password,
				db: this.config.db,
			}) as RedisClient;
			await this.client.ping();
			this.connected = true;
		} catch (err) {
			throw new Error(
				`[blok][redis] connect failed: ${(err as Error).message}. Install ioredis as a peer dependency: bun add ioredis`,
			);
		}
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return;
		for (const runner of this.runners.values()) runner.stop = true;
		// Wait for in-flight loops to drain.
		const drainDeadline = Date.now() + 2000;
		while (Date.now() < drainDeadline) {
			let active = 0;
			for (const r of this.runners.values()) active += r.loops;
			if (active === 0) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		this.runners.clear();
		try {
			await this.client?.quit();
		} catch {
			/* ignore */
		}
		this.client = null;
		this.connected = false;
	}

	async process(config: WorkerTriggerOpts, handler: (job: WorkerJob) => Promise<void>): Promise<void> {
		if (!this.connected || !this.client) throw new Error("[blok][redis] not connected. Call connect() first.");
		const stream = config.queue;
		const group = config.consumerGroup ?? `${stream}-group`;
		// Create group + stream if missing, at the requested start cursor.
		// XGROUP CREATE with MKSTREAM errors with "BUSYGROUP" if the group
		// already exists — swallow it (the cursor is fixed at creation).
		const startId = this.resolveStartId(config);
		try {
			await this.client.xgroup("CREATE", stream, group, startId, "MKSTREAM");
		} catch (err) {
			if (!/BUSYGROUP/i.test((err as Error).message)) throw err;
		}

		const runner: QueueRunner = { stop: false, loops: 0 };
		this.runners.set(stream, runner);
		this.stats.set(stream, { completed: 0, failed: 0, active: 0 });
		const stats = this.stats.get(stream) as QueueStatsCounters;

		const concurrency = Math.max(1, config.concurrency ?? 1);
		for (let i = 0; i < concurrency; i += 1) {
			void this.runConsumerLoop(stream, group, config, handler, runner, stats);
		}
	}

	private async runConsumerLoop(
		stream: string,
		group: string,
		config: WorkerTriggerOpts,
		handler: (job: WorkerJob) => Promise<void>,
		runner: QueueRunner,
		stats: QueueStatsCounters,
	): Promise<void> {
		if (!this.client) return;
		// ack:false → at-most-once. NOACK tells Redis to deliver WITHOUT
		// adding the entry to the group's pending-entries list, so a handler
		// throw never leaves a leaked pending entry to redrive. NOACK sits
		// after the consumer name, before STREAMS.
		const noAck = config.ack === false;
		runner.loops += 1;
		try {
			while (!runner.stop) {
				let entries: Array<[string, Array<[string, string[]]>]> | null = null;
				try {
					const readArgs = [
						"GROUP",
						group,
						this.consumerName,
						"COUNT",
						String(this.config.count),
						"BLOCK",
						String(this.config.blockMs),
					];
					if (noAck) readArgs.push("NOACK");
					readArgs.push("STREAMS", stream, ">");
					entries = await this.client.xreadgroup(...readArgs);
				} catch (err) {
					await new Promise((r) => setTimeout(r, 1000));
					continue;
				}
				if (!entries) continue;
				for (const [, msgs] of entries) {
					for (const [id, fields] of msgs) {
						if (runner.stop) break;
						stats.active += 1;
						try {
							const payload = this.fieldsToObject(fields);
							const dataString = typeof payload.data === "string" ? payload.data : "";
							let data: unknown;
							try {
								data = dataString.length > 0 ? JSON.parse(dataString) : null;
							} catch {
								data = dataString;
							}
							// ACK exactly once. complete() and fail() both route through
							// this guard so a handler that calls job.complete() AND
							// returns (or fails after completing) never double-ACKs or
							// double-counts. Under NOACK there's nothing in the PEL to
							// ACK, but the guard still keeps the counters honest.
							let acked = false;
							const ackOnce = async (): Promise<void> => {
								if (acked) return;
								acked = true;
								if (!noAck) await this.client?.xack(stream, group, id);
							};
							const job: WorkerJob = {
								id,
								data,
								headers: {},
								queue: stream,
								priority: config.priority ?? 0,
								attempts: 0,
								maxRetries: config.retries ?? 0,
								createdAt: new Date(Number.parseInt(id.split("-")[0] ?? String(Date.now()), 10)),
								timeout: config.timeout,
								raw: { id, fields },
								complete: async () => {
									if (acked) return;
									await ackOnce();
									stats.completed += 1;
								},
								fail: async (_err: Error, requeue?: boolean) => {
									if (acked) return;
									stats.failed += 1;
									if (requeue) {
										// Leave the entry pending (in the PEL) for redrive.
										// No-op under NOACK — nothing was tracked.
										return;
									}
									// Terminal failure: dead-letter the original payload to
									// the DLQ stream, then ACK the source so it isn't
									// redelivered. No-op DLQ when unset.
									if (config.deadLetterQueue) {
										const raw = this.fieldsToObject(fields);
										await this.client?.xadd(
											config.deadLetterQueue,
											"*",
											"data",
											raw.data ?? "",
											"jobId",
											raw.jobId ?? id,
										);
									}
									await ackOnce();
								},
							};
							await handler(job);
							// handler (WorkerTrigger.handleJob) owns ACK via complete()/
							// fail(). The loop no longer ACKs or counts here — doing so
							// double-ACKed and double-counted every completed job.
						} catch {
							stats.failed += 1;
							// ponytail: entry left pending; no auto-redrive loop yet
							// (see header). Operator XAUTOCLAIM reclaims it.
						} finally {
							stats.active = Math.max(0, stats.active - 1);
						}
					}
				}
			}
		} finally {
			runner.loops -= 1;
		}
	}

	/**
	 * Map the trigger's start position to the id passed to XGROUP CREATE.
	 *   - `"latest"` (default) → `$`  : only entries added after creation.
	 *   - `"earliest"` / `fromBeginning:true` → `0` : the whole retained stream.
	 *   - `{ seq }` / `{ timestamp }` → that explicit cursor id.
	 * `startFrom` rides on the PubSub schema, not WorkerTriggerOpts, so it's
	 * read defensively off `config` for callers that thread it through.
	 */
	private resolveStartId(config: WorkerTriggerOpts): string {
		if (config.fromBeginning) return "0";
		const startFrom = (config as { startFrom?: unknown }).startFrom;
		if (startFrom === "earliest") return "0";
		if (startFrom === "latest" || startFrom === undefined) return "$";
		if (typeof startFrom === "object" && startFrom !== null) {
			const s = startFrom as { seq?: number; timestamp?: number };
			if (typeof s.seq === "number") return `${s.seq}-0`;
			if (typeof s.timestamp === "number") return `${s.timestamp}-0`;
		}
		return "$";
	}

	private fieldsToObject(fields: string[]): Record<string, string> {
		const out: Record<string, string> = {};
		for (let i = 0; i < fields.length; i += 2) {
			out[fields[i]] = fields[i + 1];
		}
		return out;
	}

	async addJob(
		queue: string,
		data: unknown,
		opts?: { priority?: number; delay?: number; retries?: number; timeout?: number; jobId?: string },
	): Promise<string> {
		if (!this.connected || !this.client) throw new Error("[blok][redis] not connected. Call connect() first.");
		// Redis Streams has NO native delayed delivery or priority. Reject at
		// enqueue rather than silently dropping the option — surfacing the
		// misconfiguration is the lazy-correct choice (a scheduler trigger owns
		// delayed work; XADD is strictly FIFO by id).
		if (opts?.delay) {
			throw new Error(
				"[blok][redis] Redis Streams has no native delayed delivery — drop `delay` or use a scheduler trigger.",
			);
		}
		if (opts?.priority) {
			throw new Error("[blok][redis] Redis Streams has no native priority — drop `priority`; entries are FIFO by id.");
		}
		const payload = typeof data === "string" ? data : JSON.stringify(data);
		// XADD key [NOMKSTREAM] <* | id> field value … — NOMKSTREAM (when a
		// jobId is supplied, meaning the caller expects the stream to already
		// exist) MUST precede the `*` id, and the assembled args must actually
		// be passed to xadd (the prior build threw them away).
		const args: string[] = [queue];
		if (opts?.jobId) args.push("NOMKSTREAM");
		args.push("*", "data", payload, "jobId", opts?.jobId ?? "");
		const id = await this.client.xadd(...(args as [string, ...string[]]));
		return id;
	}

	async stopProcessing(queue: string): Promise<void> {
		const runner = this.runners.get(queue);
		if (runner) runner.stop = true;
	}

	isConnected(): boolean {
		return this.connected;
	}

	async healthCheck(): Promise<boolean> {
		if (!this.connected || !this.client) return false;
		try {
			const pong = await this.client.ping();
			return pong === "PONG";
		} catch {
			return false;
		}
	}

	async getQueueStats(queue: string): Promise<WorkerQueueStats> {
		const counters = this.stats.get(queue) ?? { completed: 0, failed: 0, active: 0 };
		let waiting = 0;
		try {
			waiting = (await this.client?.xlen(queue)) ?? 0;
		} catch {
			/* ignore */
		}
		return {
			waiting,
			active: counters.active,
			completed: counters.completed,
			failed: counters.failed,
			delayed: 0,
		};
	}
}
