import { z } from "zod";
import { StepInputsSchema, StepOptsSchema } from "./StepOpts";
import { TriggersSchema } from "./TriggerOpts";

/**
 * Validation schema for the workflow envelope.
 *
 * Note: `trigger` is intentionally permissive (`unknown` value) at this layer
 * because per-kind validation lives in {@link Trigger.addTrigger} via
 * `validateTriggerConfig`. Tightening it here would force the legacy HTTP
 * shape onto every trigger kind.
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
