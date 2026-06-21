import { z } from "zod";
import type { ConditionElseOpts } from "../components/AddElse";
import type { ConditionOpts } from "../components/AddIf";
import { DurationSchema } from "./TriggerOpts";

/**
 * RuntimeKind represents all supported runtime environments.
 *
 * Synced with `@blokjs/runner` `RuntimeKind` type.
 */
export const RuntimeKindSchema = z.enum([
	"nodejs",
	"bun",
	"python3",
	"go",
	"java",
	"rust",
	"php",
	"csharp",
	"ruby",
	"docker",
	"wasm",
]);

export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

/**
 * Node type enum — includes both legacy types and new runtime types.
 */
export const NodeTypeSchema = z.enum([
	"local",
	"module",
	// Legacy runtime types (backward compatible)
	"runtime.python3",
	// New runtime types
	"runtime.nodejs",
	"runtime.bun",
	"runtime.go",
	"runtime.java",
	"runtime.rust",
	"runtime.php",
	"runtime.csharp",
	"runtime.ruby",
	"runtime.docker",
	"runtime.wasm",
]);

export type NodeType = z.infer<typeof NodeTypeSchema>;

// =============================================================================
// V1 — Legacy step shape. Kept for backward compatibility.
// New workflows should use `StepV2Schema` via the `workflow()` factory.
// =============================================================================

/**
 * Validation schema for a single workflow step (v1 — legacy).
 *
 * Mirrors the JSON workflow step shape so the TypeScript DSL produces
 * structurally-identical output to JSON workflows.
 *
 * @deprecated Prefer {@link StepV2Schema}. v1 shapes are still accepted and
 * normalized at workflow load time.
 */
export const StepOptsSchema = z.object({
	name: z
		.string({
			required_error: "Name is required",
			invalid_type_error: "Name must be a string",
		})
		.min(3),
	node: z
		.string({
			required_error: "Node is required",
			invalid_type_error: "Node must be a string",
		})
		.min(5),
	type: NodeTypeSchema,
	inputs: z.object({}).optional(),
	runtime: RuntimeKindSchema.optional(),
	active: z.boolean().optional(),
	stop: z.boolean().optional(),
	stream_logs: z.boolean().optional(),
	streamTo: z.literal("sse").optional(),
	stream: z.boolean().optional(),
});

export type StepOpts = z.infer<typeof StepOptsSchema>;

// It is used globally in the project
export const StepInputsSchema = z.object({}, { message: "Inputs required" });
export type StepInputs = z.infer<typeof StepInputsSchema>;

export const StepConditionSchema = z.object({
	node: StepOptsSchema,
	conditions: z.function().optional(),
});

export interface IConditions {
	conditions: () => ConditionOpts[] | ConditionElseOpts[];
}

export type StepConditionOpts = z.infer<typeof StepConditionSchema>;

// =============================================================================
// V2 — Canonical step shape. LLM- and human-friendly.
// =============================================================================

/**
 * Retry configuration for a v2 step.
 *
 * Wraps `step.process(ctx, step)` in a retry loop with capped exponential
 * backoff. Per-attempt failures emit `NODE_ATTEMPT_FAILED` trace events.
 *
 * Defaults applied by the runner when fields are omitted:
 * - `minTimeoutInMs`: 1000
 * - `maxTimeoutInMs`: 30000
 * - `factor`: 2
 *
 * Shape mirrors Trigger.dev's `retry` config so authors moving between
 * platforms read familiar semantics. No jitter is added — matches
 * Trigger.dev's default.
 */
export const RetryConfigSchema = z
	.object({
		maxAttempts: z
			.number()
			.int()
			.min(1)
			.max(20)
			.describe("Total attempts including the first run. 1 = no retry. Capped at 20."),
		minTimeoutInMs: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe("Initial backoff delay in ms before the second attempt. Default 1000."),
		maxTimeoutInMs: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe("Cap on the backoff delay between attempts. Default 30000."),
		factor: z
			.number()
			.min(1)
			.optional()
			.describe("Exponential backoff factor: delay = min(maxTimeout, minTimeout * factor^(attempt-1)). Default 2."),
	})
	.refine(
		(r) => r.minTimeoutInMs === undefined || r.maxTimeoutInMs === undefined || r.minTimeoutInMs <= r.maxTimeoutInMs,
		{
			message: "`minTimeoutInMs` must be <= `maxTimeoutInMs`.",
			path: ["maxTimeoutInMs"],
		},
	);

export type RetryConfig = z.infer<typeof RetryConfigSchema>;

/**
 * F9 — build an optional `z.never()` field that rejects a trigger-only
 * config field placed on a step.
 *
 * Steps share many field names with the trigger config (`concurrencyKey`,
 * `delay`, `ttl`, `debounce`, …), so an author who means to gate the
 * *trigger* can easily drop the field on a *step*. `.strict()` already
 * rejects unknown keys, but with a generic "Unrecognized key(s)" message.
 * These `.never()` arms surface a feature-specific error that names the
 * field and points to the trigger config — turning a silent no-op into a
 * loud, well-located authoring error (the same philosophy as the wait
 * step's explicit rejections).
 *
 * `.optional()` permits `undefined`, so well-formed steps that simply omit
 * the field pass unchanged.
 */
function triggerOnlyField(field: string) {
	return z
		.never({
			errorMap: () => ({
				message: `\`${field}\` is a trigger-level field, not a step field — move it to the workflow's trigger config (e.g. \`trigger.http.${field}\` / \`trigger.worker.${field}\`).`,
			}),
		})
		.optional();
}

/**
 * V2 regular step — invokes a node with inputs.
 *
 * **Identity**
 * - `id` is the step's stable identifier. Other steps reference this step's
 *   output as `$.state[id]`.
 * - `use` is the node reference (e.g. `@blokjs/api-call`).
 *
 * **Persistence (default-store rule)**
 * Every step's `result.data` is automatically stored in `ctx.state[id]`
 * after execution. This is the 95% case. The four declarative knobs:
 * - `as: "<name>"` — store at `state[name]` instead of `state[id]`.
 * - `spread: true` — shallow-merge keys of `result.data` into `state`
 *   (data-pipeline pattern). Mutually exclusive with `as`.
 * - `ephemeral: true` — skip storage; only `ctx.prev` carries the result
 *   to the next step.
 *
 * @example
 *   { id: "fetch-users", use: "postgres-query", inputs: { sql: "..." } }
 *   // state["fetch-users"] = result.data
 *
 * @example
 *   { id: "step-1", use: "...", as: "users" }
 *   // state.users = result.data
 *
 * @example
 *   { id: "load", use: "fetch-user-and-profile", spread: true }
 *   // result.data = { user, profile } -> state.user + state.profile
 */
export const V2RegularStepSchema = z
	.object({
		id: z
			.string({
				required_error: "Step id is required",
				invalid_type_error: "Step id must be a string",
			})
			.min(1)
			.describe("Stable identifier. Other steps reference this step's output as $.state[id]. Required."),
		use: z
			.string({
				required_error: "Step `use` is required",
				invalid_type_error: "Step `use` must be a string",
			})
			.min(1)
			.describe(
				"Node reference. Examples: '@blokjs/api-call', 'my-custom-node'. " +
					"Type is inferred from this value when `type` is not set.",
			),
		type: NodeTypeSchema.optional().describe(
			"Node type (module/local/runtime.*). When omitted, inferred from `use`: " +
				"runtime.* prefixes are explicit; @blokjs/* and most others default to 'module'.",
		),
		inputs: z
			.record(z.unknown())
			.optional()
			.describe(
				"Inputs passed to the node. May contain $ proxy references " +
					"(e.g. $.state.foo, $.req.body.id) or 'js/...' expressions for runtime evaluation.",
			),
		as: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Alternative name for this step's output in state. " +
					"Defaults to `id`. Useful when the id is implementation-detail-y " +
					"and the output is referenced by a domain term.",
			),
		spread: z
			.boolean()
			.optional()
			.describe(
				"If true, the result.data object's top-level keys are shallow-merged into state. " +
					"Use for multi-output nodes in data-pipeline workflows. " +
					"Mutually exclusive with `as`.",
			),
		ephemeral: z
			.boolean()
			.optional()
			.describe(
				"If true, this step's output is NOT stored in state. " +
					"Only ctx.prev carries it to the immediately next step. " +
					"Use for side-effects (logging, audit, telemetry).",
			),
		runtime: RuntimeKindSchema.optional().describe(
			"Optional runtime hint. Most authors don't need this; the type already encodes it.",
		),
		active: z.boolean().optional().describe("If false, the step is skipped at runtime. Default true."),
		stop: z.boolean().optional().describe("If true, the workflow halts after this step completes. Default false."),
		stream_logs: z
			.boolean()
			.optional()
			.describe("Per-step opt-in for live log streaming. Inherits from BLOK_STREAM_LOGS env when unset."),
		streamTo: z
			.literal("sse")
			.optional()
			.describe(
				"Runtime steps only. When 'sse', the node's live PartialResult data events " +
					"(emitted via the SDK's ctx.emit(...)) are forwarded to the SSE client through " +
					"ctx.stream.writeSSE(...) AS THEY ARRIVE — before the node's terminal result. " +
					"Requires an `sse` trigger; a no-op when ctx.stream is absent. Opt-in; existing " +
					"unary runtime steps are unaffected.",
			),
		stream: z
			.boolean()
			.optional()
			.describe(
				'Shorthand for `streamTo: "sse"`. `stream: true` forwards runtime PartialResult frames to the SSE client.',
			),
		idempotencyKey: z
			.string()
			.min(1)
			.optional()
			.describe(
				"When set, the step's result is cached against the triple " +
					"(workflowName, step.id, idempotencyKey). On a subsequent run with the " +
					"same triple, execution is skipped and the cached result populates state " +
					"through the same persistence rules (ephemeral / spread / as). " +
					"Accepts a literal string or a $ proxy expression that compiles to " +
					"`js/ctx....` (e.g. $.req.body.requestId).",
			),
		idempotencyKeyTTL: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe(
				"Cache lifetime in milliseconds. Defaults to 24h (86_400_000) when omitted. " +
					"Pass 0 to mark a cached result as immediately expired (effectively disables caching).",
			),
		retry: RetryConfigSchema.optional().describe(
			"Retry configuration with capped exponential backoff. " +
				"When omitted, the step runs at most once (no retry) — matches pre-v0.3.x behavior.",
		),
		maxDuration: DurationSchema.optional().describe(
			"OPTIONAL. Per-attempt execution timeout. Number (ms) or duration " +
				"string ('30s', '5m', '500ms'). When the step's `step.process()` " +
				"exceeds this duration, the attempt fails with a StepTimeoutError. " +
				"Pairs with `retry` — each attempt gets its own timeout (total " +
				"budget = maxDuration × maxAttempts). On final-attempt timeout, the " +
				'run auto-flips to `"timedOut"` status (distinct from `"failed"` ' +
				"so SLA dashboards can separate timeouts from logic failures).",
		),
		// F9 — explicit rejection of trigger-only fields that authors plausibly
		// carry over onto a step. `.strict()` below already rejects unknown keys
		// with a generic "Unrecognized key(s)" message; these `.never()` arms
		// produce a feature-specific error that points authors at the trigger
		// config so a misplaced field doesn't silently disable concurrency /
		// scheduling. `.optional()` permits undefined (the normal case).
		concurrencyKey: triggerOnlyField("concurrencyKey"),
		concurrencyLimit: triggerOnlyField("concurrencyLimit"),
		delay: triggerOnlyField("delay"),
		ttl: triggerOnlyField("ttl"),
		debounce: triggerOnlyField("debounce"),
	})
	.strict()
	.refine((step) => !(step.as && step.spread), {
		message: "`as` and `spread` are mutually exclusive — pick one.",
		path: ["spread"],
	});

export type V2RegularStep = z.infer<typeof V2RegularStepSchema>;

/**
 * V2 branch step — `branch({when, then, else})`.
 *
 * Replaces the legacy `addCondition + new AddIf().addStep().build()` pattern.
 * Compiles down to the existing `@blokjs/if-else` flow node at workflow
 * load time, so the runner core needs no change.
 *
 * @example
 *   {
 *     id: "route-by-method",
 *     branch: {
 *       when: '$.req.method === "POST"',
 *       then: [{ id: "create", use: "...", inputs: {...} }],
 *       else: [{ id: "read",   use: "...", inputs: {...} }]
 *     }
 *   }
 */
export const V2BranchStepSchema: z.ZodType<{
	id: string;
	branch: { when: string; then: unknown[]; else?: unknown[] };
	active?: boolean;
	stop?: boolean;
}> = z.lazy(() =>
	z
		.object({
			id: z.string().min(1).describe("Stable identifier for the branch step. Visible in traces."),
			branch: z
				.object({
					when: z
						.string()
						.min(1)
						.describe(
							"JavaScript expression. Truthy → run `then` branch; falsy → run `else` branch. " +
								"$ proxy expressions compile to strings at the call site (e.g. $.req.query.kind === 'true').",
						),
					then: z.array(z.unknown()).describe("Steps to execute when `when` is truthy."),
					else: z.array(z.unknown()).optional().describe("Steps to execute when `when` is falsy. Optional."),
				})
				.strict()
				.describe("Conditional sub-pipeline."),
			active: z.boolean().optional(),
			stop: z.boolean().optional(),
		})
		// F9 — reject unknown top-level keys (typo'd `branch`, misplaced trigger
		// fields) with a clear error instead of silently dropping them.
		.strict(),
);

export type V2BranchStep = z.infer<typeof V2BranchStepSchema>;

/**
 * V2 sub-workflow step — invoke another named workflow inline.
 *
 * The parent step blocks until the child workflow completes (`wait: true`,
 * the default). The child gets its own `ctx`, its own trace run record,
 * and runs through the same `RunnerSteps` machinery as a top-level run.
 * The child's `ctx.response` becomes the parent step's output, so it
 * lands on `state[<id>]` like any other step (mirrors HTTP semantics:
 * sub-workflow looks like a function call).
 *
 * Inputs flow from parent → child as `ctx.request.body` — the child
 * reads them via `$.req.body.<key>` exactly as if it had been
 * HTTP-triggered.
 *
 * **Composition with Tier 1**:
 * - `idempotencyKey` on this step caches the entire sub-workflow's
 *   result. Cache hit = child workflow is NEVER invoked (no side
 *   effects fire on rerun). Documented footgun + headline pattern.
 * - `retry` retries the whole sub-workflow on failure.
 * - Replay re-creates fresh sub-run lineage automatically.
 *
 * @example
 *   {
 *     id: "send-receipt",
 *     subworkflow: "send-receipt-email",
 *     inputs: { user: $.state.user, order: $.state.order },
 *     wait: true,           // default; `wait: false` deferred to a follow-up
 *     idempotencyKey: $.req.body.requestId,
 *   }
 */
export const V2SubworkflowStepSchema: z.ZodType<{
	id: string;
	subworkflow: string;
	inputs?: Record<string, unknown>;
	wait?: boolean;
	as?: string;
	spread?: boolean;
	ephemeral?: boolean;
	active?: boolean;
	stop?: boolean;
	idempotencyKey?: string;
	idempotencyKeyTTL?: number;
	retry?: RetryConfig;
	allowList?: readonly string[];
	/**
	 * G2 (v0.6) — dispatch strategy. `in-process` (default) runs the
	 * child workflow in the same Node process; `http-self` makes an
	 * HTTP self-call to the deployment so multi-process deployments
	 * can isolate child execution. Requires the child to have an HTTP
	 * trigger (`trigger.http.path` set).
	 */
	dispatch?: "in-process" | "http-self";
}> = z.lazy(() =>
	z
		.object({
			id: z
				.string()
				.min(1)
				.describe(
					"Stable identifier. The sub-workflow's output lands on $.state[id] " + "after the child completes. Required.",
				),
			subworkflow: z
				.string()
				.min(1)
				.describe(
					"Name of the workflow to invoke. Looked up in the WorkflowRegistry " +
						'at run time. **Literal names** (`"send-receipt-email"`) are matched ' +
						'directly. **Polymorphic expressions** (`"$.req.body.kind"`, ' +
						'`"js/ctx.req.body.kind"`) resolve against the live ctx at dispatch ' +
						"time — pair with `allowList` to constrain which workflows the " +
						"expression may resolve to.",
				),
			inputs: z
				.record(z.unknown())
				.optional()
				.describe(
					"Inputs passed to the child as `ctx.request.body`. The child reads " +
						"them via `$.req.body.<key>` exactly as if HTTP-triggered. " +
						"May contain $ proxy refs.",
				),
			wait: z
				.boolean()
				.optional()
				.describe(
					"If true (default), parent step blocks until child completes and " +
						"the child's ctx.response becomes the parent step's output. " +
						"If false, dispatch is fire-and-forget — the parent step returns " +
						"immediately with `{runId, workflowName, scheduledAt}` and the " +
						"child runs asynchronously via setImmediate. The child still " +
						"appears in Studio's Sub-runs strip and the parentRunId/parentNodeRunId " +
						"lineage is preserved. Combine with `idempotencyKey` for " +
						"at-most-once dispatch (Trigger.dev / Stripe semantics: the runId " +
						"is cached against the key regardless of child outcome; new key " +
						"needed to retry on failure).",
				),
			as: z
				.string()
				.min(1)
				.optional()
				.describe("Alternative state key (defaults to id). Mutually exclusive with spread."),
			spread: z
				.boolean()
				.optional()
				.describe("Shallow-merge child's response keys into state. Mutually exclusive with as."),
			ephemeral: z
				.boolean()
				.optional()
				.describe("If true, child output is NOT stored in state. Only ctx.prev carries it."),
			active: z.boolean().optional().describe("If false, the step is skipped at runtime. Default true."),
			stop: z.boolean().optional().describe("If true, the workflow halts after this step completes."),
			idempotencyKey: z
				.string()
				.min(1)
				.optional()
				.describe(
					"When set, the sub-workflow's parent step output is cached against " +
						"the triple (parentWorkflow, step.id, key). Cache semantics depend " +
						"on `wait`: with `wait: true` (default), cache HIT means the child " +
						"workflow is NEVER invoked — including any side effects (use with " +
						"care for sub-workflows that send emails, charge cards, etc.). With " +
						"`wait: false`, cache HIT returns the SAME `{runId, workflowName, " +
						"scheduledAt}` for the lifetime of the cache entry — at-most-once " +
						"dispatch deduplication. To retry on child failure, use a new key.",
				),
			idempotencyKeyTTL: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe("Cache lifetime in milliseconds. Defaults to 24h. Pass 0 to immediately expire."),
			retry: RetryConfigSchema.optional().describe(
				"Retry the WHOLE sub-workflow on failure. Each retry creates a fresh " +
					"child run record under the same parent.",
			),
			maxDuration: DurationSchema.optional().describe(
				"OPTIONAL. Per-attempt execution timeout. Caps the synchronous wait for " +
					"`wait: true` sub-workflows. No-op for `wait: false` (parent returns " +
					"immediately; the child's max-duration is the child's concern). Number " +
					"(ms) or duration string. On final-attempt timeout, the run auto-flips " +
					'to `"timedOut"`.',
			),
			allowList: z
				.array(z.string().min(1))
				.optional()
				.describe(
					"Exact-match allow-list for polymorphic dispatch. When the resolved " +
						"workflow name (after any `namespace` prefix is applied) is not in this " +
						"array, the dispatch is rejected at run time with a structured error. " +
						"Strongly recommended when `subworkflow` is an expression (`$.<path>` " +
						"or `js/...`) so a malicious or buggy ctx value can't dispatch arbitrary " +
						"workflows. Ignored for literal names (they don't need the guard).",
				),
			dispatch: z
				.enum(["in-process", "http-self"])
				.optional()
				.describe(
					"G2 (v0.6) — dispatch strategy. `in-process` (default) invokes the " +
						"child workflow in the same Node process — synchronous when `wait: true`, " +
						"`setImmediate`-based when `wait: false`. `http-self` makes an HTTP " +
						"request to the deployment's own base URL (`BLOK_SELF_BASE_URL` env " +
						"var, defaults to `http://localhost:${PORT || 4000}`). Use `http-self` " +
						"when you want each child run to land on a different process in a " +
						"horizontally-scaled deployment, or to fully isolate child execution " +
						"from the parent's call stack. The child must have an HTTP trigger; " +
						"a runtime error is thrown otherwise. Lineage (parentRunId / " +
						"parentNodeRunId) is preserved across the HTTP hop via " +
						"`X-Blok-Parent-Run-Id` / `X-Blok-Parent-Node-Run-Id` headers.",
				),
		})
		// F9 — reject unknown top-level keys (e.g. a misspelled `subworkflow`
		// or a misplaced trigger field) instead of silently dropping them.
		.strict()
		.refine((step) => !(step.as && step.spread), {
			message: "`as` and `spread` are mutually exclusive — pick one.",
			path: ["spread"],
		}),
);

export type V2SubworkflowStep = z.infer<typeof V2SubworkflowStepSchema>;

/**
 * V2 wait step (PR 4 · `wait.for(duration)` / `wait.until(date)`).
 *
 * Pauses workflow execution mid-run for the specified duration (or until
 * the absolute deadline). Composes with the durable scheduler — long
 * waits survive process restart via the existing
 * `scheduled_dispatches` infrastructure (PR 4 P3 adds
 * `last_completed_step_index` so the runner skips past completed
 * pre-wait steps on resume).
 *
 * Author surface:
 * ```ts
 * { id: "wait-3d", wait: { for: "3d" } }
 * { id: "wait-deadline", wait: { until: $.req.body.scheduledAt } }
 * ```
 *
 * Cannot combine with `idempotencyKey` (the wait IS the checkpoint) or
 * `retry` (waits don't fail in a retryable way).
 */
export const V2WaitStepSchema = z
	.object({
		id: z.string().min(1).describe("Stable identifier."),
		wait: z
			.object({
				for: DurationSchema.optional().describe(
					"Wait this long. Mutually exclusive with `until`. " +
						"Number (ms) or duration string (`500ms`, `30s`, `5m`, `2h`, `1d`).",
				),
				until: z
					.union([z.number(), z.string()])
					.optional()
					.describe(
						"Wait until this absolute time. Number is ms-since-epoch; " +
							"string is an ISO date or a $-proxy expression. Mutually exclusive with `for`.",
					),
			})
			.strict(),
		as: z.string().min(1).optional().describe("Alternative state key (defaults to `id`)."),
		ephemeral: z.boolean().optional().describe("If true, no state entry is recorded."),
		active: z.boolean().optional(),
		stop: z.boolean().optional(),
		// PR 1-5 polish + review fix-up — explicit rejection of fields that
		// are meaningless on wait steps. `.strict()` below would reject
		// these as "unrecognized key" with a generic message; `.never()`
		// lets us produce a feature-specific error explaining WHY the
		// field is rejected so authors don't have to guess. `.optional()`
		// permits undefined (the normal case for wait steps that don't
		// pass any of these fields).
		idempotencyKey: z
			.never({
				errorMap: () => ({
					message: "`idempotencyKey` is not supported on wait steps — the wait itself is the checkpoint.",
				}),
			})
			.optional(),
		retry: z
			.never({
				errorMap: () => ({
					message: "`retry` is not supported on wait steps — waits don't fail in a retryable way.",
				}),
			})
			.optional(),
		// Review fix-up — three more rejections the original polish PR
		// missed. All three could appear plausible to an author coming
		// from regular steps; the helpful message saves them a
		// debugging session.
		maxDuration: z
			.never({
				errorMap: () => ({
					message: "`maxDuration` is not supported on wait steps — the wait IS the duration.",
				}),
			})
			.optional(),
		concurrencyKey: z
			.never({
				errorMap: () => ({
					message:
						"`concurrencyKey` is not supported on wait steps — concurrency gating lives on the trigger config, not on per-step waits.",
				}),
			})
			.optional(),
		spread: z
			.never({
				errorMap: () => ({
					message: "`spread` is not supported on wait steps — wait steps produce no data to spread.",
				}),
			})
			.optional(),
	})
	.strict()
	.refine((s) => (s.wait.for !== undefined) !== (s.wait.until !== undefined), {
		message: "`wait.for` and `wait.until` are mutually exclusive — pick one.",
		path: ["wait"],
	});

export type V2WaitStep = z.infer<typeof V2WaitStepSchema>;

/**
 * V2 forEach step — iterate over a collection running a sub-pipeline
 * per item. Sequential (default) or parallel with bounded concurrency.
 *
 * @example
 *   forEach({
 *     id: "process-orders",
 *     in: $.state.orders,
 *     as: "order",
 *     mode: "parallel",
 *     concurrency: 5,
 *     do: [
 *       { id: "charge", use: "stripe-charge", inputs: { amount: $.state.order.total } },
 *     ],
 *   })
 */
export const V2ForEachStepSchema = z.lazy(() =>
	z
		.object({
			id: z.string().min(1).describe("Stable identifier for the forEach step. Visible in traces."),
			forEach: z
				.object({
					in: z
						.unknown()
						.describe("Array source. Literal expression string (`'$.state.items'`) or `$` proxy expression."),
					as: z
						.string()
						.min(1)
						.regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "as must be a valid identifier (letters, digits, underscore)")
						.describe(
							"Per-iteration variable name. Each iteration sets ctx.state[as] = item and ctx.state[as+'Index'] = i.",
						),
					mode: z
						.enum(["sequential", "parallel"])
						.optional()
						.describe(
							"Execution mode. `sequential` (default) awaits each iteration; `parallel` runs with bounded concurrency.",
						),
					concurrency: z
						.number()
						.int()
						.min(1)
						.max(1000)
						.optional()
						.describe("Max concurrent inner pipelines when `mode: 'parallel'`. Default 10."),
					do: z.array(z.unknown()).min(1).describe("Sub-pipeline run for each item."),
				})
				.strict()
				.describe("forEach configuration."),
			active: z.boolean().optional(),
			stop: z.boolean().optional(),
		})
		// F9 — reject unknown top-level keys instead of silently dropping them.
		.strict(),
);

export type V2ForEachStep = z.infer<typeof V2ForEachStepSchema>;

/**
 * V2 loop step — while-loop with hard maxIterations safety cap.
 *
 * @example
 *   loop({
 *     id: "poll",
 *     while: '$.state["check-status"].status !== "done"',
 *     maxIterations: 60,
 *     do: [
 *       { id: "wait-tick", wait: { for: "2s" } },
 *       { id: "check-status", use: "@blokjs/api-call", inputs: { url: $.state.url } },
 *     ],
 *   })
 */
export const V2LoopStepSchema = z.lazy(() =>
	z
		.object({
			id: z.string().min(1).describe("Stable identifier for the loop step. Visible in traces."),
			loop: z
				.object({
					while: z
						.string()
						.min(1)
						.describe("JS expression evaluated against ctx before each iteration. Loop continues while truthy."),
					maxIterations: z
						.number()
						.int()
						.min(1)
						.optional()
						.describe(
							"Hard safety cap on iterations. Default 1000 (override via env BLOK_LOOP_MAX_ITERATIONS). " +
								"Hitting the cap throws LoopMaxIterationsError.",
						),
					do: z.array(z.unknown()).min(1).describe("Sub-pipeline run each iteration."),
				})
				.strict()
				.describe("loop configuration."),
			active: z.boolean().optional(),
			stop: z.boolean().optional(),
		})
		// F9 — reject unknown top-level keys instead of silently dropping them.
		.strict(),
);

export type V2LoopStep = z.infer<typeof V2LoopStepSchema>;

/**
 * V2 switch step — N-way branch keyed on a value. First matching case wins.
 *
 * `on` resolves to a value at run time (literal, `$` proxy expression, or
 * `js/...` string). Each case carries a `when` and a `do` sub-pipeline:
 * - `when` is a literal → match if `on === when`.
 * - `when` is an array  → match if `array.includes(on)` (group related cases).
 * - `default` runs when no case matches. Optional.
 *
 * @example
 *   switchOn({
 *     id: "route-by-tenant",
 *     on: $.req.headers["x-tenant-id"],
 *     cases: [
 *       { when: "acme",   do: [{ id: "x", subworkflow: "acme-process" }] },
 *       { when: ["a","b"], do: [{ id: "y", subworkflow: "shared" }] },
 *     ],
 *     default: [{ id: "respond-403", use: "@blokjs/respond", stop: true,
 *                 inputs: { status: 403, body: { error: "Unknown tenant" } } }],
 *   })
 */
export const V2SwitchStepSchema = z.lazy(() =>
	z
		.object({
			id: z.string().min(1).describe("Stable identifier for the switch step. Visible in traces."),
			switch: z
				.object({
					on: z
						.unknown()
						.describe(
							"Value to match against. Literal, `$` proxy expression, or `js/...` string. " +
								"Resolved by the blueprint mapper before matching.",
						),
					cases: z
						.array(
							z
								.object({
									when: z
										.unknown()
										.describe(
											"Match value. Literal scalar (number/string/boolean) for `on === when` " +
												"matching, or an array for `array.includes(on)` matching.",
										),
									do: z.array(z.unknown()).min(1).describe("Sub-pipeline run when this case matches."),
								})
								.strict(),
						)
						.min(1)
						.describe("Ordered list of cases. First match wins."),
					default: z.array(z.unknown()).optional().describe("Fallback sub-pipeline when no case matches. Optional."),
				})
				.strict()
				.describe("switch configuration."),
			active: z.boolean().optional(),
			stop: z.boolean().optional(),
		})
		// F9 — reject unknown top-level keys instead of silently dropping them.
		.strict(),
);

export type V2SwitchStep = z.infer<typeof V2SwitchStepSchema>;

/**
 * V2 tryCatch step — JS-like exception handling for sub-pipelines.
 *
 * - `try` block runs first.
 * - On error, the `catch` block runs with `ctx.error` populated
 *   (`$.error.message`, `$.error.name`, `$.error.stack`). Errors thrown
 *   inside `catch` propagate to the next outer handler — they DO NOT
 *   re-trigger `catch`.
 * - `finally` (if provided) runs unconditionally after try/catch — on
 *   normal completion, after a caught error, AND after an uncaught
 *   error from inside `catch`. Errors from `finally` propagate.
 *
 * State mutations from any block are visible to subsequent top-level
 * steps (passthrough flow, like switch).
 *
 * @example
 *   tryCatch({
 *     id: "saga",
 *     try: [
 *       { id: "create", use: "user-create", inputs: { email: $.req.body.email } },
 *       { id: "notify", use: "email-send", inputs: { to: $.state.create.email } },
 *     ],
 *     catch: [
 *       { id: "rollback", use: "user-delete",
 *         inputs: { userId: $.state.create.id, reason: $.error.message } },
 *     ],
 *     finally: [
 *       { id: "metric", use: "@blokjs/metrics-emit", inputs: { event: "saga-attempt" } },
 *     ],
 *   })
 */
export const V2TryCatchStepSchema = z.lazy(() =>
	z
		.object({
			id: z.string().min(1).describe("Stable identifier for the tryCatch step. Visible in traces."),
			tryCatch: z
				.object({
					try: z
						.array(z.unknown())
						.min(1)
						.describe("Sub-pipeline run first. If any step throws, control jumps to `catch`."),
					catch: z
						.array(z.unknown())
						.min(1)
						.describe(
							"Sub-pipeline run when `try` throws. Has access to `$.error` " +
								"(message, name, stack). Errors here propagate — they do NOT re-trigger catch.",
						),
					finally: z
						.array(z.unknown())
						.optional()
						.describe(
							"Sub-pipeline run unconditionally after try/catch. Runs even if " +
								"`catch` itself throws. Errors here propagate.",
						),
				})
				.strict()
				.describe("tryCatch configuration."),
			active: z.boolean().optional(),
			stop: z.boolean().optional(),
		})
		// F9 — reject unknown top-level keys instead of silently dropping them.
		.strict(),
);

export type V2TryCatchStep = z.infer<typeof V2TryCatchStepSchema>;

/**
 * F22 — pick the single member schema a step shape should be validated
 * against, using key presence (the same discriminators the `isXStep` guards
 * use). The regular-step schema is the catch-all when no control-flow key is
 * present.
 *
 * Returning ONE schema (instead of a `z.union` that tries every member) is
 * what gives accurate errors: a malformed `branch` step is validated only
 * against the branch schema, so the surfaced message is "branch.when is
 * required" — not a noisy `invalid_union` that also complains `use` is
 * required (a regular-step field unrelated to branches).
 */
function selectV2StepSchema(value: unknown): z.ZodTypeAny {
	if (typeof value !== "object" || value === null) {
		// Not an object — let the regular-step schema produce the canonical
		// "id is required" / "use is required" error.
		return V2RegularStepSchema;
	}
	if ("branch" in value) return V2BranchStepSchema;
	if ("subworkflow" in value) return V2SubworkflowStepSchema;
	if ("wait" in value) return V2WaitStepSchema;
	if ("forEach" in value) return V2ForEachStepSchema;
	if ("loop" in value) return V2LoopStepSchema;
	if ("switch" in value) return V2SwitchStepSchema;
	if ("tryCatch" in value) return V2TryCatchStepSchema;
	return V2RegularStepSchema;
}

/**
 * Discriminated v2 step — regular, branch, sub-workflow, wait, forEach, loop, switch, or tryCatch.
 *
 * Discriminators (no `kind` field needed):
 * - presence of `branch` → branch step
 * - presence of `subworkflow` → sub-workflow step
 * - presence of `wait` (object) → wait step
 * - presence of `forEach` → forEach step (v0.5)
 * - presence of `loop` → loop step (v0.5)
 * - presence of `switch` → switch step (v0.5)
 * - presence of `tryCatch` → tryCatch step (v0.5)
 * - otherwise → regular step
 *
 * **F22**: implemented as a key-presence dispatch rather than a plain
 * `z.union`. A plain union tries every member and, on failure, aggregates an
 * `invalid_union` error spanning all arms — so a malformed control-flow step
 * was reported with a misleading "`use` is required" (the regular-step arm's
 * error) mixed in. Dispatching to exactly one member surfaces that member's
 * error verbatim, which matters most for LLM- and hand-authored raw object
 * literals (the recommended `branch()`/`forEach()`/… helpers already throw a
 * clean error before this schema runs).
 */
export const V2StepSchema: z.ZodType<
	| V2RegularStep
	| V2BranchStep
	| V2SubworkflowStep
	| V2WaitStep
	| V2ForEachStep
	| V2LoopStep
	| V2SwitchStep
	| V2TryCatchStep
> = z.lazy(() =>
	z.unknown().transform((value, ctx) => {
		const schema = selectV2StepSchema(value);
		const parsed = schema.safeParse(value);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				ctx.addIssue(issue);
			}
			return z.NEVER;
		}
		return parsed.data;
	}),
) as z.ZodType<
	| V2RegularStep
	| V2BranchStep
	| V2SubworkflowStep
	| V2WaitStep
	| V2ForEachStep
	| V2LoopStep
	| V2SwitchStep
	| V2TryCatchStep
>;

export type V2Step =
	| V2RegularStep
	| V2BranchStep
	| V2SubworkflowStep
	| V2WaitStep
	| V2ForEachStep
	| V2LoopStep
	| V2SwitchStep
	| V2TryCatchStep;

/**
 * Type guard — true when the step is a branch.
 */
export function isBranchStep(step: V2Step): step is V2BranchStep {
	return typeof step === "object" && step !== null && "branch" in step;
}

/**
 * Type guard — true when the step is a wait (PR 4 `wait.for` / `wait.until`).
 */
export function isWaitStep(step: V2Step): step is V2WaitStep {
	return (
		typeof step === "object" &&
		step !== null &&
		"wait" in step &&
		typeof (step as { wait?: unknown }).wait === "object" &&
		(step as { wait?: unknown }).wait !== null &&
		((step as { wait?: { for?: unknown } }).wait?.for !== undefined ||
			(step as { wait?: { until?: unknown } }).wait?.until !== undefined)
	);
}

/**
 * Type guard — true when the step is a sub-workflow invocation.
 */
export function isSubworkflowStep(step: V2Step): step is V2SubworkflowStep {
	return (
		typeof step === "object" &&
		step !== null &&
		"subworkflow" in step &&
		typeof (step as { subworkflow?: unknown }).subworkflow === "string"
	);
}

/**
 * Type guard — true when the step is a forEach iteration (v0.5).
 */
export function isForEachStep(step: V2Step): step is V2ForEachStep {
	return (
		typeof step === "object" &&
		step !== null &&
		"forEach" in step &&
		typeof (step as { forEach?: unknown }).forEach === "object" &&
		(step as { forEach?: unknown }).forEach !== null
	);
}

/**
 * Type guard — true when the step is a while-loop (v0.5).
 */
export function isLoopStep(step: V2Step): step is V2LoopStep {
	return (
		typeof step === "object" &&
		step !== null &&
		"loop" in step &&
		typeof (step as { loop?: unknown }).loop === "object" &&
		(step as { loop?: unknown }).loop !== null
	);
}

/**
 * Type guard — true when the step is an N-way switch (v0.5).
 */
export function isSwitchStep(step: V2Step): step is V2SwitchStep {
	return (
		typeof step === "object" &&
		step !== null &&
		"switch" in step &&
		typeof (step as { switch?: unknown }).switch === "object" &&
		(step as { switch?: unknown }).switch !== null
	);
}

/**
 * Type guard — true when the step is a tryCatch (v0.5).
 */
export function isTryCatchStep(step: V2Step): step is V2TryCatchStep {
	return (
		typeof step === "object" &&
		step !== null &&
		"tryCatch" in step &&
		typeof (step as { tryCatch?: unknown }).tryCatch === "object" &&
		(step as { tryCatch?: unknown }).tryCatch !== null
	);
}
