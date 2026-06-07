import { z } from "zod";
import { StepInputsSchema, StepOptsSchema, V2StepSchema } from "./StepOpts";
import { TriggersSchema } from "./TriggerOpts";

/**
 * Validation schema for the workflow envelope (v1 — legacy).
 *
 * Note: `trigger` is intentionally permissive (`unknown` value) at this layer
 * because per-kind validation lives in {@link Trigger.addTrigger} via
 * `validateTriggerConfig`. Tightening it here would force the legacy HTTP
 * shape onto every trigger kind.
 *
 * @deprecated Prefer {@link WorkflowV2Schema}. v1 shapes are still accepted
 * and normalized at workflow load time.
 */
export const WorkflowOptsSchema = z.object({
	name: z
		.string({
			required_error: "Name is required",
			invalid_type_error: "Name must be a string",
		})
		.min(3),
	version: z
		.string({
			required_error: "Version is required",
			invalid_type_error: "Version must be a string",
		})
		.min(5, { message: "Format required x.x.x" }),
	description: z.string().optional(),
	steps: z.array(StepOptsSchema).optional(),
	nodes: z.record(z.string(), StepInputsSchema).optional(),
	trigger: z.record(TriggersSchema, z.unknown()).optional(),
});

export type WorkflowOpts = z.infer<typeof WorkflowOptsSchema>;

// =============================================================================
// V2 — Canonical workflow shape.
// =============================================================================

/**
 * Validation schema for the v2 workflow envelope.
 *
 * Differences from v1:
 * - No top-level `nodes{}` map — `inputs` lives directly on each step.
 * - `steps[]` is required and contains v2 step shapes (id + use + inputs)
 *   OR branch shapes ({ id, branch: { when, then, else } }).
 * - `trigger` is required (workflows must have at least one trigger).
 *
 * Backward compatibility: v1 workflows are converted to v2 at workflow load
 * time by the runner's WorkflowNormalizer.
 *
 * @example
 *   {
 *     name: "World Countries",
 *     version: "1.0.0",
 *     trigger: { http: { method: "GET" } },
 *     steps: [
 *       { id: "fetch", use: "@blokjs/api-call", inputs: { url: "..." } }
 *     ]
 *   }
 */
export const WorkflowV2Schema = z.object({
	name: z.string().min(3).describe("Workflow display name. Min 3 characters. Shown in Studio."),
	version: z
		.string()
		.min(5, { message: "Format required x.x.x" })
		.describe("Semantic version (x.x.x). Used for trace recording and audit."),
	description: z
		.string()
		.optional()
		.describe("What this workflow does. Optional but recommended — surfaces in Studio and CLI."),
	trigger: z
		.record(TriggersSchema, z.unknown())
		.optional()
		.describe(
			"Trigger configuration. Most workflows use { http: { method: 'GET' } }. " +
				"Optional ONLY when `middleware: true` is set — middleware-only workflows " +
				"are invoked from another workflow's `trigger.http.middleware: [...]` array " +
				"and don't have a public route of their own. See TRIGGER_SCHEMAS for per-kind shapes.",
		),
	middleware: z
		.literal(true)
		.optional()
		.describe(
			"v0.5 — when true, this workflow is registered as middleware and is NOT exposed as a " +
				"public HTTP route. It's invoked by another workflow that lists this one's `name` in " +
				"its `trigger.http.middleware: [...]` array. Middleware runs on the parent ctx (state " +
				"mutations carry forward) and can short-circuit by setting `ctx.response` and using a " +
				"step with `stop: true`. Middleware-only workflows MAY omit `trigger`.",
		),
	steps: z.array(V2StepSchema).min(1).describe("Pipeline of steps to execute in order. At least one step required."),
	input: z
		.unknown()
		.optional()
		.describe(
			"Optional Zod schema describing the workflow's input (request body). Consumed by the `mcp` " +
				"trigger to generate each MCP tool's `inputSchema` (via zod-to-json-schema). Not validated or " +
				"serialized by the runner — it's authoring metadata carried on the workflow config.",
		),
	output: z
		.unknown()
		.optional()
		.describe(
			"Optional Zod schema (TS) or JSON Schema (JSON workflows) describing the workflow's OUTPUT — " +
				"the terminal response body. Consumed by the typed `@blokjs/client` to type each call's return " +
				"value, and (when BLOK_VALIDATE_WORKFLOW_OUTPUT=true) validated against the terminal step's " +
				"result. Authoring metadata carried on the workflow config; not serialized by the runner.",
		),
	events: z
		.record(z.unknown())
		.optional()
		.describe(
			"Optional map of SSE event name → Zod schema (TS) or JSON Schema (JSON) for STREAMING workflows. " +
				"Consumed by the typed `@blokjs/client` to type the streaming event union, and by " +
				"`@blokjs/sse-emit-typed` to constrain emitted events. Authoring metadata; not serialized.",
		),
});

export type WorkflowV2 = z.infer<typeof WorkflowV2Schema>;
