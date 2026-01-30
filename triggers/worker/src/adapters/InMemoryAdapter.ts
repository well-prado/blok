/**
 * InMemoryAdapter - Worker adapter using in-process queues
 *
 * Ideal for:
 * - Development and testing
 * - Simple background job processing
 * - Single-instance deployments
 *
 * Limitations:
 * - Jobs are lost on process restart
 * - No distributed processing
 * - No persistence
 *
 * @example
 * ```typescript
 * const adapter = new InMemoryAdapter();
 * ```
 */

import type { WorkerTriggerOpts } from "@nanoservice-ts/helper";
import { v4 as uuid } from "uuid";
import type { WorkerAdapter, WorkerJob, WorkerQueueStats } from "../WorkerTrigger";

/**
 * Internal job representation
 */
interface InternalJob {
	id: string;
	data: unknown;
	queue: string;
	priority: number;
	attempts: number;
	maxRetries: number;
	createdAt: Date;
	delay: number;
	timeout: number;
	status: "waiting" | "active" | "completed" | "failed" | "delayed";
	scheduledAt?: Date;
	error?: Error;
}

/**
 * Queue processor entry
 */
interface QueueProcessor {
	config: WorkerTriggerOpts;
	handler: (job: WorkerJob) => Promise<void>;
	active: number;
	running: boolean;
	timer?: ReturnType<typeof setInterval>;
}

/**
 * InMemoryAdapter - Simple in-process worker queue
 */
export class InMemoryAdapter implements WorkerAdapter {
	readonly provider = "in-memory" as const;
	private connected = false;
	private jobs: Map<string, InternalJob[]> = new Map();
	private processors: Map<string, QueueProcessor> = new Map();
	private stats: Map<string, { completed: number; failed: number }> = new Map();

	async connect(): Promise<void> {
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		// Stop all processors
		for (const [queue, processor] of this.processors) {
			processor.running = false;
			if (processor.timer) {
				clearInterval(processor.timer);
			}
		}
		this.processors.clear();
		this.jobs.clear();
		this.stats.clear();
		this.connected = false;
	}

	async process(config: WorkerTriggerOpts, handler: (job: WorkerJob) => Promise<void>): Promise<void> {
		if (!this.connected) {
			throw new Error("Not connected. Call connect() first.");
		}

		if (!this.jobs.has(config.queue)) {
			this.jobs.set(config.queue, []);
		}
		if (!this.stats.has(config.queue)) {
			this.stats.set(config.queue, { completed: 0, failed: 0 });
		}

		const processor: QueueProcessor = {
			config,
			handler,
			active: 0,
			running: true,
		};

		this.processors.set(config.queue, processor);

		// Start polling for jobs
		processor.timer = setInterval(() => {
			this.processNext(config.queue).catch((err) => {
				console.error(`[InMemoryAdapter] Error processing ${config.queue}: ${(err as Error).message}`);
			});
		}, 50); // Poll every 50ms
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

		if (!this.jobs.has(queue)) {
			this.jobs.set(queue, []);
		}
		if (!this.stats.has(queue)) {
			this.stats.set(queue, { completed: 0, failed: 0 });
		}

		const job: InternalJob = {
			id: opts?.jobId || uuid(),
			data,
			queue,
			priority: opts?.priority ?? 0,
			attempts: 0,
			maxRetries: opts?.retries ?? 3,
			createdAt: new Date(),
			delay: opts?.delay ?? 0,
			timeout: opts?.timeout ?? 0,
			status: opts?.delay && opts.delay > 0 ? "delayed" : "waiting",
		};

		if (job.status === "delayed") {
			job.scheduledAt = new Date(Date.now() + job.delay);
		}

		const jobs = this.jobs.get(queue)!;

		// Insert sorted by priority (higher first)
		const insertIdx = jobs.findIndex((j) => j.status === "waiting" && j.priority < job.priority);
		if (insertIdx >= 0) {
			jobs.splice(insertIdx, 0, job);
		} else {
			jobs.push(job);
		}

		return job.id;
	}

	async stopProcessing(queue: string): Promise<void> {
		const processor = this.processors.get(queue);
		if (processor) {
			processor.running = false;
			if (processor.timer) {
				clearInterval(processor.timer);
			}
			this.processors.delete(queue);
		}
	}

	isConnected(): boolean {
		return this.connected;
	}

	async healthCheck(): Promise<boolean> {
		return this.connected;
	}

	async getQueueStats(queue: string): Promise<WorkerQueueStats> {
		const jobs = this.jobs.get(queue) || [];
		const queueStats = this.stats.get(queue) || { completed: 0, failed: 0 };

		return {
			waiting: jobs.filter((j) => j.status === "waiting").length,
			active: jobs.filter((j) => j.status === "active").length,
			completed: queueStats.completed,
			failed: queueStats.failed,
			delayed: jobs.filter((j) => j.status === "delayed").length,
		};
	}

	/**
	 * Process the next available job from a queue
	 */
	private async processNext(queue: string): Promise<void> {
		const processor = this.processors.get(queue);
		if (!processor || !processor.running) return;

		const concurrency = processor.config.concurrency ?? 1;
		if (processor.active >= concurrency) return;

		const jobs = this.jobs.get(queue);
		if (!jobs || jobs.length === 0) return;

		// Check for delayed jobs that are ready
		const now = Date.now();
		for (const job of jobs) {
			if (job.status === "delayed" && job.scheduledAt && job.scheduledAt.getTime() <= now) {
				job.status = "waiting";
			}
		}

		// Find next waiting job
		const jobIdx = jobs.findIndex((j) => j.status === "waiting");
		if (jobIdx < 0) return;

		const internalJob = jobs[jobIdx];
		internalJob.status = "active";
		processor.active++;

		const workerJob: WorkerJob = {
			id: internalJob.id,
			data: internalJob.data,
			headers: {},
			queue: internalJob.queue,
			priority: internalJob.priority,
			attempts: internalJob.attempts,
			maxRetries: internalJob.maxRetries,
			createdAt: internalJob.createdAt,
			delay: internalJob.delay,
			timeout: internalJob.timeout,
			raw: internalJob,
			complete: async () => {
				internalJob.status = "completed";
				const idx = jobs.indexOf(internalJob);
				if (idx >= 0) jobs.splice(idx, 1);
				const s = this.stats.get(queue);
				if (s) s.completed++;
			},
			fail: async (error: Error, requeue?: boolean) => {
				internalJob.attempts++;
				internalJob.error = error;

				if (requeue && internalJob.attempts < internalJob.maxRetries) {
					// Requeue with backoff
					const backoff = Math.min(1000 * Math.pow(2, internalJob.attempts), 30000);
					internalJob.status = "delayed";
					internalJob.scheduledAt = new Date(Date.now() + backoff);
				} else {
					internalJob.status = "failed";
					const idx = jobs.indexOf(internalJob);
					if (idx >= 0) jobs.splice(idx, 1);
					const s = this.stats.get(queue);
					if (s) s.failed++;
				}
			},
		};

		try {
			await processor.handler(workerJob);
		} catch {
			// Handler threw - treat as failure
			if (internalJob.status === "active") {
				internalJob.status = "failed";
				const idx = jobs.indexOf(internalJob);
				if (idx >= 0) jobs.splice(idx, 1);
				const s = this.stats.get(queue);
				if (s) s.failed++;
			}
		} finally {
			processor.active--;
		}
	}
}
