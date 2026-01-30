import { defineNode } from "@blok/runner";
import type { Context } from "@blok/shared";
import { z } from "zod";

/**
 * ChainInit node — starts a cross-runtime chain test.
 *
 * Initializes the chain data structure with the first entry (nodejs)
 * so downstream nodes in other languages can append to it.
 */
export default defineNode({
	name: "chain-init",
	description: "Initializes a cross-runtime chain test with the first entry (nodejs)",

	input: z.object({}),

	output: z.object({
		chain: z.array(
			z.object({
				language: z.string(),
				order: z.number(),
				timestamp: z.string(),
			}),
		),
		origin: z.string(),
	}),

	async execute(ctx: Context, _input) {
		const entry = {
			language: "nodejs",
			order: 1,
			timestamp: new Date().toISOString(),
		};

		const data = {
			chain: [entry],
			origin: "blok-cross-runtime-test",
		};

		// Store in ctx.vars so downstream nodes can access via ctx.vars['init']
		if (!ctx.vars) {
			(ctx as Record<string, unknown>).vars = {};
		}
		(ctx.vars as Record<string, unknown>).init = data;

		return data;
	},
});
