/**
 * @blok/trigger-worker
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
 * Adapters:
 * - BullMQ (Redis-backed, production)
 * - InMemory (development/testing)
 *
 * @example BullMQ
 * ```typescript
 * import { WorkerTrigger, BullMQAdapter } from "@blok/trigger-worker";
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
 * import { WorkerTrigger, InMemoryAdapter } from "@blok/trigger-worker";
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
	type WorkerAdapter,
	type WorkerJob,
	type WorkerQueueStats,
} from "./WorkerTrigger";

// Adapters
export { BullMQAdapter, type BullMQConfig } from "./adapters/BullMQAdapter";
export { InMemoryAdapter } from "./adapters/InMemoryAdapter";

// Re-export types from helper for convenience
export type { WorkerTriggerOpts } from "@blok/helper";
