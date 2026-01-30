import { defineNode } from "@blok/runner";
import { z } from "zod";
import createTool from "./tool";
import importEsModule from "./util";

export default defineNode({
	name: "mastra-agent",
	description: "Runs a Mastra AI agent with tool support (requires Bun runtime)",

	input: z.object({
		name: z.string(),
		instructions: z.string(),
		model: z.object({
			provider: z.string(),
			name: z.string(),
		}),
		tools: z.record(z.unknown()).optional(),
		message: z.string(),
	}),

	output: z.object({
		text: z.string(),
	}),

	async execute(_ctx, input) {
		if (!process.versions.bun) {
			throw new Error("This node must be executed with BUN");
		}

		const { Agent } = await importEsModule("@mastra/core");
		const weatherTool = await createTool();

		const agent = new Agent({
			name: input.name,
			instructions: input.instructions,
			model: input.model,
			tools: { weatherTool },
		});

		const result = await agent.generate(input.message);
		return { text: result.text };
	},
});
