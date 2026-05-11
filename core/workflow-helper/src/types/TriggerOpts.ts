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
	onLimit: z
		.enum(["throw", "queue"])
		.optional()
		.describe(
			"OPTIONAL. Behavior when the concurrency gate denies a run. " +
				"`'throw'` (default): HTTP returns 429 + Retry-After / Worker NACKs with redelivery " +
				"(transient resource state, doesn't count against the workflow's retry budget). " +
				"`'queue'`: defer the run via the in-process scheduler and re-attempt acquisition " +
				"after a 1s delay. Reuses the Tier 2 #5+#7 deferred-dispatch plumbing; HTTP returns " +
				"202 Accepted + Location, Worker ACKs without retry. Requires `concurrencyKey` to be set.",
		),
	// PR 5 B2 — TTL on queued runs.
	concurrencyQueueTimeoutMs: z
		.number()
		.int()
		.min(1000)
		.optional()
		.describe(
			'OPTIONAL. Time-to-live for queued runs in milliseconds. When set AND `onLimit: "queue"`, ' +
				"queued runs that age past this timeout flip to `expired` instead of re-queueing. " +
				'Requires `onLimit: "queue"`. Without this, queued runs retry indefinitely (lease-bounded only).',
		),
	// PR 5 B3 — capped exponential backoff for onLimit:queue re-defer.
	concurrencyQueueRetry: z
		.object({
			minBackoffMs: z.number().int().min(0).optional().describe("Initial backoff (default 1000)."),
			maxBackoffMs: z.number().int().min(0).optional().describe("Cap on the backoff between retries (default 30000)."),
			factor: z.number().min(1).optional().describe("Exponential factor (default 2)."),
		})
		.optional()
		.describe(
			'OPTIONAL. Capped exponential backoff config for `onLimit: "queue"` re-defer. ' +
				"Replaces the fixed 1s retry. delay = min(maxBackoffMs, minBackoffMs * factor^attempt). " +
				'Requires `onLimit: "queue"`.',
		),
} as const;

/**
 * Cross-field refinement: `concurrencyLimit` / `concurrencyLeaseMs` / `onLimit`
 * set without `concurrencyKey` are meaningless and rejected at validation time.
 */
export const concurrencyRefinement = (
	val: {
		concurrencyKey?: string;
		concurrencyLimit?: number;
		concurrencyLeaseMs?: number;
		onLimit?: "throw" | "queue";
		concurrencyQueueTimeoutMs?: number;
		concurrencyQueueRetry?: { minBackoffMs?: number; maxBackoffMs?: number; factor?: number };
	},
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
	if (val.onLimit !== undefined && val.concurrencyKey === undefined) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["onLimit"],
			message: "`onLimit` requires `concurrencyKey` to be set.",
		});
	}
	// PR 5 B2 — concurrencyQueueTimeoutMs requires onLimit: "queue".
	if (val.concurrencyQueueTimeoutMs !== undefined && val.onLimit !== "queue") {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["concurrencyQueueTimeoutMs"],
			message: '`concurrencyQueueTimeoutMs` requires `onLimit: "queue"`.',
		});
	}
	// PR 5 B3 — concurrencyQueueRetry requires onLimit: "queue".
	if (val.concurrencyQueueRetry !== undefined && val.onLimit !== "queue") {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["concurrencyQueueRetry"],
			message: '`concurrencyQueueRetry` requires `onLimit: "queue"`.',
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
/**
 * Duration value: a non-negative integer (ms) or a single-unit string
 * (`"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"1d"`). Reused by Tier 2 #5+#7
 * scheduling fields and the Tier 2 quick-wins `maxDuration` step field.
 */
export const DurationSchema = z.union([
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
		middleware: z
			.array(z.string().min(1))
			.optional()
			.describe(
				"v0.5 — ordered list of middleware workflow names. Each entry is the `name` of a " +
					"workflow with `middleware: true` registered in the same WORKFLOWS_PATH. Middleware " +
					"runs in declared order BEFORE the main workflow's steps, on the SAME ctx so " +
					"state mutations (e.g. `ctx.state.identity` from auth-check) carry forward. " +
					"A middleware can short-circuit by setting `ctx.response` and using a step with " +
					"`stop: true` — the rest of the chain AND the main workflow are skipped, and the " +
					"current ctx.response is returned to the caller. Errors thrown inside middleware " +
					"propagate to the trigger's normal error handler.",
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

/**
 * v0.7 — custom signature scheme for unknown webhook providers.
 *
 * Authors who use a webhook source NOT in the built-in `provider`
 * allowlist (github / stripe / slack / shopify / svix) supply this
 * config; the trigger does HMAC verification using these fields.
 *
 * The `format` template names the layout of the signature payload —
 * `{hex}` is substituted with the hex digest at verify time. Supports
 * common shapes:
 *   - GitHub-style: `sha256={hex}`
 *   - Plain hex:    `{hex}`
 *   - Base64:       `{base64}` (encoded variant)
 *
 * When `timestampHeader` is set, the verifier mixes the header value
 * into the signed string as `{timestamp}.{rawBody}` (Stripe pattern)
 * and rejects deliveries whose timestamp drifted by more than
 * `tolerance` seconds (default 300s / 5min).
 */
export const WebhookCustomSignatureSchema = z.object({
	scheme: z
		.enum(["hmac-sha256", "hmac-sha1", "hmac-sha512"])
		.default("hmac-sha256")
		.describe("HMAC algorithm. SHA-256 is the de facto standard for webhooks."),
	header: z.string().describe("Header name carrying the signature value (e.g. 'X-Acme-Signature')."),
	format: z
		.string()
		.default("{hex}")
		.describe("Layout of the signature payload. `{hex}` and `{base64}` placeholders are substituted with the digest."),
	secretEnv: z.string().describe("Env-var name holding the shared secret. Never inline the secret value."),
	tolerance: z
		.number()
		.int()
		.positive()
		.default(300)
		.describe("Allowed clock skew between webhook origin and this server, in seconds. Used with timestampHeader."),
	timestampHeader: z
		.string()
		.optional()
		.describe(
			"Header name carrying the request timestamp. When set, signature payload becomes `{timestamp}.{rawBody}` and the timestamp is range-checked against `tolerance`.",
		),
});
export type WebhookCustomSignature = z.input<typeof WebhookCustomSignatureSchema>;

/**
 * v0.7 webhook trigger config. See the v0.7 additional-triggers plan
 * for the full design.
 *
 * **`provider`** selects a built-in verifier (GitHub, Stripe, Slack,
 * Shopify, Standard Webhooks via Svix). For unknown providers, omit
 * `provider` and supply `signature` instead.
 *
 * **`namespace`** (combined with a polymorphic `subworkflow` step in
 * the workflow body) lets one trigger workflow dispatch to many
 * per-event handler workflows by name. Example: webhook fires with
 * `body.type === "invoice.paid"` and namespace `"stripe"` resolves
 * to sub-workflow `"stripe.invoice.paid"`.
 *
 * **`secretEnv`** is the env var name to read the shared secret from
 * — the verifier never sees the secret value at config time, and
 * workflow JSON files never contain it.
 *
 * **`events`** (allowlist) skips verifier-validated deliveries that
 * are NOT in the list — returns 200 with `{status: "ignored"}` so
 * the sender doesn't retry. Absent allowlist = accept all events.
 */
export const WebhookTriggerOptsSchema = z.object({
	provider: z
		.enum(["github", "stripe", "slack", "shopify", "svix"])
		.optional()
		.describe(
			"Built-in webhook provider. When set, the trigger uses the provider's signature scheme + event-id field automatically; `signature` is ignored. For unknown providers, omit this and supply `signature`.",
		),
	path: z
		.string()
		.optional()
		.describe(
			"HTTP path the trigger mounts the POST handler on. Defaults to `/webhooks/{provider}` when `provider` is set.",
		),
	events: z
		.array(z.string())
		.optional()
		.describe(
			"Optional allowlist of event types. Deliveries whose event type isn't in the list return 200 (no retry) but don't run the workflow. Provider-specific event identifiers — GitHub: X-GitHub-Event header; Stripe/Svix: body.type field.",
		),
	secretEnv: z
		.string()
		.optional()
		.describe(
			"Env-var name holding the shared secret. Required for `provider` (built-in) or when `signature.secretEnv` is unset. Never inline the secret value.",
		),
	signature: WebhookCustomSignatureSchema.optional().describe(
		"Custom signature scheme for unknown providers. Ignored when `provider` is set.",
	),
	tolerance: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Replay-tolerance window in seconds — Stripe/Svix/custom-with-timestampHeader only. Default 300s. Used to range-check the signed timestamp.",
		),
	idempotencyKey: z
		.string()
		.optional()
		.describe(
			"Replay-protection cache key — typically a mapper expression resolving to the provider's event id (Stripe's `body.id`, GitHub's `X-GitHub-Delivery`, Svix's `webhook-id`). When set, the verified event is recorded in the idempotency cache; subsequent deliveries with the same key return 200 with `{status: 'duplicate', eventId}` and don't run the workflow.",
		),
	namespace: z
		.string()
		.optional()
		.describe(
			"Optional prefix prepended to polymorphic sub-workflow names. Example: `namespace: 'stripe'` + `subworkflow: '$.req.body.type'` resolving to `'invoice.paid'` looks up `'stripe.invoice.paid'`.",
		),
	middleware: z
		.array(z.string())
		.optional()
		.describe("Trigger-level middleware chain (runs after workflow-level middleware, before workflow body)."),
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
