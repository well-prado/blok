import { KafkaAdapter, QueueTrigger } from "@blokjs/trigger-queue";
import nodes from "../Nodes";
import workflows from "../Workflows";

/**
 * QueueServer - Concrete Queue trigger implementation
 *
 * This server extends the abstract QueueTrigger and provides:
 * - A specific adapter (Kafka by default, can be changed to RabbitMQ, SQS, or Redis)
 * - Node and workflow registries
 *
 * To change the provider, replace:
 * - KafkaAdapter with RabbitMQAdapter, SQSAdapter, or RedisAdapter
 * - Update the adapter configuration accordingly
 *
 * @example RabbitMQ
 * ```typescript
 * import { RabbitMQAdapter } from "@blokjs/trigger-queue";
 * protected adapter = new RabbitMQAdapter({
 *   url: process.env.RABBITMQ_URL || "amqp://localhost",
 * });
 * ```
 *
 * @example AWS SQS
 * ```typescript
 * import { SQSAdapter } from "@blokjs/trigger-queue";
 * protected adapter = new SQSAdapter({
 *   region: process.env.AWS_REGION || "us-east-1",
 * });
 * ```
 *
 * @example Redis/BullMQ
 * ```typescript
 * import { RedisAdapter } from "@blokjs/trigger-queue";
 * protected adapter = new RedisAdapter({
 *   host: process.env.REDIS_HOST || "localhost",
 *   port: Number(process.env.REDIS_PORT) || 6379,
 * });
 * ```
 */
export default class QueueServer extends QueueTrigger {
	protected adapter = new KafkaAdapter({
		brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
		clientId: process.env.KAFKA_CLIENT_ID || "blok-queue-trigger",
	});

	protected nodes: Record<string, import("@blokjs/runner").BlokService<unknown>> = nodes;
	protected workflows: Record<string, import("@blokjs/helper").HelperResponse> = workflows;
}
