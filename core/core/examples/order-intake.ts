/**
 * The design's headline example, authored ENTIRELY through @blokjs/core.
 *
 * Proves the published surface: `workflow`/`step`/`branch`/`http`/`tpl` + a
 * typed comparator (`gt`) + `defineNode`, all from "@blokjs/core". The
 * accompanying test (../src/order-intake.test.ts) boots the resulting builder
 * through the REAL Configuration + Runner and asserts the chained ctx.state.
 */
import { http, type Handle, type TriggerHandle, branch, defineNode, gt, step, tpl, workflow } from "@blokjs/core";
import { z } from "zod";

/** Validate the incoming order; echoes qty + a flag for the branch to read. */
export const validateOrder = defineNode({
	name: "validate-order",
	description: "Validates an order payload",
	input: z.object({ qty: z.number() }),
	output: z.object({ qty: z.number(), valid: z.boolean() }),
	execute: (_ctx, input) => ({ qty: input.qty, valid: input.qty > 0 }),
});

/** Build a human-readable summary line (exercises `tpl`). */
export const summarize = defineNode({
	name: "summarize-order",
	description: "Renders an order summary line",
	input: z.object({ line: z.string() }),
	output: z.object({ summary: z.string() }),
	execute: (_ctx, input) => ({ summary: input.line }),
});

/** Mark the order for the bulk vs. standard fulfilment lane. */
export const route = defineNode({
	name: "route-order",
	description: "Tags the fulfilment lane",
	input: z.object({ lane: z.string() }),
	output: z.object({ lane: z.string() }),
	execute: (_ctx, input) => ({ lane: input.lane }),
});

export default workflow("order-intake", { version: "1.0.0", trigger: http.post("/orders") }, (req: TriggerHandle) => {
	// ponytail: the trigger payload is typed `unknown` until ADR 0006 wires the
	// per-trigger input type, so the nested read needs one annotation. Drop it
	// once `req` carries the workflow's `input` schema.
	const body = req.body as Handle<{ qty: number }>;
	const validate = step("validate", validateOrder, { qty: body.qty });

	step("summary", summarize, { line: tpl`order of ${validate.qty} item(s)` });

	branch("lane", gt(validate.qty, 10), {
		then: () => {
			step("bulk", route, { lane: "bulk" });
		},
		else: () => {
			step("standard", route, { lane: "standard" });
		},
	});
});
