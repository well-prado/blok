import { createOpenAI } from "@ai-sdk/openai";
import { defineNode } from "@nanoservice-ts/runner";
import { generateText } from "ai";
import { z } from "zod";
import InMemory from "./InMemory";

export default defineNode({
	name: "openai",
	description: "Generates text using OpenAI GPT-4o with optional caching",
	contentType: "text/html",

	input: z.object({
		cache_key: z.string().optional(),
		system: z.array(z.string()).optional(),
		prompt: z.array(z.string()),
	}),

	output: z.any(),

	async execute(_ctx, input) {
		const cache = InMemory.getInstance();
		const cachedValue =
			input.cache_key !== undefined && input.cache_key !== ""
				? cache.get(input.cache_key)
				: undefined;

		if (cachedValue) {
			return cachedValue;
		}

		const openai = createOpenAI({
			compatibility: "strict",
			apiKey: process.env.OPENAI_API_KEY,
		});

		const { text } = await generateText({
			model: openai("gpt-4o"),
			system: input.system?.join(","),
			prompt: input.prompt.join(","),
			temperature: 0.2,
		});

		if (input.cache_key) {
			cache.set(input.cache_key, text);
		}

		return text;
	},
});
