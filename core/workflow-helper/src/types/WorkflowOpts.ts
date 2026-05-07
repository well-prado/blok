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
		.describe(
			"Trigger configuration. Most workflows use { http: { method: 'GET' } }. " +
				"See TRIGGER_SCHEMAS for per-kind shapes.",
		),
	steps: z.array(V2StepSchema).min(1).describe("Pipeline of steps to execute in order. At least one step required."),
});

export type WorkflowV2 = z.infer<typeof WorkflowV2Schema>;
