/**
 * @blokjs/trigger-queue
 *
 * Queue-based trigger for Blok workflows.
 * Supports multiple queue providers:
 * - Apache Kafka
 * - RabbitMQ
 * - AWS SQS
 * - Redis/BullMQ
 *
 * @example
 * ```typescript
 * import { QueueTrigger, KafkaAdapter } from "@blokjs/trigger-queue";
 *
 * class MyQueueTrigger extends QueueTrigger {
 *   protected adapter = new KafkaAdapter({
 *     brokers: ["localhost:9092"],
 *     clientId: "my-service",
 *   });
 *
 *   protected nodes = myNodes;
 *   protected workflows = myWorkflows;
 * }
 *
 * const trigger = new MyQueueTrigger();
 * await trigger.listen();
 * ```
 *
 * @example RabbitMQ
 * ```typescript
 * import { QueueTrigger, RabbitMQAdapter } from "@blokjs/trigger-queue";
 *
 * class MyQueueTrigger extends QueueTrigger {
 *   protected adapter = new RabbitMQAdapter({
 *     url: "amqp://localhost",
 *   });
 *   // ...
 * }
 * ```
 *
 * @example AWS SQS
 * ```typescript
 * import { QueueTrigger, SQSAdapter } from "@blokjs/trigger-queue";
 *
 * class MyQueueTrigger extends QueueTrigger {
 *   protected adapter = new SQSAdapter({
 *     region: "us-east-1",
 *   });
 *   // ...
 * }
 * ```
 *
 * @example Redis/BullMQ
 * ```typescript
 * import { QueueTrigger, RedisAdapter } from "@blokjs/trigger-queue";
 *
 * class MyQueueTrigger extends QueueTrigger {
 *   protected adapter = new RedisAdapter({
 *     host: "localhost",
 *     port: 6379,
 *   });
 *   // ...
 * }
 * ```
 */

// Core exports
export {
	QueueTrigger,
	type QueueAdapter,
	type QueueMessage,
} from "./QueueTrigger";

// Adapters
export { KafkaAdapter, type KafkaConfig } from "./adapters/KafkaAdapter";
export { RabbitMQAdapter, type RabbitMQConfig } from "./adapters/RabbitMQAdapter";
export { SQSAdapter, type SQSConfig } from "./adapters/SQSAdapter";
export { RedisAdapter, type RedisConfig } from "./adapters/RedisAdapter";
export { NATSAdapter, type NATSConfig } from "./adapters/NATSAdapter";

// Re-export types from helper for convenience
export type {
	QueueProvider,
	QueueTriggerOpts,
} from "@blokjs/helper";
