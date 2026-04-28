import { z } from "zod";

// =============================================================================
// HTTP Trigger
// =============================================================================

/** Validation schema for the HTTP trigger configuration. */
export const HttpTriggerOptsSchema = z.object({
	method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "ANY"]),
	path: z.string().optional(),
	accept: z.string().default("application/json"),
	headers: z.record(z.string(), z.any()).optional(),
});

/** Configuration for an HTTP trigger. Use with `addTrigger("http", ...)`. */
export type HttpTriggerOpts = z.input<typeof HttpTriggerOptsSchema>;

/**
 * Legacy alias for {@link HttpTriggerOptsSchema}. Prefer the explicit name.
 *
 * @deprecated Use {@link HttpTriggerOptsSchema} directly. Will be removed in
 * the next minor version.
 */
export const TriggerOptsSchema = HttpTriggerOptsSchema;

/**
 * Legacy alias for {@link HttpTriggerOpts}. Prefer the explicit name.
 *
 * @deprecated Use {@link HttpTriggerOpts} directly. Will be removed in the
 * next minor version.
 */
export type TriggerOpts = HttpTriggerOpts;

// =============================================================================
// Queue Trigger (Kafka, RabbitMQ, SQS, Redis, NATS, Beanstalk)
// =============================================================================

export const QueueProviderSchema = z.enum(["kafka", "rabbitmq", "sqs", "redis", "beanstalk", "nats"]);
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
export type QueueTriggerOpts = z.input<typeof QueueTriggerOptsSchema>;

// =============================================================================
// Pub/Sub Trigger (GCP Pub/Sub, AWS SNS/SQS, Azure Service Bus)
// =============================================================================

export const PubSubProviderSchema = z.enum(["gcp", "aws", "azure"]);
export type PubSubProvider = z.infer<typeof PubSubProviderSchema>;

export const PubSubTriggerOptsSchema = z.object({
	provider: PubSubProviderSchema,
	topic: z.string().describe("Topic name to subscribe to"),
	subscription: z
		.string()
		.describe("Subscription name (GCP) or SQS queue URL (AWS) or Service Bus subscription (Azure)"),
	ack: z.boolean().default(true).describe("Whether to acknowledge messages after processing"),
	maxMessages: z.number().default(10).describe("Maximum messages to receive at once"),
	ackDeadline: z.number().default(30).describe("Acknowledgment deadline in seconds"),
	deadLetterTopic: z.string().optional().describe("Dead letter topic for failed messages"),
	filter: z.string().optional().describe("Message filter expression"),
});
export type PubSubTriggerOpts = z.input<typeof PubSubTriggerOptsSchema>;

// =============================================================================
// Worker Trigger (background jobs)
// =============================================================================

export const WorkerTriggerOptsSchema = z.object({
	queue: z.string().describe("Worker queue name"),
	concurrency: z.number().default(1).describe("Number of concurrent workers"),
	timeout: z.number().optional().describe("Job timeout in milliseconds"),
	retries: z.number().default(3).describe("Number of retry attempts"),
	priority: z.number().default(0).describe("Job priority (higher = more priority)"),
	delay: z.number().optional().describe("Delay before processing in milliseconds"),
});
export type WorkerTriggerOpts = z.input<typeof WorkerTriggerOptsSchema>;

// =============================================================================
// Cron Trigger (scheduled workflows)
// =============================================================================

export const CronTriggerOptsSchema = z.object({
	schedule: z.string().describe("Cron expression (e.g., '0 * * * *' for hourly)"),
	timezone: z.string().default("UTC").describe("Timezone for schedule evaluation"),
	overlap: z.boolean().default(false).describe("Allow overlapping executions"),
});
export type CronTriggerOpts = z.input<typeof CronTriggerOptsSchema>;

// =============================================================================
// Webhook Trigger (external service events)
// =============================================================================

export const WebhookTriggerOptsSchema = z.object({
	source: z.string().describe("Source service (github, stripe, shopify, etc.)"),
	events: z.array(z.string()).describe("Event types to listen for"),
	secret: z.string().optional().describe("Webhook secret for verification"),
	path: z.string().optional().describe("Custom webhook path"),
});
export type WebhookTriggerOpts = z.input<typeof WebhookTriggerOptsSchema>;

// =============================================================================
// WebSocket Trigger (real-time bidirectional)
// =============================================================================

export const WebSocketTriggerOptsSchema = z.object({
	events: z.array(z.string()).default(["*"]).describe("Event names to listen for (supports wildcards)"),
	rooms: z.array(z.string()).optional().describe("Room/channel filters"),
	path: z.string().optional().describe("WebSocket endpoint path"),
	maxConnections: z.number().default(10000).describe("Maximum concurrent connections"),
	heartbeatInterval: z.number().default(30000).describe("Heartbeat interval in milliseconds"),
	messageRateLimit: z.number().default(100).describe("Max messages per second per client"),
});
export type WebSocketTriggerOpts = z.input<typeof WebSocketTriggerOptsSchema>;

// =============================================================================
// SSE Trigger (Server-Sent Events)
// =============================================================================

export const SSETriggerOptsSchema = z.object({
	events: z.array(z.string()).default(["*"]).describe("Event names to emit"),
	channels: z.array(z.string()).optional().describe("Channel filters"),
	path: z.string().optional().describe("SSE endpoint path"),
	maxConnections: z.number().default(10000).describe("Maximum concurrent connections"),
	heartbeatInterval: z.number().default(30000).describe("Heartbeat interval in milliseconds"),
	retryInterval: z.number().default(3000).describe("Client retry interval in milliseconds"),
});
export type SSETriggerOpts = z.input<typeof SSETriggerOptsSchema>;

// =============================================================================
// Trigger registry (the dispatch table)
// =============================================================================

/** All trigger names supported by Blok. */
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

/**
 * Map of trigger name → its config type.
 *
 * Used by {@link Trigger.addTrigger} overloads to constrain the `config`
 * argument's shape for each trigger kind.
 */
export type TriggerConfigMap = {
	http: HttpTriggerOpts;
	grpc: Record<string, unknown>;
	manual: Record<string, unknown>;
	cron: CronTriggerOpts;
	queue: QueueTriggerOpts;
	pubsub: PubSubTriggerOpts;
	worker: WorkerTriggerOpts;
	webhook: WebhookTriggerOpts;
	sse: SSETriggerOpts;
	websocket: WebSocketTriggerOpts;
};

/**
 * Map of trigger name → validation schema. `null` means the trigger does not
 * have a required configuration shape (currently `grpc` and `manual`).
 *
 * Single source of truth for runtime trigger-config validation. Used by
 * {@link validateTriggerConfig}.
 */
export const TRIGGER_SCHEMAS = {
	http: HttpTriggerOptsSchema,
	queue: QueueTriggerOptsSchema,
	pubsub: PubSubTriggerOptsSchema,
	worker: WorkerTriggerOptsSchema,
	cron: CronTriggerOptsSchema,
	webhook: WebhookTriggerOptsSchema,
	sse: SSETriggerOptsSchema,
	websocket: WebSocketTriggerOptsSchema,
	grpc: null,
	manual: null,
} as const satisfies Record<TriggersEnum, z.ZodTypeAny | null>;

/** Union of every valid trigger configuration (typed). */
export type AnyTriggerOpts =
	| HttpTriggerOpts
	| QueueTriggerOpts
	| PubSubTriggerOpts
	| WorkerTriggerOpts
	| CronTriggerOpts
	| WebhookTriggerOpts
	| WebSocketTriggerOpts
	| SSETriggerOpts
	| Record<string, unknown>;

/**
 * Validate a trigger configuration against the schema for the given trigger
 * kind. When the trigger has a schema, returns the parsed config (with
 * defaults applied). When the trigger has no schema (`grpc`, `manual`),
 * returns the input config (or an empty object when `undefined`).
 *
 * Throws when the trigger requires a schema and the config is missing or
 * invalid. The thrown error is either a `ZodError` (for shape violations) or
 * a regular `Error` (when config is missing entirely).
 *
 * @example
 *   const cfg = validateTriggerConfig("cron", { schedule: "0 * * * *" });
 *   // cfg.timezone === "UTC" (default applied)
 *
 * @example
 *   validateTriggerConfig("cron", undefined);
 *   // throws: 'Trigger "cron" requires a configuration object.'
 */
export function validateTriggerConfig(name: TriggersEnum, config: unknown): unknown {
	const schema = TRIGGER_SCHEMAS[name];
	if (schema === null) {
		// Triggers with no schema accept anything (including undefined).
		return config ?? {};
	}
	if (config === undefined) {
		throw new Error(
			`Trigger "${name}" requires a configuration object. See ${name.charAt(0).toUpperCase()}${name.slice(1)}TriggerOpts.`,
		);
	}
	return schema.parse(config);
}
