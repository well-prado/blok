/**
 * PgBossAdapter — v0.7 PR 5 — Worker adapter backed by `pg-boss`,
 * which stores jobs in PostgreSQL. Operationally attractive when
 * Postgres is already in the stack — no extra broker infra needed.
 *
 * Semantics:
 *   - `pg-boss` handles concurrency, retries, dead-letter, priority,
 *     delays, and exactly-once scheduling natively — the adapter
 *     forwards `config.concurrency`, `config.retries`, etc. to the
 *     `boss.work(queue, opts, handler)` and `boss.send(queue, data, opts)`
 *     calls directly.
 *   - **Single connection per process** — `pg-boss` manages its own
 *     pool; we instantiate one `PgBoss` instance per `PgBossAdapter`.
 *   - **Schema**: `pg-boss` creates its own schema (`pgboss` by
 *     default) on first start. Tables are migrated automatically.
 *
 * Requires `pg-boss` as a peer dependency:
 *
 *     bun add pg-boss
 *
 * Environment variables:
 *   - `DATABASE_URL` — Postgres connection string (default
 *     `postgres://localhost:5432/blok`).
 *   - `PG_BOSS_SCHEMA` — schema name (default `"pgboss"`).
 */

import type { WorkerTriggerOpts } from "@blokjs/helper";
import { v4 as uuid } from "uuid";
import type { WorkerAdapter, WorkerJob, WorkerQueueStats } from "../WorkerTrigger";

export interface PgBossConfig {
	connectionString: string;
	schema?: string;
}

interface PgBossInstance {
	start(): Promise<unknown>;
	stop(opts?: { graceful?: boolean }): Promise<void>;
	createQueue(queue: string, opts?: Record<string, unknown>): Promise<unknown>;
	send(queue: string, data: unknown, opts?: Record<string, unknown>): Promise<string | null>;
	work(
		queue: string,
		opts: Record<string, unknown>,
		handler: (job: PgBossJob | PgBossJob[]) => Promise<unknown>,
	): Promise<string>;
	offWork(queue: string): Promise<void>;
	getQueueSize(queue: string): Promise<number>;
}

interface PgBossJob {
	id: string;
	data: unknown;
	name: string;
}

interface QueueStatsCounters {
	completed: number;
	failed: number;
	active: number;
}

export class PgBossAdapter implements WorkerAdapter {
	readonly provider = "pg-boss" as const;
	private readonly config: PgBossConfig;
	private boss: PgBossInstance | null = null;
	private workIds: Map<string, string> = new Map();
	private connected = false;
	private stats: Map<string, QueueStatsCounters> = new Map();

	constructor(config?: Partial<PgBossConfig>) {
		this.config = {
			connectionString: config?.connectionString ?? process.env.DATABASE_URL ?? "postgres://localhost:5432/blok",
			schema: config?.schema ?? process.env.PG_BOSS_SCHEMA ?? "pgboss",
		};
	}

	async connect(): Promise<void> {
		if (this.connected) return;
		try {
			// Indirect specifier so tsc doesn't try to resolve types for
			// the optional peer dependency at build time.
			const moduleName = "pg-boss";
			// biome-ignore lint/suspicious/noExplicitAny: pg-boss is a runtime peer dep.
			const mod: any = await import(moduleName);
			// biome-ignore lint/suspicious/noExplicitAny: pg-boss is a runtime peer dep.
			const PgBoss: any = mod.default ?? mod;
			this.boss = new PgBoss({
				connectionString: this.config.connectionString,
				schema: this.config.schema,
			}) as PgBossInstance;
			await this.boss.start();
			this.connected = true;
		} catch (err) {
			throw new Error(
				`[blok][pg-boss] connect failed: ${(err as Error).message}. Install pg-boss as a peer dependency: bun add pg-boss`,
			);
		}
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return;
		try {
			await this.boss?.stop({ graceful: true });
		} catch {
			/* ignore */
		}
		this.workIds.clear();
		this.boss = null;
		this.connected = false;
	}

	async process(config: WorkerTriggerOpts, handler: (job: WorkerJob) => Promise<void>): Promise<void> {
		if (!this.connected || !this.boss) throw new Error("[blok][pg-boss] not connected. Call connect() first.");
		this.stats.set(config.queue, { completed: 0, failed: 0, active: 0 });
		const stats = this.stats.get(config.queue) as QueueStatsCounters;

		// pg-boss v10 requires explicit queue creation before send/work.
		// The call is idempotent — succeeds whether the queue exists or
		// not — so this is safe to repeat across re-entries.
		await this.ensureQueue(config.queue, config);

		// pg-boss v10's handler receives an ARRAY of jobs (batch); the
		// `batchSize` option caps how many jobs one poll fetches. pg-boss
		// has no per-job `concurrency`/`teamSize` knob — its unit of
		// parallelism is the batch the handler is handed — so we map
		// `config.concurrency` (the requested parallelism) to `batchSize`.
		// The handler loop below processes the batch; jobs within it run
		// sequentially in this process, but a larger batch means more jobs
		// drained per poll (= higher effective throughput). `concurrency`
		// defaults to 1 in the worker schema → single-job fetch, matching
		// the prior behaviour. `pollingIntervalSeconds` defaults to 2s
		// which adds ~2s latency on the happy path — tighten via config.
		const batchSize = config.concurrency && config.concurrency > 0 ? config.concurrency : 1;
		const id = await this.boss.work(
			config.queue,
			{
				batchSize,
				includeMetadata: true,
			},
			async (jobOrBatch) => {
				const jobs = Array.isArray(jobOrBatch) ? jobOrBatch : [jobOrBatch];
				for (const job of jobs) {
					await this.runOneJob(config, handler, stats, job);
				}
			},
		);
		this.workIds.set(config.queue, id);
	}

	private async runOneJob(
		config: WorkerTriggerOpts,
		handler: (job: WorkerJob) => Promise<void>,
		stats: QueueStatsCounters,
		job: PgBossJob,
	): Promise<void> {
		stats.active += 1;
		// Tracks whether stats have already been counted by the
		// WorkerJob API (`complete` / `fail`). Without this, both
		// the callback and the wrapper's try/catch credit the same
		// outcome, double-counting `stats.completed` /
		// `stats.failed`. pg-boss itself handles ack/retry/DLQ via
		// the handler's return-vs-throw — these callbacks exist
		// purely for stats parity with the other worker adapters.
		let settled = false;
		const workerJob: WorkerJob = {
			id: job.id,
			data: job.data,
			headers: {},
			queue: config.queue,
			priority: config.priority ?? 0,
			attempts: 0,
			maxRetries: config.retries ?? 0,
			createdAt: new Date(),
			timeout: config.timeout,
			raw: job,
			complete: async () => {
				if (settled) return;
				stats.completed += 1;
				settled = true;
			},
			fail: async (err: Error, requeue?: boolean) => {
				if (settled) return;
				stats.failed += 1;
				settled = true;
				if (requeue === false) {
					// Terminal (non-retryable, e.g. an ADR-0015 validation 400).
					// pg-boss retries whenever the handler throws, so DON'T throw:
					// resolve instead so the job completes and is not retried
					// `retryLimit` times against a deterministic failure. (pg-boss
					// has no immediate-dead-letter primitive; the row is consumed.)
					return;
				}
				// Re-throw so pg-boss's `boss.work` sees the handler failure and
				// schedules a retry / drops to DLQ per the queue config — the
				// contract is "handler throws => job failed".
				throw err;
			},
		};
		try {
			await handler(workerJob);
			if (!settled) {
				stats.completed += 1;
				settled = true;
			}
		} catch (err) {
			if (!settled) {
				stats.failed += 1;
				settled = true;
			}
			throw err;
		} finally {
			stats.active = Math.max(0, stats.active - 1);
		}
	}

	private async ensureQueue(queue: string, config?: WorkerTriggerOpts): Promise<void> {
		if (!this.boss) return;
		// Per-queue routing/retry policy. pg-boss 10 applies these at the
		// QUEUE level (the `createQueue` options), not on `work()` — a
		// failed job is retried `retryLimit` times then routed to the
		// `deadLetter` queue automatically. The DLQ is itself a queue, so
		// it must exist before it can receive dead-lettered jobs.
		const queueOpts: Record<string, unknown> = { name: queue };
		const dlq = config?.deadLetterQueue;
		if (typeof dlq === "string" && dlq.length > 0) {
			queueOpts.deadLetter = dlq;
			await this.createQueueIdempotent(dlq, { name: dlq });
		}
		if (typeof config?.retries === "number") queueOpts.retryLimit = config.retries;
		if (typeof config?.timeout === "number" && config.timeout > 0) {
			queueOpts.expireInSeconds = Math.ceil(config.timeout / 1000);
		}
		await this.createQueueIdempotent(queue, queueOpts);
	}

	private async createQueueIdempotent(queue: string, opts: Record<string, unknown>): Promise<void> {
		if (!this.boss) return;
		try {
			await this.boss.createQueue(queue, opts);
		} catch (err) {
			// pg-boss v10's createQueue is idempotent but may throw on
			// race conditions when multiple processes call it concurrently
			// against a fresh schema — those errors are harmless once the
			// queue exists. Swallow + let downstream send/work surface a
			// real problem if the queue isn't usable.
			const message = (err as Error).message ?? "";
			if (!message.includes("already exists")) {
				// Log the unexpected case but don't propagate — operators
				// shouldn't see a queue-creation race blow up their
				// trigger boot path.
				console.warn(`[blok][pg-boss] ensureQueue(${queue}) warning:`, message);
			}
		}
	}

	async addJob(
		queue: string,
		data: unknown,
		opts?: { priority?: number; delay?: number; retries?: number; timeout?: number; jobId?: string },
	): Promise<string> {
		if (!this.connected || !this.boss) throw new Error("[blok][pg-boss] not connected. Call connect() first.");
		// pg-boss v10 requires the queue to exist before send. The
		// call is idempotent — cheap to repeat per add.
		await this.ensureQueue(queue);
		// pg-boss v10's `attorney.checkSendArgs` rejects any explicitly
		// undefined `priority` / `retryLimit` / `startAfter` /
		// `expireInSeconds` / `singletonKey` with "X must be an integer".
		// Build the options object with only the keys we actually want
		// set — caught by the real-broker integration test in
		// `__tests__/integration/pgboss-adapter.real-pg.test.ts`.
		const sendOpts: Record<string, unknown> = {};
		if (typeof opts?.priority === "number") sendOpts.priority = opts.priority;
		if (typeof opts?.delay === "number" && opts.delay > 0) {
			sendOpts.startAfter = Math.ceil(opts.delay / 1000);
		}
		if (typeof opts?.retries === "number") sendOpts.retryLimit = opts.retries;
		if (typeof opts?.timeout === "number") sendOpts.expireInSeconds = Math.ceil(opts.timeout / 1000);
		if (typeof opts?.jobId === "string" && opts.jobId.length > 0) sendOpts.singletonKey = opts.jobId;

		const jobId = await this.boss.send(queue, data, sendOpts);
		return jobId ?? opts?.jobId ?? uuid();
	}

	async stopProcessing(queue: string): Promise<void> {
		if (!this.connected || !this.boss) return;
		try {
			await this.boss.offWork(queue);
		} catch {
			/* ignore */
		}
		this.workIds.delete(queue);
	}

	isConnected(): boolean {
		return this.connected;
	}

	async healthCheck(): Promise<boolean> {
		if (!this.connected || !this.boss) return false;
		try {
			await this.boss.getQueueSize("__health_check__");
			return true;
		} catch {
			// getQueueSize on a non-existent queue may throw — fall back to
			// "connection is live" by checking the boss instance attribute.
			return this.connected;
		}
	}

	async getQueueStats(queue: string): Promise<WorkerQueueStats> {
		const counters = this.stats.get(queue) ?? { completed: 0, failed: 0, active: 0 };
		let waiting = 0;
		try {
			waiting = (await this.boss?.getQueueSize(queue)) ?? 0;
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
