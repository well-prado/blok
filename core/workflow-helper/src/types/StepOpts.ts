import { z } from "zod";
import type { ConditionElseOpts } from "../components/AddElse";
import type { ConditionOpts } from "../components/AddIf";

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
	/**
	 * @deprecated v2 default-stores every step's output. Set `ephemeral: true`
	 * to opt out. `set_var: true` is now a no-op (default behaviour);
	 * `set_var: false` is normalized to `ephemeral: true` at load time.
	 */
	set_var: z.boolean().optional(),
	active: z.boolean().optional(),
	stop: z.boolean().optional(),
	stream_logs: z.boolean().optional(),
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
		// Legacy aliases — accepted for v1 → v2 migration but discouraged.
		set_var: z
			.boolean()
			.optional()
			.describe(
				"@deprecated v2 default-stores every step's output. " +
					"`set_var: true` is a no-op; `set_var: false` is normalized to `ephemeral: true`.",
			),
	})
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
	z.object({
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
			.describe("Conditional sub-pipeline."),
		active: z.boolean().optional(),
		stop: z.boolean().optional(),
	}),
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
						"at run time — must match the `name:` field of an HTTP-loaded or " +
						"manually-registered workflow.",
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
		})
		.refine((step) => !(step.as && step.spread), {
			message: "`as` and `spread` are mutually exclusive — pick one.",
			path: ["spread"],
		}),
);

export type V2SubworkflowStep = z.infer<typeof V2SubworkflowStepSchema>;

/**
 * Discriminated v2 step — regular, branch, or sub-workflow.
 *
 * Discriminators (no `kind` field needed):
 * - presence of `branch` → branch step
 * - presence of `subworkflow` → sub-workflow step
 * - otherwise → regular step
 */
export const V2StepSchema: z.ZodType<V2RegularStep | V2BranchStep | V2SubworkflowStep> = z.lazy(() =>
	z.union([V2BranchStepSchema, V2SubworkflowStepSchema, V2RegularStepSchema]),
);

export type V2Step = V2RegularStep | V2BranchStep | V2SubworkflowStep;

/**
 * Type guard — true when the step is a branch.
 */
export function isBranchStep(step: V2Step): step is V2BranchStep {
	return typeof step === "object" && step !== null && "branch" in step;
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
