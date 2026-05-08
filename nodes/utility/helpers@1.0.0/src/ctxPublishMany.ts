import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * Set multiple ctx.state[k] = v in one step. Returns `{ count }` of keys
 * published.
 *
 * Pairs nicely with @blokjs/expr for computed batches:
 *   { id: "advance", use: "@blokjs/ctx-publish-many", inputs: { values: { lastStatus: $.state.check.status, attempt: $.state.attempt + 1 } } }
 */
export default defineNode({
	name: "@blokjs/ctx-publish-many",
	description: "Set multiple ctx.state[k] = v in one step.",
	input: z.object({
		values: z.record(z.string(), z.unknown()),
	}),
	output: z.object({
		count: z.number(),
	}),

	async execute(ctx, input) {
		const state = (ctx.state ?? {}) as Record<string, unknown>;
		const vars = (ctx.vars ?? {}) as Record<string, unknown>;
		let count = 0;
		for (const [k, v] of Object.entries(input.values)) {
			state[k] = v;
			vars[k] = v;
			count++;
		}
		return { count };
	},
});
