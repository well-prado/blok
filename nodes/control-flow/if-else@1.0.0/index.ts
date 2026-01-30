/**
 * If-Else Node - Function-First Implementation
 *
 * Control flow node that evaluates conditions and returns the matching branch's steps.
 * Migrated from class-based to function-first pattern using defineNode.
 */

import type { ConditionOpts } from "@nanoservice-ts/helper";
import { type Condition, type NanoService, defineNode } from "@nanoservice-ts/runner";
import type { Context, NodeBase } from "@nanoservice-ts/shared";
import type ParamsDictionary from "@nanoservice-ts/shared/dist/types/ParamsDictionary";
import { z } from "zod";

/**
 * Helper function to evaluate JavaScript expressions in context
 * Replicates NodeBase.runJs() functionality
 */
function runJs(
	str: string,
	ctx: Context,
	data: ParamsDictionary = {},
	func: Record<string, unknown> = {},
	vars: Record<string, unknown> = {},
): unknown {
	return Function("ctx", "data", "func", "vars", `"use strict";return (${str});`)(ctx, data, func, vars);
}

/**
 * Zod schema for a single condition
 */
const conditionSchema = z.object({
	type: z.enum(["if", "else"]),
	condition: z.string().optional(),
	steps: z.array(z.any()), // NodeBase[] - can't properly type this with Zod
});

export default defineNode({
	name: "if-else",
	description: "Evaluates conditions and returns the matching branch's steps for execution",

	// This is a flow control node — the runner uses processFlow() instead of process()
	flow: true,

	// Input: Array of conditions (if, else if, else)
	input: z.array(conditionSchema),

	// Output: Array of NodeBase (steps to execute)
	// Note: This is a special flow control node that returns steps, not a standard response
	output: z.array(z.any()),

	async execute(ctx, inputs) {
		const conditions = inputs;
		let steps: NodeBase[] = [];

		// Validate first condition is "if"
		const firstCondition = conditions[0] as ConditionOpts;
		if (firstCondition.type !== "if") {
			throw new Error("First condition must be an if");
		}

		// Validate last condition is "else" (if there are multiple conditions)
		if (conditions.length > 1) {
			const lastCondition = conditions[conditions.length - 1];
			if (lastCondition.type !== "else") {
				throw new Error("Last condition must be an else");
			}
		}

		// Evaluate conditions in order
		for (let i = 0; i < conditions.length; i++) {
			const condition = conditions[i];

			// If condition has a JavaScript expression, evaluate it
			if (condition.condition !== undefined && condition.condition.trim() !== "") {
				const result = runJs(condition.condition, ctx, ctx.response.data as ParamsDictionary, {}, ctx.vars || {});

				// If condition matches, use these steps and break
				if (result) {
					steps = condition.steps as NodeBase[];
					break;
				}
			} else {
				// No condition (else block) - use these steps and break
				steps = condition.steps as NodeBase[];
				break;
			}
		}

		// Return steps as NodeBase[] (flow control)
		// The runner will recognize this as a flow node and execute the steps
		return steps as unknown as NanoService<Condition[]>[];
	},
});

// For backward compatibility
export type NodeOptions = {
	conditions: Condition[];
};
