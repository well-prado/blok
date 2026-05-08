import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * Set ctx.state[name] = value. Returns the published `{ name, value }`.
 *
 * v2 default-stores every step's output to ctx.state[step.id], so most
 * authors use that shape and don't need this. Use ctx-publish when you
 * want to publish under a name that isn't the step id, or to publish
 * additional values from inside a flow node's iteration.
 *
 * Companion of ctx.publish() that's available inside node execute() for
 * setting ctx.state explicitly.
 */
export default defineNode({
	name: "@blokjs/ctx-publish",
	description: "Set ctx.state[name] = value.",
	input: z.object({
		name: z.string().min(1),
		value: z.unknown(),
	}),
	output: z.object({
		name: z.string(),
		value: z.unknown(),
	}),

	async execute(ctx, input) {
		const state = (ctx.state ?? {}) as Record<string, unknown>;
		state[input.name] = input.value;
		// Keep ctx.vars in sync (legacy alias of state).
		const vars = (ctx.vars ?? {}) as Record<string, unknown>;
		vars[input.name] = input.value;
		return { name: input.name, value: input.value };
	},
});
