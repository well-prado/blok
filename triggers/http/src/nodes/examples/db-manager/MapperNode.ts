import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
	name: "mapper-node",
	description: "Passes through the input model as the output",

	input: z.object({
		model: z.record(z.unknown()),
	}),

	output: z.record(z.unknown()),

	async execute(_ctx, input) {
		return input.model;
	},
});
