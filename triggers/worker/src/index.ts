/**
 * @blokjs/trigger-worker
 *
 * Worker-based trigger for Blok workflows.
 * Supports background job processing with:
 * - Configurable concurrency per queue
 * - Automatic retries with exponential backoff
 * - Job timeouts
 * - Priority-based job ordering
 * - Delayed job scheduling
 * - Queue statistics and monitoring
 *
 * Adapters (v0.7+):
 * - BullMQ        — Redis-backed, ops-style queues (`bullmq` peer dep)
 * - InMemory      — development / tests (no peer deps)
 * - NATS          — JetStream durable streams (`nats` peer dep)
 * - Kafka         — high-throughput streaming (`kafkajs` peer dep)
 * - RabbitMQ      — reliable enterprise queues (`amqplib` peer dep)
 * - SQS           — AWS cloud queues (`@aws-sdk/client-sqs` peer dep)
 * - Redis Streams — when Redis is already in stack (`ioredis` peer dep)
 * - pg-boss       — no extra infra (`pg-boss` peer dep)
 *
 * v0.7+ — pick the adapter per workflow via `trigger.worker.provider`.
 * `BLOK_WORKER_ADAPTER` env var sets the default. Subclasses can still
 * set `protected adapter` directly for back-compat with the pre-v0.7
 * single-adapter pattern.
 *
 * @example BullMQ
 * ```typescript
 * import { WorkerTrigger, BullMQAdapter } from "@blokjs/trigger-worker";
 *
 * class MyWorkerTrigger extends WorkerTrigger {
 *   protected adapter = new BullMQAdapter({
 *     host: "localhost",
 *     port: 6379,
 *   });
 *
 *   protected nodes = myNodes;
 *   protected workflows = myWorkflows;
 * }
 *
 * const trigger = new MyWorkerTrigger();
 * await trigger.listen();
 *
 * // Dispatch a job
 * await trigger.dispatch("background-jobs", { userId: "123" }, {
 *   priority: 10,
 *   retries: 3,
 *   delay: 5000, // delay 5 seconds
 * });
 * ```
 *
 * @example InMemory (development)
 * ```typescript
 * import { WorkerTrigger, InMemoryAdapter } from "@blokjs/trigger-worker";
 *
 * class DevWorkerTrigger extends WorkerTrigger {
 *   protected adapter = new InMemoryAdapter();
 *   protected nodes = myNodes;
 *   protected workflows = myWorkflows;
 * }
 * ```
 */

// Core exports
export {
	WorkerTrigger,
	WorkerTimeoutError,
	type WorkerAdapter,
	type WorkerJob,
	type WorkerQueueStats,
} from "./WorkerTrigger";

// Adapters
export { BullMQAdapter, type BullMQConfig } from "./adapters/BullMQAdapter";
export { InMemoryAdapter } from "./adapters/InMemoryAdapter";
export { KafkaAdapter, type KafkaConfig } from "./adapters/KafkaAdapter";
export { NATSWorkerAdapter, type NATSWorkerConfig } from "./adapters/NATSAdapter";
export { PgBossAdapter, type PgBossConfig } from "./adapters/PgBossAdapter";
export { RabbitMQAdapter, type RabbitMQConfig } from "./adapters/RabbitMQAdapter";
export { RedisStreamsAdapter, type RedisStreamsConfig } from "./adapters/RedisStreamsAdapter";
export { SQSAdapter, type SQSConfig } from "./adapters/SQSAdapter";

// v0.7 PR 5 — factory + pool. Used by WorkerTrigger and exposed for
// helper nodes (`@blokjs/worker-publish`) that need to enqueue jobs
// from any workflow without bundling all broker SDKs.
export {
	_resetAdapterPoolForTests,
	createWorkerAdapter,
	getOrCreateAdapter,
	resolveProvider,
} from "./adapters/factory";

// Re-export types from helper for convenience
export type { WorkerProvider, WorkerTriggerOpts } from "@blokjs/helper";
