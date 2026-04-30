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
 * Discriminated v2 step — either a regular step or a branch.
 *
 * The discriminator is the presence of the `branch` key (no kind field needed).
 */
export const V2StepSchema: z.ZodType<V2RegularStep | V2BranchStep> = z.lazy(() =>
	z.union([V2BranchStepSchema, V2RegularStepSchema]),
);

export type V2Step = V2RegularStep | V2BranchStep;

/**
 * Type guard — true when the step is a branch.
 */
export function isBranchStep(step: V2Step): step is V2BranchStep {
	return typeof step === "object" && step !== null && "branch" in step;
}
