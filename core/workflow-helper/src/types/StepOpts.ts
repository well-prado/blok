import { z } from "zod";
import type { ConditionElseOpts } from "../components/AddElse";
import type { ConditionOpts } from "../components/AddIf";

/**
 * RuntimeKind represents all supported runtime environments
 * Synced with @blok/runner RuntimeKind type
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
 * Node type enum - includes both legacy types and new runtime types
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
