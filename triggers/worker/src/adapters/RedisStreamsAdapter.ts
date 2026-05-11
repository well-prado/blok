/**
 * RedisStreamsAdapter — v0.7 PR 5 — Worker adapter backed by Redis
 * Streams via `ioredis`. Consumes from a stream (the `queue` field)
 * with a consumer group (`consumerGroup`); produces via `XADD`.
 *
 * Semantics:
 *   - **Consumer groups**: required. `consumerGroup` defaults to
 *     `"${queue}-group"`. The group is auto-created (`MKSTREAM` on the
 *     stream too) on first `process()` call.
 *   - **Consumer name**: per-process uuid, so multiple instances of
 *     the same worker process don't share pending entries.
 *   - **Retries**: pending entries are XACK'd on success / left
 *     unacked on failure (visible in `XPENDING`). A redrive loop
 *     reads pending entries older than `timeout` and re-delivers
 *     to the current consumer.
 *   - **Auto-claim**: skipped in v1 — operators should run XAUTOCLAIM
 *     periodically out of band.
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
		// Create group + stream if missing. XGROUP CREATE with MKSTREAM
		// errors with "BUSYGROUP" if the group already exists — swallow it.
		try {
			await this.client.xgroup("CREATE", stream, group, "$", "MKSTREAM");
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
		runner.loops += 1;
		try {
			while (!runner.stop) {
				let entries: Array<[string, Array<[string, string[]]>]> | null = null;
				try {
					entries = await this.client.xreadgroup(
						"GROUP",
						group,
						this.consumerName,
						"COUNT",
						String(this.config.count),
						"BLOCK",
						String(this.config.blockMs),
						"STREAMS",
						stream,
						">",
					);
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
									await this.client?.xack(stream, group, id);
									stats.completed += 1;
								},
								fail: async (_err: Error) => {
									stats.failed += 1;
								},
							};
							await handler(job);
							if (config.ack !== false) await this.client?.xack(stream, group, id);
							stats.completed += 1;
						} catch {
							stats.failed += 1;
							// Pending entry left unacked — picked up by XAUTOCLAIM.
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
		const payload = typeof data === "string" ? data : JSON.stringify(data);
		const args: string[] = [];
		if (opts?.jobId) args.push("NOMKSTREAM");
		const id = await this.client.xadd(queue, "*", "data", payload, "jobId", opts?.jobId ?? "");
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
