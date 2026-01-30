import { defineNode } from "@blok/runner";
import { z } from "zod";

export default defineNode({
	name: "error-node",
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
