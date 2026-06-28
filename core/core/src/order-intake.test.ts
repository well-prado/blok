import { Configuration, Runner, defineNode } from "@blokjs/runner";
/**
 * End-to-end proof that a workflow authored ENTIRELY via @blokjs/core runs
 * through the REAL Blok engine.
 *
 * The example (../examples/order-intake.ts) uses ONLY @blokjs/core imports
 * (workflow/step/branch/http/tpl/gt/defineNode). Here we:
 *   1. take the builder it default-exports,
 *   2. boot it through the real Configuration (normalize + lowerRefs compiles
 *      the `{$ref}`/`{$tpl}` sentinels to `js/ctx.state...` expressions),
 *   3. run it through the real Runner (which fires the Mapper + persistence +
 *      executes the nodes' execute() functions),
 *   4. assert the chained ctx.state.
 *
 * The branch arm runs through a faithful inline mirror of @blokjs/if-else
 * (importing the published node would pull a heavier node package into this
 * thin barrel's test graph; the mirror is the same shape branch.test.ts uses).
 */
import type { Context, NodeBase } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import orderIntake, { route, summarize, validateOrder } from "../examples/order-intake";

// GlobalOptions/RunnerNode are internal runner shapes; this e2e test only needs `getNode`.
type AnyNode = any;

/** Inline mirror of @blokjs/if-else (evals each `when` via raw Function, returns the matching arm). */
const ifElse = defineNode({
	name: "@blokjs/if-else",
	description: "test-local mirror of the if-else flow node",
	flow: true,
	input: z.array(z.object({ type: z.enum(["if", "else"]), condition: z.string().optional(), steps: z.array(z.any()) })),
	output: z.array(z.any()),
	execute: (ctx, conditions) => {
		for (const c of conditions) {
			if (c.condition && c.condition.trim() !== "") {
				if (Function("ctx", `"use strict";return (${c.condition});`)(ctx)) return c.steps as never[];
			} else {
				return c.steps as never[];
			}
		}
		return [] as never[];
	},
});

async function bootAndRun(qty: number): Promise<Record<string, unknown>> {
	const config = new Configuration();
	const helpers: Record<string, AnyNode> = {
		"validate-order": validateOrder as AnyNode,
		"summarize-order": summarize as AnyNode,
		"route-order": route as AnyNode,
		"@blokjs/if-else": ifElse as AnyNode,
	};
	const globalOptions = {
		nodes: { getNode: (name: string): AnyNode | null => helpers[name] ?? null },
	} as AnyNode;

	// The callback `workflow()` is async, so the default export is a Promise;
	// await it to get the builder, then hand its lowered v2 IR to the engine.
	const wf = await orderIntake;
	await config.init("order-intake", globalOptions, (wf as AnyNode)._config);

	const state: Record<string, unknown> = {};
	const ctx = {
		id: "req",
		workflow_name: "order-intake",
		workflow_path: "/orders",
		request: { body: { qty }, headers: {}, params: {}, query: {} },
		response: { data: null, success: true, error: null, contentType: "application/json" },
		error: { message: [] },
		logger: {
			log: () => {},
			logLevel: () => {},
			error: () => {},
			getLogs: () => [],
			getLogsAsText: () => "",
			getLogsAsBase64: () => "",
		},
		config: config.nodes,
		vars: state,
		state,
		env: {},
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;

	await new Runner(config.steps as NodeBase[]).run(ctx);
	return ctx.state as Record<string, unknown>;
}

describe("@blokjs/core authored workflow runs end-to-end", () => {
	it("chains step outputs, resolves tpl, and takes the bulk arm for qty > 10", async () => {
		const state = await bootAndRun(25);
		// step("validate") output persisted at state.validate
		expect(state.validate).toEqual({ qty: 25, valid: true });
		// tpl`order of ${validate.qty} item(s)` resolved against state.validate.qty
		expect(state.summary).toEqual({ summary: "order of 25 item(s)" });
		// gt(validate.qty, 10) is true → THEN arm
		expect(state.bulk).toEqual({ lane: "bulk" });
		expect(state.standard).toBeUndefined();
	});

	it("takes the standard arm for qty <= 10", async () => {
		const state = await bootAndRun(3);
		expect(state.validate).toEqual({ qty: 3, valid: true });
		expect(state.summary).toEqual({ summary: "order of 3 item(s)" });
		expect(state.standard).toEqual({ lane: "standard" });
		expect(state.bulk).toBeUndefined();
	});
});
