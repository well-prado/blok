import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * v0.7 — enqueue a job onto a worker queue from ANY workflow (HTTP,
 * WebSocket, Webhook, Cron, even another Worker). Dispatches through
 * the same adapter factory the `WorkerTrigger` uses, so the
 * `provider` choice (bullmq / kafka / rabbitmq / sqs / redis /
 * pg-boss / nats / in-memory) is uniform between producers and
 * consumers.
 *
 * The adapter pool is shared with the trigger via the factory's
 * process-singleton — a Redis-Streams worker AND a Redis-Streams
 * publisher share one ioredis connection.
 *
 * `provider` resolution: explicit input → `BLOK_WORKER_ADAPTER` env →
 * `"in-memory"`. Matches `WorkerTrigger.resolveAdapterForWorkflow`.
 */
export default defineNode({
	name: "@blokjs/worker-publish",
	description:
		"Enqueue a job onto a worker queue via the same adapter the WorkerTrigger uses. Provider picks the broker; supports bullmq, kafka, rabbitmq, sqs, redis, pg-boss, nats, in-memory.",
	input: z.object({
		provider: z
			.enum(["in-memory", "nats", "bullmq", "kafka", "rabbitmq", "sqs", "redis", "pg-boss"])
			.optional()
			.describe("Adapter to use. Defaults to BLOK_WORKER_ADAPTER env var, then in-memory."),
		queue: z.string().min(1).describe("Queue / topic / stream name. Provider-specific semantics."),
		payload: z.unknown().describe("Job payload. JSON-serialized by the adapter when not a string."),
		priority: z.number().int().optional().describe("Higher numbers run first (BullMQ, RabbitMQ semantics)."),
		delayMs: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe("Delay before the job becomes available, in milliseconds."),
		retries: z.number().int().nonnegative().optional().describe("Per-job retry budget (provider-specific behaviour)."),
		timeoutMs: z.number().int().positive().optional().describe("Hard timeout per job attempt, in milliseconds."),
		dedupId: z
			.string()
			.optional()
			.describe(
				"Provider-specific deduplication id — BullMQ jobId, NATS Nats-Msg-Id, SQS MessageDeduplicationId. When set, duplicate dispatches in the dedup window are dropped silently.",
			),
	}),
	output: z.object({
		jobId: z.string(),
		provider: z.string(),
		queue: z.string(),
	}),
	async execute(_ctx, input) {
		// Lazy import — workflows that never publish don't pay the cost.
		const moduleName = "@blokjs/trigger-worker";
		interface PublishedJob {
			jobId: string;
			provider: string;
			queue: string;
		}
		interface WorkerModule {
			resolveProvider(
				provider?: "in-memory" | "nats" | "bullmq" | "kafka" | "rabbitmq" | "sqs" | "redis" | "pg-boss",
			): "in-memory" | "nats" | "bullmq" | "kafka" | "rabbitmq" | "sqs" | "redis" | "pg-boss";
			getOrCreateAdapter(
				provider: "in-memory" | "nats" | "bullmq" | "kafka" | "rabbitmq" | "sqs" | "redis" | "pg-boss",
			): {
				provider: string;
				connect(): Promise<void>;
				isConnected(): boolean;
				addJob(
					queue: string,
					data: unknown,
					opts?: { priority?: number; delay?: number; retries?: number; timeout?: number; jobId?: string },
				): Promise<string>;
			};
		}
		let mod: WorkerModule;
		try {
			mod = (await import(moduleName)) as WorkerModule;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`@blokjs/worker-publish: cannot load @blokjs/trigger-worker (${msg}). Install it as a dependency of the workflow's runtime.`,
			);
		}
		const provider = mod.resolveProvider(input.provider);
		const adapter = mod.getOrCreateAdapter(provider);
		if (!adapter.isConnected()) {
			await adapter.connect();
		}
		const jobId = await adapter.addJob(input.queue, input.payload, {
			priority: input.priority,
			delay: input.delayMs,
			retries: input.retries,
			timeout: input.timeoutMs,
			jobId: input.dedupId,
		});
		const out: PublishedJob = { jobId, provider, queue: input.queue };
		return out;
	},
});
