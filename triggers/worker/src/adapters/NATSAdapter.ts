/**
 * NATSAdapter - NATS JetStream worker adapter for WorkerTrigger
 *
 * Uses NATS JetStream for persistent background job processing with:
 * - Pull-based consumers with configurable concurrency
 * - Server-side retry config (max_deliver)
 * - Ack wait for job timeouts
 * - Priority via message headers
 * - Delayed job scheduling
 * - Queue statistics via consumer info
 *
 * Requires: npm install nats
 *
 * Environment variables:
 * - NATS_SERVERS: Comma-separated NATS server URLs (default: localhost:4222)
 * - NATS_TOKEN: Authentication token (optional)
 * - NATS_USER: Username for auth (optional)
 * - NATS_PASS: Password for auth (optional)
 * - NATS_STREAM_NAME: JetStream stream name (default: blok-worker)
 */

import type { WorkerTriggerOpts } from "@blokjs/helper";
import { v4 as uuid } from "uuid";
import type { WorkerAdapter, WorkerJob, WorkerQueueStats } from "../WorkerTrigger";

/**
 * Tier 2 polish — compute the consumer-side hold time for a NATS message
 * with an `x-delay` header. NATS JetStream stores `x-delay` as opaque
 * metadata; the broker does NOT defer delivery on it. The consumer is
 * responsible for honouring the delay between the message's first-publish
 * timestamp and `createdMs + delay`.
 *
 * Returns the milliseconds to wait. Clamps to >= 0; returns 0 when the
 * delay has already elapsed (the message was queued for longer than the
 * delay) or when no delay was set.
 *
 * Exported for unit testability — the consumer message handler in
 * `NATSWorkerAdapter.process()` mocks the NATS client extensively, so
 * isolating the math here keeps the surface easy to verify.
 */
export function computeXDelayHoldMs(delay: number, createdMs: number, nowMs: number): number {
	if (!delay || delay <= 0) return 0;
	const dispatchAt = createdMs + delay;
	return Math.max(0, dispatchAt - nowMs);
}

/**
 * NATS worker adapter configuration
 */
export interface NATSWorkerConfig {
	/** NATS server URLs */
	servers: string[];
	/** Authentication token */
	token?: string;
	/** Username */
	user?: string;
	/** Password */
	pass?: string;
	/** JetStream stream name (default: "blok-worker") */
	streamName?: string;
}

/**
 * NATSWorkerAdapter - NATS JetStream implementation of WorkerAdapter
 */
export class NATSWorkerAdapter implements WorkerAdapter {
	readonly provider = "nats" as const;

	// biome-ignore lint/suspicious/noExplicitAny: NATS types are dynamically imported (optional peer dependency)
	private nc: any = null;
	// biome-ignore lint/suspicious/noExplicitAny: NATS types are dynamically imported
	private js: any = null;
	// biome-ignore lint/suspicious/noExplicitAny: NATS types are dynamically imported
	private jsm: any = null;
	private connected = false;
	private config: NATSWorkerConfig;
	// biome-ignore lint/suspicious/noExplicitAny: NATS consumer instances
	private consumers: Map<string, any> = new Map();
	// biome-ignore lint/suspicious/noExplicitAny: NATS consume iterators
	private consumeIterators: Map<string, any> = new Map();

	constructor(config?: Partial<NATSWorkerConfig>) {
		this.config = {
			servers: config?.servers || (process.env.NATS_SERVERS || "localhost:4222").split(","),
			token: config?.token || process.env.NATS_TOKEN,
			user: config?.user || process.env.NATS_USER,
			pass: config?.pass || process.env.NATS_PASS,
			streamName: config?.streamName || process.env.NATS_STREAM_NAME || "blok-worker",
		};
	}

	/**
	 * Connect to NATS and initialize JetStream
	 */
	async connect(): Promise<void> {
		if (this.connected) return;

		try {
			const nats = await import("nats");

			const connectOpts: Record<string, unknown> = {
				servers: this.config.servers,
			};

			if (this.config.token) connectOpts.token = this.config.token;
			if (this.config.user) connectOpts.user = this.config.user;
			if (this.config.pass) connectOpts.pass = this.config.pass;

			this.nc = await nats.connect(connectOpts);
			this.js = this.nc.jetstream();
			this.jsm = await this.nc.jetstreamManager();

			this.connected = true;
			console.log(`[NATSWorkerAdapter] Connected to NATS: ${this.config.servers.join(", ")}`);
		} catch (error) {
			throw new Error(
				`Failed to connect to NATS: ${(error as Error).message}. Make sure nats is installed: npm install nats`,
			);
		}
	}

	/**
	 * Disconnect from NATS
	 */
	async disconnect(): Promise<void> {
		if (!this.connected) return;

		try {
			// Stop all consume iterators
			for (const [, iter] of this.consumeIterators) {
				try {
					iter.stop();
				} catch {
					// Iterator may already be stopped
				}
			}
			this.consumeIterators.clear();
			this.consumers.clear();

			await this.nc.drain();
			this.connected = false;
			console.log("[NATSWorkerAdapter] Disconnected from NATS");
		} catch (error) {
			console.error(`[NATSWorkerAdapter] Disconnect error: ${(error as Error).message}`);
		}
	}

	/**
	 * Start processing jobs from a queue
	 */
	async process(config: WorkerTriggerOpts, handler: (job: WorkerJob) => Promise<void>): Promise<void> {
		if (!this.connected) {
			throw new Error("Not connected. Call connect() first.");
		}

		const nats = await import("nats");
		const queue = config.queue;
		const streamName = this.config.streamName || "blok-worker";
		const subject = `worker.${queue}`;
		const durableName = `blok-worker-${queue}`;

		// Ensure stream exists with worker subjects
		await this.ensureStream(streamName, [subject]);

		// v0.7 — `ack: false` selects at-most-once delivery. JetStream PULL
		// consumers reject AckPolicy.None ("consumer in pull mode requires ack
		// policy"), so at-most-once is implemented as AckPolicy.Explicit +
		// max_deliver:1 with the message ACKed on receipt (before the handler
		// runs). The broker then treats the message as delivered+done, so a
		// handler that throws is NOT redelivered — exactly-once delivery even
		// on failure. The manual ack/nak/term path below is a no-op in this mode.
		const atMostOnce = config.ack === false;

		// Create or update durable pull consumer with worker semantics
		const ackWaitNs = ((config.timeout ?? 30000) + 5000) * 1_000_000; // timeout + 5s buffer, in nanoseconds
		await this.jsm.consumers.add(streamName, {
			durable_name: durableName,
			ack_policy: nats.AckPolicy.Explicit,
			// at-most-once: deliver exactly once, never redeliver.
			max_deliver: atMostOnce ? 1 : (config.retries ?? 3) + 1, // +1 because first attempt counts
			ack_wait: ackWaitNs,
			filter_subjects: [subject],
		});

		// Get consumer handle
		const consumer = await this.js.consumers.get(streamName, durableName);
		this.consumers.set(queue, consumer);

		// Start consuming
		const iter = await consumer.consume();
		this.consumeIterators.set(queue, iter);

		// Process jobs in background
		(async () => {
			const semaphore = new Semaphore(config.concurrency ?? 1);

			for await (const msg of iter) {
				await semaphore.acquire();

				// Process each job concurrently up to concurrency limit
				(async () => {
					try {
						// Parse job data
						let data: unknown;
						try {
							const codec = nats.JSONCodec();
							data = codec.decode(msg.data);
						} catch {
							try {
								const sc = nats.StringCodec();
								data = JSON.parse(sc.decode(msg.data));
							} catch {
								data = msg.data;
							}
						}

						// Extract headers
						const headers: Record<string, string> = {};
						if (msg.headers) {
							for (const [key, values] of msg.headers) {
								headers[key] = Array.isArray(values) ? values[0] : values;
							}
						}

						// Extract job metadata from headers
						const jobId = headers["x-job-id"] || msg.headers?.get("Nats-Msg-Id") || uuid();
						const priority = Number.parseInt(headers["x-priority"] || "0", 10);
						const delay = Number.parseInt(headers["x-delay"] || "0", 10);
						const timeout = Number.parseInt(headers["x-timeout"] || "0", 10);

						// Get redelivery count (attempts)
						const info = msg.info;
						const attempts = info.redeliveryCount ?? 0;
						const maxRetries = config.retries ?? 3;

						// Create WorkerJob
						const workerJob: WorkerJob = {
							id: jobId,
							data,
							headers,
							queue,
							priority,
							attempts,
							maxRetries,
							createdAt: new Date(
								info.timestampNanos ? Math.floor(Number(info.timestampNanos) / 1_000_000) : Date.now(),
							),
							delay: delay || undefined,
							timeout: timeout || config.timeout || undefined,
							raw: msg,
							complete: async () => {
								// Already ACKed on receipt under at-most-once; a second ack errors.
								if (!atMostOnce) msg.ack();
							},
							fail: async (error: Error, requeue?: boolean) => {
								if (requeue) {
									// nak() tells the server to redeliver. No-op under
									// at-most-once — the message was already ACKed on receipt.
									if (!atMostOnce) msg.nak();
								} else {
									// Terminal failure (retries exhausted / non-requeue).
									// v0.7 — dead-letter the original payload+headers to
									// `worker.${deadLetterQueue}` before terminating so the
									// message isn't silently dropped. No-op when DLQ is unset.
									await this.deadLetter(config.deadLetterQueue, msg.data, msg.headers);
									// term() terminates delivery — no more retries. Already
									// ACKed under at-most-once, so term() is skipped there.
									if (!atMostOnce) msg.term();
								}
							},
						};

						// at-most-once — ACK before running the handler so the broker
						// considers the message done. max_deliver:1 already prevents
						// redelivery; this also releases the ack_wait timer immediately.
						if (atMostOnce) msg.ack();

						// Tier 2 polish — enforce `x-delay` header on the consumer side.
						// NATS JetStream stores `x-delay` as opaque metadata; the broker
						// does NOT defer delivery on it. We implement consumer-side
						// holding here. createdMs is the message's first-publish timestamp;
						// hold until createdMs + delay. Single-process semantics — for
						// long deferrals, prefer trigger-level `delay` (DeferredRunScheduler).
						const createdMs = info.timestampNanos ? Math.floor(Number(info.timestampNanos) / 1_000_000) : Date.now();
						const waitMs = computeXDelayHoldMs(delay, createdMs, Date.now());
						if (waitMs > 0) {
							await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
						}

						await handler(workerJob);
					} catch (error) {
						console.error(`[NATSWorkerAdapter] Error processing job from ${queue}: ${(error as Error).message}`);
						try {
							// Under at-most-once there's nothing to nak — the broker isn't
							// tracking delivery, so a handler throw must NOT trigger redelivery.
							if (!atMostOnce) msg.nak();
						} catch {
							// Already acked/nacked
						}
					} finally {
						semaphore.release();
					}
				})();
			}
		})();

		console.log(
			`[NATSWorkerAdapter] Processing queue: ${queue} (concurrency=${config.concurrency ?? 1}, retries=${config.retries ?? 3})`,
		);
	}

	/**
	 * Add a job to a worker queue
	 */
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

		const nats = await import("nats");
		const subject = `worker.${queue}`;
		const streamName = this.config.streamName || "blok-worker";

		// Ensure stream has this subject
		await this.ensureStream(streamName, [subject]);

		// Build headers with job metadata
		const hdrs = nats.headers();
		const jobId = opts?.jobId || uuid();
		hdrs.set("x-job-id", jobId);
		hdrs.set("Nats-Msg-Id", jobId); // Deduplication
		if (opts?.priority) hdrs.set("x-priority", String(opts.priority));
		if (opts?.delay) hdrs.set("x-delay", String(opts.delay));
		if (opts?.timeout) hdrs.set("x-timeout", String(opts.timeout));

		// Encode and publish
		const codec = nats.JSONCodec();
		await this.js.publish(subject, codec.encode(data), { headers: hdrs });

		return jobId;
	}

	/**
	 * Stop processing a specific queue
	 */
	async stopProcessing(queue: string): Promise<void> {
		const iter = this.consumeIterators.get(queue);
		if (iter) {
			try {
				iter.stop();
			} catch {
				// Already stopped
			}
			this.consumeIterators.delete(queue);
		}
		this.consumers.delete(queue);
		console.log(`[NATSWorkerAdapter] Stopped processing queue: ${queue}`);
	}

	/**
	 * Check if connected
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Health check
	 */
	async healthCheck(): Promise<boolean> {
		if (!this.connected || !this.nc) return false;
		try {
			const info = this.nc.info;
			return info !== undefined;
		} catch {
			return false;
		}
	}

	/**
	 * Get queue statistics from JetStream consumer info
	 */
	async getQueueStats(queue: string): Promise<WorkerQueueStats> {
		if (!this.connected) {
			return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
		}

		try {
			const streamName = this.config.streamName || "blok-worker";
			const durableName = `blok-worker-${queue}`;

			const info = await this.jsm.consumers.info(streamName, durableName);

			return {
				waiting: info.num_pending ?? 0,
				active: info.num_ack_pending ?? 0,
				completed: info.delivered?.consumer_seq ?? 0,
				failed: info.num_redelivered ?? 0,
				delayed: 0, // NATS doesn't have a native delayed count
			};
		} catch {
			return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
		}
	}

	/**
	 * v0.7 — dead-letter an exhausted message. Publishes the ORIGINAL payload
	 * and headers to the `worker.${deadLetterQueue}` subject so a downstream
	 * consumer can inspect/replay it. Plain core publish (not JetStream): the
	 * DLQ is a notification subject, not part of the workqueue stream, so we
	 * avoid coupling it to stream-subject management. No-op when DLQ is unset.
	 *
	 * ponytail: core publish, not a persisted DLQ stream. Upgrade to a
	 * dedicated DLQ JetStream stream if durable dead-letter storage is needed.
	 */
	private async deadLetter(
		deadLetterQueue: string | undefined,
		data: Uint8Array,
		// biome-ignore lint/suspicious/noExplicitAny: NATS MsgHdrs type is dynamically imported
		headers: any,
	): Promise<void> {
		if (!deadLetterQueue) return;
		try {
			this.nc.publish(`worker.${deadLetterQueue}`, data, headers ? { headers } : undefined);
		} catch (error) {
			console.error(
				`[NATSWorkerAdapter] Failed to dead-letter to worker.${deadLetterQueue}: ${(error as Error).message}`,
			);
		}
	}

	/**
	 * Ensure a JetStream stream exists with the given subjects
	 */
	private async ensureStream(name: string, subjects: string[]): Promise<void> {
		try {
			const info = await this.jsm.streams.info(name);

			// Merge new subjects with existing
			const existingSubjects = info.config.subjects || [];
			const allSubjects = [...new Set([...existingSubjects, ...subjects])];

			if (allSubjects.length !== existingSubjects.length) {
				await this.jsm.streams.update(name, {
					...info.config,
					subjects: allSubjects,
				});
			}
		} catch {
			// Stream doesn't exist, create it
			await this.jsm.streams.add({
				name,
				subjects,
				// biome-ignore lint/suspicious/noExplicitAny: nats JetStream retention policy enum
				retention: "workqueue" as any,
				max_deliver: 4, // default: 3 retries + 1 initial attempt
				// biome-ignore lint/suspicious/noExplicitAny: nats JetStream storage type enum
				storage: "file" as any,
			});
		}
	}
}

/**
 * Simple semaphore for concurrency control
 */
class Semaphore {
	private permits: number;
	private waiting: Array<() => void> = [];

	constructor(permits: number) {
		this.permits = permits;
	}

	async acquire(): Promise<void> {
		if (this.permits > 0) {
			this.permits--;
			return;
		}
		return new Promise<void>((resolve) => {
			this.waiting.push(resolve);
		});
	}

	release(): void {
		const next = this.waiting.shift();
		if (next) {
			next();
		} else {
			this.permits++;
		}
	}
}

export default NATSWorkerAdapter;
