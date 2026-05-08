import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * Force-throw an error inside a step pipeline. Useful for tryCatch
 * default-arm handling (`switch.default: [{ use: "@blokjs/throw", ... }]`)
 * or for explicit short-circuit error paths.
 *
 * The error message + code are surfaced via $.error inside the catching
 * tryCatch.catch arm.
 */
export default defineNode({
	name: "@blokjs/throw",
	description: "Force-throw an error with a custom message and optional code.",
	input: z.object({
		message: z.string().min(1),
		code: z.number().int().optional(),
		name: z.string().optional(),
	}),
	output: z.never(),

	async execute(_ctx, input) {
		const err = new Error(input.message);
		if (input.code !== undefined) (err as Error & { code?: number }).code = input.code;
		if (input.name !== undefined) err.name = input.name;
		throw err;
	},
});
