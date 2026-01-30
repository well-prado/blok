/**
 * RedisAdapter - Redis/BullMQ queue adapter for QueueTrigger
 *
 * Uses BullMQ for Redis-based job queue functionality.
 * Requires: npm install bullmq ioredis
 *
 * Environment variables:
 * - REDIS_HOST: Redis host (default: localhost)
 * - REDIS_PORT: Redis port (default: 6379)
 * - REDIS_PASSWORD: Redis password (optional)
 * - REDIS_DB: Redis database number (default: 0)
 * - REDIS_TLS: Enable TLS (default: false)
 */

import type { QueueTriggerOpts } from "@nanoservice-ts/helper";
import { v4 as uuid } from "uuid";
import type { QueueAdapter, QueueMessage } from "../QueueTrigger";

/**
 * Redis connection configuration
 */
export interface RedisConfig {
	host: string;
	port: number;
	password?: string;
	db?: number;
	tls?: boolean;
}

/**
 * RedisAdapter - BullMQ implementation of QueueAdapter
 */
export class RedisAdapter implements QueueAdapter {
	readonly provider = "redis" as const;

	private connection: any;
	private workers: Map<string, any> = new Map();
	private connected = false;
	private config: RedisConfig;

	constructor(config?: Partial<RedisConfig>) {
		this.config = {
			host: config?.host || process.env.REDIS_HOST || "localhost",
			port: config?.port ?? Number.parseInt(process.env.REDIS_PORT || "6379", 10),
			password: config?.password || process.env.REDIS_PASSWORD,
			db: config?.db ?? Number.parseInt(process.env.REDIS_DB || "0", 10),
			tls: config?.tls ?? process.env.REDIS_TLS === "true",
		};
	}

	/**
	 * Connect to Redis
	 */
	async connect(): Promise<void> {
		if (this.connected) return;

		try {
			// Dynamic import of ioredis
			const { default: IORedis } = await import("ioredis");

			this.connection = new IORedis({
				host: this.config.host,
				port: this.config.port,
				password: this.config.password,
				db: this.config.db,
				tls: this.config.tls ? {} : undefined,
				maxRetriesPerRequest: null, // Required for BullMQ
			});

			// Test connection
			await this.connection.ping();

			this.connected = true;
			console.log(`[RedisAdapter] Connected to Redis: ${this.config.host}:${this.config.port}`);
		} catch (error) {
			throw new Error(
				`Failed to connect to Redis: ${(error as Error).message}. ` +
					`Make sure ioredis and bullmq are installed: npm install ioredis bullmq`,
			);
		}
	}

	/**
	 * Disconnect from Redis
	 */
	async disconnect(): Promise<void> {
		if (!this.connected) return;

		try {
			// Close all workers
			for (const [queueName, worker] of this.workers) {
				await worker.close();
			}
			this.workers.clear();

			// Close Redis connection
			await this.connection.quit();
			this.connected = false;
			console.log("[RedisAdapter] Disconnected from Redis");
		} catch (error) {
			console.error(`[RedisAdapter] Error disconnecting: ${(error as Error).message}`);
		}
	}

	/**
	 * Subscribe to a BullMQ queue
	 */
	async subscribe(config: QueueTriggerOpts, handler: (message: QueueMessage) => Promise<void>): Promise<void> {
		if (!this.connected) {
			throw new Error("Not connected to Redis. Call connect() first.");
		}

		const queueName = config.topic;

		try {
			// Dynamic import of BullMQ
			const { Worker } = await import("bullmq");

			// Create worker for this queue
			const worker = new Worker(
				queueName,
				async (job: any) => {
					// Create queue message from BullMQ job
					const queueMessage: QueueMessage = {
						id: job.id || uuid(),
						body: job.data,
						headers: job.opts?.headers || {},
						raw: job,
						topic: queueName,
						timestamp: job.timestamp ? new Date(job.timestamp) : new Date(),
						ack: async () => {
							// BullMQ auto-removes completed jobs
							// Nothing to do here unless we want to mark as completed manually
						},
						nack: async (requeue = true) => {
							if (requeue) {
								// Move job back to waiting state
								await job.moveToFailed(new Error("Message rejected"), job.token, true);
							} else {
								// Mark as failed without retry
								await job.moveToFailed(new Error("Message rejected"), job.token, false);
							}
						},
					};

					// Process message - let errors propagate for BullMQ retry handling
					await handler(queueMessage);
				},
				{
					connection: this.connection.duplicate(),
					concurrency: config.concurrency || 1,
				},
			);

			// Handle worker events
			worker.on("completed", (job: any) => {
				console.log(`[RedisAdapter] Job ${job.id} completed`);
			});

			worker.on("failed", (job: any, err: Error) => {
				console.error(`[RedisAdapter] Job ${job?.id} failed: ${err.message}`);
			});

			worker.on("error", (err: Error) => {
				console.error(`[RedisAdapter] Worker error: ${err.message}`);
			});

			this.workers.set(queueName, worker);
			console.log(`[RedisAdapter] Subscribed to queue: ${queueName}`);
		} catch (error) {
			throw new Error(`Failed to create BullMQ worker: ${(error as Error).message}`);
		}
	}

	/**
	 * Unsubscribe from a BullMQ queue
	 */
	async unsubscribe(queueName: string): Promise<void> {
		const worker = this.workers.get(queueName);
		if (worker) {
			await worker.close();
			this.workers.delete(queueName);
			console.log(`[RedisAdapter] Unsubscribed from queue: ${queueName}`);
		}
	}

	/**
	 * Check if connected to Redis
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Health check - verify Redis connectivity
	 */
	async healthCheck(): Promise<boolean> {
		if (!this.connected) return false;

		try {
			const pong = await this.connection.ping();
			return pong === "PONG";
		} catch {
			return false;
		}
	}
}

export default RedisAdapter;
