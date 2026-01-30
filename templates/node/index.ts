import { defineNode } from "@blok/runner";
import { z } from "zod";

export default defineNode({
	name: "my-node",
	description: "A new Blok node",

	input: z.object({
		message: z.string().optional(),
	}),

	output: z.object({
		message: z.string(),
	}),

	async execute(ctx, input) {
		// Your code here
		return { message: input.message || "Hello World from Node!" };
	},
});
