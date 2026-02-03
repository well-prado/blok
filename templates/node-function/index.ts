import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * A simple node that demonstrates the function-first pattern.
 * This node accepts a message and returns a greeting.
 */
export default defineNode({
	name: "node-name",
	description: "A simple node that demonstrates the function-first pattern with Zod validation",

	// Input schema using Zod - automatically validated
	input: z.object({
		message: z.string().optional().default("Hello World"),
	}),

	// Output schema using Zod - automatically validated
	output: z.object({
		message: z.string(),
		timestamp: z.string(),
	}),

	// Execute function - type-safe with inferred types from Zod schemas
	async execute(ctx, input) {
		// Your business logic here
		// - ctx.vars: Access workflow variables
		// - ctx.request: Access HTTP request data
		// - ctx.logger: Log messages
		// - ctx.env: Access environment variables

		// Example: Store data for downstream nodes
		if (!ctx.vars) ctx.vars = {};
		ctx.vars["processed-message"] = { value: input.message };

		// Return type-safe output (validated automatically)
		return {
			message: `Processed: ${input.message}`,
			timestamp: new Date().toISOString(),
		};
	},
});
