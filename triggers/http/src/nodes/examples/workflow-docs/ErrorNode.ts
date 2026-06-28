import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
	name: "error",
	description: "Intentionally throws an error for testing error handling",
	contentType: "text/html",

	input: z.object({
		message: z.string(),
	}),

	output: z.never(),

	async execute(_ctx, input) {
		throw new Error(input.message);
	},
});
