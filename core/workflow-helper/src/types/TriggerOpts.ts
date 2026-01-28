import { z } from "zod";

// HTTP Trigger Options
export const HttpTriggerOptsSchema = z.object({
	method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "ANY"]),
	path: z.string().optional(),
	accept: z.string().default("application/json"),
	headers: z.record(z.string(), z.any()).optional(),
});

// Legacy alias for backward compatibility
export const TriggerOptsSchema = HttpTriggerOptsSchema;
export type TriggerOpts = z.infer<typeof TriggerOptsSchema>;

// Queue Trigger Options (Kafka, RabbitMQ, SQS, Redis)
export const QueueProviderSchema = z.enum(["kafka", "rabbitmq", "sqs", "redis", "beanstalk"]);
export type QueueProvider = z.infer<typeof QueueProviderSchema>;

export const QueueTriggerOptsSchema = z.object({
	provider: QueueProviderSchema,
	topic: z.string().describe("Topic or queue name to consume from"),
	subscription: z.string().optional().describe("Subscription name (for pub/sub providers)"),
	consumerGroup: z.string().optional().describe("Consumer group ID (for Kafka)"),
	ack: z.boolean().default(true).describe("Whether to acknowledge messages after processing"),
	deadLetterQueue: z.string().optional().describe("Dead letter queue for failed messages"),
	maxRetries: z.number().default(3).describe("Maximum retry attempts before sending to DLQ"),
	retryDelay: z.number().default(1000).describe("Delay between retries in milliseconds"),
	batchSize: z.number().default(1).describe("Number of messages to process in batch"),
	concurrency: z.number().default(1).describe("Number of concurrent consumers"),
});
export type QueueTriggerOpts = z.infer<typeof QueueTriggerOptsSchema>;

// Pub/Sub Trigger Options (GCP Pub/Sub, AWS SNS, Azure Service Bus)
export const PubSubProviderSchema = z.enum(["gcp", "aws", "azure"]);
export type PubSubProvider = z.infer<typeof PubSubProviderSchema>;

export const PubSubTriggerOptsSchema = z.object({
	provider: PubSubProviderSchema,
	topic: z.string().describe("Topic name to subscribe to"),
	subscription: z.string().describe("Subscription name (GCP) or SQS queue URL (AWS) or Service Bus subscription (Azure)"),
	ack: z.boolean().default(true).describe("Whether to acknowledge messages after processing"),
	maxMessages: z.number().default(10).describe("Maximum messages to receive at once"),
	ackDeadline: z.number().default(30).describe("Acknowledgment deadline in seconds"),
	deadLetterTopic: z.string().optional().describe("Dead letter topic for failed messages"),
	filter: z.string().optional().describe("Message filter expression"),
});
export type PubSubTriggerOpts = z.infer<typeof PubSubTriggerOptsSchema>;

// Worker Trigger Options (background jobs)
export const WorkerTriggerOptsSchema = z.object({
	queue: z.string().describe("Worker queue name"),
	concurrency: z.number().default(1).describe("Number of concurrent workers"),
	timeout: z.number().optional().describe("Job timeout in milliseconds"),
	retries: z.number().default(3).describe("Number of retry attempts"),
	priority: z.number().default(0).describe("Job priority (higher = more priority)"),
	delay: z.number().optional().describe("Delay before processing in milliseconds"),
});
export type WorkerTriggerOpts = z.infer<typeof WorkerTriggerOptsSchema>;

// Cron Trigger Options (scheduled workflows)
export const CronTriggerOptsSchema = z.object({
	schedule: z.string().describe("Cron expression (e.g., '0 * * * *' for hourly)"),
	timezone: z.string().default("UTC").describe("Timezone for schedule evaluation"),
	overlap: z.boolean().default(false).describe("Allow overlapping executions"),
});
export type CronTriggerOpts = z.infer<typeof CronTriggerOptsSchema>;

// Webhook Trigger Options (external service events)
export const WebhookTriggerOptsSchema = z.object({
	source: z.string().describe("Source service (github, stripe, shopify, etc.)"),
	events: z.array(z.string()).describe("Event types to listen for"),
	secret: z.string().optional().describe("Webhook secret for verification"),
	path: z.string().optional().describe("Custom webhook path"),
});
export type WebhookTriggerOpts = z.infer<typeof WebhookTriggerOptsSchema>;

// All trigger types
export const TriggersSchema = z.enum([
	"http",
	"grpc",
	"manual",
	"cron",
	"queue",
	"pubsub",
	"worker",
	"webhook",
	"sse",
	"websocket",
]);
export type TriggersEnum = z.infer<typeof TriggersSchema>;
