import fs from "node:fs";
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
	name: "file-manager",
	description: "Reads file content from a given path",

	input: z.object({
		path: z.string(),
	}),

	output: z.object({
		content: z.string(),
	}),

	async execute(_ctx, input) {
		const content: string = fs.readFileSync(input.path, {
			encoding: "utf8",
			flag: "r",
		});
		return { content };
	},
});
