import { defineNode } from "@blokjs/runner";
import type { Context } from "@blokjs/shared";
import { z } from "zod";

/**
 * Evaluates a JavaScript expression in context.
 * Standalone version of NodeBase.runJs().
 */
function runJs(
	str: string,
	ctx: Context,
	data: Record<string, unknown> = {},
	func: Record<string, unknown> = {},
	vars: Record<string, unknown> = {},
): unknown {
	return Function("ctx", "data", "func", "vars", `"use strict";return (${str});`)(ctx, data, func, vars);
}

export default defineNode({
	name: "array-map",
	description: "Maps over an array applying a JavaScript expression to each element",

	input: z.object({
		array: z.array(z.record(z.unknown())),
		map: z.string(),
	}),

	output: z.array(z.unknown()),

	async execute(ctx, input) {
		if (!Array.isArray(input.array)) throw new Error("Array is not an array");

		return input.array.map((data) => {
			return runJs(input.map, ctx, data, {}, ctx.vars ?? {});
		});
	},
});
