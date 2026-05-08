import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * Evaluate a JS expression against the live ctx and return the result.
 *
 * Useful inside loops + branches when you need a small piece of computed
 * state (a counter, a derived field, a boolean test) and don't want to
 * scaffold a whole module node for it.
 *
 * Security note: the expression runs via `new Function()` with `ctx`,
 * `data`, `func`, `vars` in scope — same surface as the runner's
 * blueprint mapper. Don't pass untrusted expression strings.
 */
export default defineNode({
	name: "@blokjs/expr",
	description: "Evaluate a JS expression against the live ctx and return the result.",
	input: z.object({
		expression: z.string().min(1),
	}),
	output: z.unknown(),

	async execute(ctx, input) {
		const data = (ctx.response?.data ?? ctx.request?.body ?? {}) as Record<string, unknown>;
		const vars = (ctx.vars ?? {}) as Record<string, unknown>;
		const func = {} as Record<string, unknown>;
		const fn = new Function("ctx", "data", "func", "vars", `"use strict";return (${input.expression});`);
		return fn(ctx, data, func, vars) as unknown;
	},
});
