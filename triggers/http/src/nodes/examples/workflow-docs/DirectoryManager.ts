import fs from "node:fs";
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
	name: "directory-manager",
	description: "Lists files in a directory",

	input: z.object({
		path: z.string(),
	}),

	output: z.object({
		path: z.string(),
		files: z.array(z.string()),
	}),

	async execute(_ctx, input) {
		const files: string[] = fs.readdirSync(input.path);
		return { path: input.path, files };
	},
});
