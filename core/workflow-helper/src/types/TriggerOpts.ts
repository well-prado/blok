import { z } from "zod";

// =============================================================================
// Concurrency keys (Tier 2 #6) — shared across HTTP & Worker triggers
// =============================================================================

/**
 * Reusable Zod field bag for per-key concurrency gating.
 *
 * Spread into a trigger's `z.object({...})` and pair with the
 * {@link concurrencyRefinement} cross-field check to add concurrency-key
 * support to a trigger schema.
 *
 * Authors set `concurrencyKey` (literal or `$`-proxy expression) plus an
 * optional `concurrencyLimit` (defaults to 1, matching Trigger.dev's
 * "named mutex per key" pattern). When omitted, the trigger has no
 * concurrency gate (zero-overhead default).
 */
export const ConcurrencyOptsFields = {
	concurrencyKey: z
		.string()
		.min(1)
		.optional()
		.describe(
			"OPTIONAL. Per-key concurrency gating. Literal string or `$.<path>` proxy expression " +
				"evaluated against the live ctx at run-entry time. When set, runs sharing the resolved " +
				"key contend for at most `concurrencyLimit` concurrent slots. When unset, no gating applies.",
		),
	concurrencyLimit: z
		.number()
		.int()
		.min(1)
		.max(10000)
		.optional()
		.describe(
			"OPTIONAL. Maximum concurrent runs for the resolved `concurrencyKey`. " +
				"Defaults to 1 (matches Trigger.dev's named-mutex semantics). " +
				"Ignored when `concurrencyKey` is unset. Bump for throughput-oriented use cases.",
		),
	concurrencyLeaseMs: z
		.number()
		.int()
		.min(1000)
		.optional()
		.describe(
			"OPTIONAL. Lease duration for the concurrency slot in milliseconds. " +
				"Defaults to 3600000 (1h). Tunable per-trigger; process-wide override via " +
				"`BLOK_CONCURRENCY_LEASE_MS`. Crash-safety upper bound on slot leaks.",
		),
} as const;

/**
 * Cross-field refinement: `concurrencyLimit` set without `concurrencyKey`
 * is meaningless and rejected at validation time. Same for `concurrencyLeaseMs`.
 */
export const concurrencyRefinement = (
	val: { concurrencyKey?: string; concurrencyLimit?: number; concurrencyLeaseMs?: number },
	ctx: z.RefinementCtx,
): void => {
	if (val.concurrencyLimit !== undefined && val.concurrencyKey === undefined) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["concurrencyLimit"],
			message: "`concurrencyLimit` requires `concurrencyKey` to be set.",
		});
	}
	if (val.concurrencyLeaseMs !== undefined && val.concurrencyKey === undefined) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["concurrencyLeaseMs"],
			message: "`concurrencyLeaseMs` requires `concurrencyKey` to be set.",
		});
	}
};

/**
 * Standalone schema exposing just the concurrency fields. Useful for tests
 * and tools that want to validate concurrency config in isolation. Real
 * triggers spread {@link ConcurrencyOptsFields} into their own `z.object`
 * and apply {@link concurrencyRefinement}.
 */
export const ConcurrencyOptsSchema = z.object(ConcurrencyOptsFields).superRefine(concurrencyRefinement);

/** Inferred shape of the concurrency-options field bag. */
export type ConcurrencyOpts = z.input<typeof ConcurrencyOptsSchema>;

// =============================================================================
// Scheduling: delay / TTL / debounce (Tier 2 #5 + #7) — shared across HTTP & Worker
// =============================================================================

/**
 * Duration value: a non-negative integer (interpreted as milliseconds) or a
 * single-unit string (`"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"1d"`). Validated
 * at trigger-config parse time; converted to milliseconds at run-entry time
 * by `parseDuration` (`@blokjs/helper`).
 */
const DurationSchema = z.union([
	z.number().int().min(0),
	z
		.string()
		.min(1)
		.regex(/^\d+(ms|s|m|h|d)$/, {
			message: 'Duration must be a non-negative integer + unit (ms|s|m|h|d), e.g. "500ms", "30s", "5m", "2h", "1d".',
		}),
]);

/**
 * Per-key debounce configuration. When set, repeated triggers sharing the
 * resolved `key` collapse into one delayed run. Modes:
 *
 * - `"trailing"` (default): each ping resets a `delay` ms timer; the run
 *   fires after `delay` ms of silence. `maxDelay` (when set) bounds the
 *   tail latency — even with continuous pings, the run fires after
 *   `maxDelay` ms.
 * - `"leading"`: the first ping in a window fires immediately; subsequent
 *   pings within `delay` ms are dropped with status `"debounced"`. Window
 *   resets when `delay` ms of silence pass.
 *
 * `key` is a literal string OR a `js/...` expression that evaluates to a
 * string at run-entry time (typically derived from the request payload via
 * a `$`-proxy expression like `$.req.body.userId`).
 */
export const DebounceOptsSchema = z
	.object({
		key: z
			.string()
			.min(1)
			.describe(
				"Debounce key — literal string or `js/ctx.<path>` expression. Pings sharing the resolved key collapse.",
			),
		mode: z
			.enum(["leading", "trailing"])
			.default("trailing")
			.describe(
				"`trailing` (default) waits for `delay` ms of silence then fires once with the latest payload. " +
					"`leading` fires immediately and suppresses follow-ups within `delay` ms.",
			),
		delay: DurationSchema.describe("Debounce window. Number (ms) or string (`500ms`, `5s`, `2m`, etc.)."),
		maxDelay: DurationSchema.optional().describe(
			"OPTIONAL. Force a fire after this many ms even if pings keep coming. Bounds tail latency. " +
				"Must be >= `delay` when set. Ignored in leading mode.",
		),
	})
	.refine(
		(d) => {
			if (d.maxDelay === undefined) return true;
			// Accept any combo at the schema layer — duration normalization happens at runtime.
			// We DO check the easy numeric case to catch obvious typos early.
			if (typeof d.delay === "number" && typeof d.maxDelay === "number") {
				return d.maxDelay >= d.delay;
			}
			return true;
		},
		{
			message: "`debounce.maxDelay` must be >= `debounce.delay`.",
			path: ["maxDelay"],
		},
	);

/** Inferred type of the {@link DebounceOptsSchema}. */
export type DebounceOpts = z.input<typeof DebounceOptsSchema>;

/**
 * Reusable Zod field bag for run-scheduling primitives. Spread into a
 * trigger's `z.object({...})` and pair with {@link schedulingRefinement}
 * for cross-field validation.
 *
 * - `delay`: defer the run by N (number = ms, or string = `"1h"`).
 * - `ttl`: expire if not started within N. Auto-cancels with status
 *   `"expired"`.
 * - `debounce`: coalesce rapid same-key triggers into one delayed run.
 *
 * Zero-overhead default: when none of these fields are set, the trigger
 * behaves exactly as before.
 */
export const SchedulingOptsFields = {
	delay: DurationSchema.optional().describe(
		"OPTIONAL. Defer the run by this many ms (number) or duration string (`'1h'`, `'30m'`, `'500ms'`). " +
			"When set, the trigger schedules the run for later and returns immediately. " +
			"HTTP returns 202 Accepted with `Location: /__blok/runs/:id`. Worker forwards to the adapter's native delay.",
	),
	ttl: DurationSchema.optional().describe(
		"OPTIONAL. Expire if not started within this many ms (number) or duration string. " +
			"At dispatch time, runs older than `ttl` are skipped with status `'expired'`. " +
			"For HTTP, `ttl` requires `delay` to be set (otherwise immediate-dispatch makes TTL meaningless). " +
			"For Worker, `ttl` is independent of `delay` (queue-time TTL applies regardless).",
	),
	debounce: DebounceOptsSchema.optional().describe(
		"OPTIONAL. Per-key trigger coalescing. See `DebounceOptsSchema` for modes and timing semantics.",
	),
} as const;

/**
 * Cross-field refinement for scheduling fields. Per-trigger callers pass
 * the trigger kind so HTTP and Worker can have different rules for
 * `ttl`-without-`delay`.
 */
export function makeSchedulingRefinement(triggerKind: "http" | "worker") {
	return (
		val: { delay?: number | string; ttl?: number | string; debounce?: DebounceOpts },
		ctx: z.RefinementCtx,
	): void => {
		// HTTP: TTL without delay is meaningless (the request is dispatched
		// immediately). Worker: TTL alone is the queue-time TTL — allowed.
		if (triggerKind === "http" && val.ttl !== undefined && val.delay === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["ttl"],
				message: "HTTP `ttl` requires `delay` to be set (TTL is only meaningful for deferred runs).",
			});
		}
	};
}

/**
 * Standalone schema exposing just the scheduling fields. Useful for tests
 * and tools. Real triggers spread {@link SchedulingOptsFields} into their
 * own `z.object` and apply {@link makeSchedulingRefinement}.
 */
export const SchedulingOptsSchema = z.object(SchedulingOptsFields);

/** Inferred shape of the scheduling-options field bag. */
export type SchedulingOpts = z.input<typeof SchedulingOptsSchema>;

// =============================================================================
// HTTP Trigger
// =============================================================================

/**
 * Canonical HTTP method names.
 *
 * `"ANY"` is the wildcard. Legacy `"*"` (used by old JSON workflows) is
 * accepted via {@link HttpMethodSchema} preprocessing and normalized to
 * `"ANY"` with a one-time deprecation warning.
 */
export const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "ANY"] as const;

let _wildcardWarned = false;
function warnWildcardOnce(): void {
	if (_wildcardWarned) return;
	_wildcardWarned = true;
	console.warn(
		'[blok] trigger.http.method "*" is deprecated; use "ANY" instead. ' +
			"Run `blokctl migrate workflows` to update your workflows.",
	);
}

/**
 * HTTP method schema — accepts the canonical names plus the legacy `"*"`
 * (which is preprocessed to `"ANY"` with a one-time warning).
 */
export const HttpMethodSchema = z.preprocess((val) => {
	if (val === "*") {
		warnWildcardOnce();
		return "ANY";
	}
	return val;
}, z.enum(HTTP_METHODS));

export type HttpMethod = z.infer<typeof HttpMethodSchema>;

/** Validation schema for the HTTP trigger configuration. */
export const HttpTriggerOptsSchema = z
	.object({
		method: HttpMethodSchema.describe(
			"HTTP method this workflow responds to. " +
				"Use 'ANY' to match all methods. The legacy '*' is accepted for back-compat but warns.",
		),
		path: z
			.string()
			.optional()
			.describe(
				"OPTIONAL. When set, this is the FULL URL path (e.g. '/api/users/:id'). " +
					"When omitted, the URL is derived from the workflow file's location " +
					"under the workflows root. Examples: " +
					"workflows/users/list.ts → /users/list; " +
					"workflows/users/[id].ts → /users/:id; " +
					"workflows/users/index.ts → /users.",
			),
		accept: z
			.string()
			.default("application/json")
			.describe("Default response Content-Type when the workflow doesn't set one explicitly."),
		headers: z
			.record(z.string(), z.any())
			.optional()
			.describe("Required headers for incoming requests (validated at trigger entry)."),
		legacyKeyPrefix: z
			.boolean()
			.optional()
			.describe(
				"Opt-in back-compat for the v1 URL scheme `/<workflow-key>/<path>`. " +
					"When true, the workflow is also reachable at the legacy filename-prefixed URL. " +
					"Off (undefined / false) by default. Will be removed after one minor version.",
			),
		...ConcurrencyOptsFields,
		...SchedulingOptsFields,
	})
	.superRefine((val, ctx) => {
		concurrencyRefinement(val, ctx);
		makeSchedulingRefinement("http")(val, ctx);
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

export const WorkerTriggerOptsSchema = z
	.object({
		queue: z.string().describe("Worker queue name"),
		concurrency: z
			.number()
			.default(1)
			.describe(
				"Number of concurrent consumers (parallelism cap). Orthogonal to `concurrencyKey` — " +
					"`concurrency` is the consumer count; `concurrencyKey` is per-key fairness within those consumers.",
			),
		timeout: z.number().optional().describe("Job timeout in milliseconds"),
		retries: z.number().default(3).describe("Number of retry attempts"),
		priority: z.number().default(0).describe("Job priority (higher = more priority)"),
		// `delay` (and `ttl`, `debounce`) live in SchedulingOptsFields below.
		// The legacy number-only `delay` (pre-Tier-2-#5+#7) is superseded by
		// the duration-or-number SchedulingOptsFields.delay. Number values
		// remain accepted for back-compat — only the type widens.
		...ConcurrencyOptsFields,
		...SchedulingOptsFields,
	})
	.superRefine((val, ctx) => {
		concurrencyRefinement(val, ctx);
		makeSchedulingRefinement("worker")(val, ctx);
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
