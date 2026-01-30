/**
 * BullMQAdapter - Worker adapter using BullMQ (Redis-backed)
 *
 * Features:
 * - Redis-backed persistent job queues
 * - Configurable concurrency per queue
 * - Job priority support
 * - Delayed job scheduling
 * - Automatic retries with configurable backoff
 * - Queue statistics
 *
 * Requires: bullmq and ioredis as peer dependencies
 *
 * @example
 * ```typescript
 * const adapter = new BullMQAdapter({
 *   host: "localhost",
 *   port: 6379,
 * });
 * ```
 */

import type { WorkerAdapter, WorkerJob, WorkerQueueStats } from "../WorkerTrigger";

import type { WorkerTriggerOpts } from "@blok/helper";

/**
 * BullMQ adapter configuration
 */
export interface BullMQConfig {
	/** Redis host (default: from REDIS_HOST env or "localhost") */
	host: string;
	/** Redis port (default: from REDIS_PORT env or 6379) */
	port: number;
	/** Redis password (default: from REDIS_PASSWORD env) */
	password?: string;
	/** Redis database (default: from REDIS_DB env or 0) */
	db?: number;
	/** Key prefix for all BullMQ keys */
	prefix?: string;
	/** Max stalled count before job fails */
	maxStalledCount?: number;
	/** Stalled interval in ms */
	stalledInterval?: number;
}

/**
 * BullMQ Worker Adapter
 *
 * Uses BullMQ for robust, Redis-backed job processing with support for
 * priority queues, delayed jobs, retries, and dead letter handling.
 */
export class BullMQAdapter implements WorkerAdapter {
	readonly provider = "bullmq" as const;
	private connection: unknown = null;
	private workers: Map<string, unknown> = new Map();
	private queues: Map<string, unknown> = new Map();
	private connected = false;
	private readonly config: BullMQConfig;

	constructor(config?: Partial<BullMQConfig>) {
		this.config = {
			host: config?.host || process.env.REDIS_HOST || "localhost",
			port: config?.port ?? Number.parseInt(process.env.REDIS_PORT || "6379", 10),
			password: config?.password || process.env.REDIS_PASSWORD,
			db: config?.db ?? Number.parseInt(process.env.REDIS_DB || "0", 10),
			prefix: config?.prefix || "blok-worker",
			maxStalledCount: config?.maxStalledCount ?? 2,
			stalledInterval: config?.stalledInterval ?? 5000,
		};
	}

	async connect(): Promise<void> {
		if (this.connected) return;

		try {
			const { default: IORedis } = await import("ioredis");
			this.connection = new IORedis({
				host: this.config.host,
				port: this.config.port,
				password: this.config.password,
				db: this.config.db,
				maxRetriesPerRequest: null, // Required for BullMQ
			});

			// Verify connection
			await (this.connection as { ping: () => Promise<string> }).ping();
			this.connected = true;
			console.log(`[BullMQAdapter] Connected to Redis at ${this.config.host}:${this.config.port}`);
		} catch (error) {
			throw new Error(
				`Failed to connect to Redis: ${(error as Error).message}. Ensure ioredis and bullmq are installed: npm install ioredis bullmq`,
			);
		}
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return;

		try {
			// Close all workers
			for (const [, worker] of this.workers) {
				await (worker as { close: () => Promise<void> }).close();
			}
			this.workers.clear();

			// Close all queues
			for (const [, queue] of this.queues) {
				await (queue as { close: () => Promise<void> }).close();
			}
			this.queues.clear();

			// Close Redis connection
			if (this.connection) {
				await (this.connection as { quit: () => Promise<string> }).quit();
			}

			this.connected = false;
			console.log("[BullMQAdapter] Disconnected from Redis");
		} catch (error) {
			console.error(`[BullMQAdapter] Disconnect error: ${(error as Error).message}`);
		}
	}

	async process(config: WorkerTriggerOpts, handler: (job: WorkerJob) => Promise<void>): Promise<void> {
		if (!this.connected) {
			throw new Error("Not connected. Call connect() first.");
		}

		try {
			// Dynamic import to avoid hard dependency on bullmq
			const bullmq = await import("bullmq");
			const BullWorker = bullmq.Worker;
			const BullQueue = bullmq.Queue;

			// Build worker options
			const workerOpts = {
				connection: this.connection,
				concurrency: config.concurrency ?? 1,
				prefix: this.config.prefix,
				stalledInterval: this.config.stalledInterval ?? 5000,
				maxStalledCount: this.config.maxStalledCount ?? 2,
			};

			const worker = new BullWorker(
				config.queue,
				// BullMQ processor callback
				((bullJob: unknown) => {
					const job = bullJob as {
						id?: string;
						data: unknown;
						opts?: { priority?: number; delay?: number };
						attemptsMade: number;
						timestamp: number;
						token?: string;
						moveToFailed: (err: Error, token: string, fetchNext: boolean) => Promise<void>;
					};
					const workerJob: WorkerJob = {
						id: job.id || `job-${Date.now()}`,
						data: job.data,
						headers: ((job.data as Record<string, unknown>)?._headers as Record<string, string>) || {},
						queue: config.queue,
						priority: job.opts?.priority ?? config.priority ?? 0,
						attempts: job.attemptsMade,
						maxRetries: config.retries ?? 3,
						createdAt: new Date(job.timestamp),
						delay: job.opts?.delay,
						timeout: config.timeout,
						raw: job,
						complete: async () => {
							// BullMQ auto-completes when processor resolves
						},
						fail: async (error: Error, requeue?: boolean) => {
							if (!requeue) {
								await job.moveToFailed(error, job.token || "", true);
							} else {
								throw error; // BullMQ will auto-retry
							}
						},
					};
					return handler(workerJob);
				}) as never,
				workerOpts as never,
			);

			this.workers.set(config.queue, worker);

			// Ensure queue object exists for job dispatching
			if (!this.queues.has(config.queue)) {
				const queue = new BullQueue(config.queue, {
					connection: this.connection as { host: string; port: number },
					prefix: this.config.prefix,
				} as never);
				this.queues.set(config.queue, queue);
			}

			console.log(`[BullMQAdapter] Processing queue: ${config.queue} (concurrency=${config.concurrency ?? 1})`);
		} catch (error) {
			throw new Error(`Failed to start processing: ${(error as Error).message}`);
		}
	}

	async addJob(
		queue: string,
		data: unknown,
		opts?: {
			priority?: number;
			delay?: number;
			retries?: number;
			timeout?: number;
			jobId?: string;
		},
	): Promise<string> {
		if (!this.connected) {
			throw new Error("Not connected. Call connect() first.");
		}

		try {
			// Ensure queue exists
			if (!this.queues.has(queue)) {
				const { Queue } = await import("bullmq");
				const q = new Queue(queue, {
					connection: this.connection as { host: string; port: number },
					prefix: this.config.prefix,
				});
				this.queues.set(queue, q);
			}

			const q = this.queues.get(queue) as {
				add: (name: string, data: unknown, opts: Record<string, unknown>) => Promise<{ id: string }>;
			};

			const job = await q.add("process", data, {
				priority: opts?.priority,
				delay: opts?.delay,
				attempts: (opts?.retries ?? 3) + 1,
				jobId: opts?.jobId,
				backoff: {
					type: "exponential",
					delay: 1000,
				},
			});

			return job.id;
		} catch (error) {
			throw new Error(`Failed to add job: ${(error as Error).message}`);
		}
	}

	async stopProcessing(queue: string): Promise<void> {
		const worker = this.workers.get(queue);
		if (worker) {
			await (worker as { close: () => Promise<void> }).close();
			this.workers.delete(queue);
			console.log(`[BullMQAdapter] Stopped processing queue: ${queue}`);
		}
	}

	isConnected(): boolean {
		return this.connected;
	}

	async healthCheck(): Promise<boolean> {
		if (!this.connected || !this.connection) return false;
		try {
			await (this.connection as { ping: () => Promise<string> }).ping();
			return true;
		} catch {
			return false;
		}
	}

	async getQueueStats(queue: string): Promise<WorkerQueueStats> {
		if (!this.queues.has(queue)) {
			return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
		}

		const q = this.queues.get(queue) as {
			getWaitingCount: () => Promise<number>;
			getActiveCount: () => Promise<number>;
			getCompletedCount: () => Promise<number>;
			getFailedCount: () => Promise<number>;
			getDelayedCount: () => Promise<number>;
		};

		const [waiting, active, completed, failed, delayed] = await Promise.all([
			q.getWaitingCount(),
			q.getActiveCount(),
			q.getCompletedCount(),
			q.getFailedCount(),
			q.getDelayedCount(),
		]);

		return { waiting, active, completed, failed, delayed };
	}
}
