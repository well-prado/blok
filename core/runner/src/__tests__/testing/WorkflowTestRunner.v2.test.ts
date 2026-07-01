/**
 * Proves the WorkflowTestRunner v2 path runs REAL control flow.
 *
 * Before this, WorkflowTestRunner had its own toy sequential executor that only
 * understood `{ name, node }` steps and chained via `ctx.response.data` — it had
 * ZERO handling of flow constructs (branch/forEach/switchOn/tryCatch) or the
 * `ctx.state[<id>]` persistence model, so it could never faithfully test the
 * handle-DSL feature surface.
 *
 * Now, when a real v2 workflow is loaded (steps using `use`/`type`, or a flow
 * construct), execute() delegates to the REAL Configuration + Runner — the same
 * engine production uses. This test loads a branch workflow (the exact lowered
 * IR the @blokjs/core `branch()` builder emits) and asserts the real ctx.state:
 * the taken arm persists, the untaken arm is absent.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineNode } from "../../defineNode";
import { WorkflowTestRunner } from "../../testing/WorkflowTestRunner";

// Inline mirror of @blokjs/if-else (same shape order-intake.test.ts uses): a
// flow node that evals each `when` and returns the matching arm's steps.
const ifElse = defineNode({
	name: "@blokjs/if-else",
	description: "test-local mirror of the if-else flow node",
	flow: true,
	input: z.array(z.object({ type: z.enum(["if", "else"]), condition: z.string().optional(), steps: z.array(z.any()) })),
	output: z.array(z.any()),
	execute: (ctx, conditions) => {
		for (const c of conditions) {
			if (c.condition && c.condition.trim() !== "") {
				if (Function("ctx", `"use strict";return (${c.condition});`)(ctx as unknown)) return c.steps as never[];
			} else {
				return c.steps as never[];
			}
		}
		return [] as never[];
	},
});

const echo = defineNode({
	name: "echo",
	description: "returns its input unchanged",
	input: z.object({}).passthrough(),
	output: z.object({}).passthrough(),
	execute: async (_ctx, input) => input,
});

const route = defineNode({
	name: "route",
	description: "returns { lane }",
	input: z.object({ lane: z.string() }),
	output: z.object({ lane: z.string() }),
	execute: async (_ctx, input) => ({ lane: input.lane }),
});

function makeRunner(): WorkflowTestRunner {
	const runner = new WorkflowTestRunner();
	runner.registerNode("echo", echo);
	runner.registerNode("route", route);
	runner.registerNode("@blokjs/if-else", ifElse);
	return runner;
}

// The exact lowered IR the @blokjs/core `branch()` builder emits.
const branchWorkflow = {
	schemaVersion: "2",
	name: "wtr-v2-branch",
	version: "1.0.0",
	trigger: { http: { method: "POST", path: "/x" } },
	steps: [
		{ id: "seed", use: "echo", inputs: { qty: { $ref: { step: "@trigger", path: ["body", "qty"] } } } },
		{
			id: "lane",
			branch: {
				when: "ctx.state.seed.qty > 10",
				then: [{ id: "bulk", use: "route", inputs: { lane: "bulk" } }],
				else: [{ id: "standard", use: "route", inputs: { lane: "standard" } }],
			},
		},
	],
};

describe("WorkflowTestRunner — real v2 control flow", () => {
	it("takes the THEN arm and persists real ctx.state (untaken arm absent) for qty > 10", async () => {
		const runner = makeRunner();
		runner.loadWorkflow(branchWorkflow);

		const result = await runner.execute({ qty: 25 });

		expect(result.success).toBe(true);
		// Real ctx.state keyed by step id — proves the engine (not the toy
		// executor) ran and persisted through the v2 persistence model.
		expect(result.state?.seed).toEqual({ qty: 25 });
		expect(result.state?.bulk).toEqual({ lane: "bulk" });
		// The untaken else arm never ran → no state slot. This is the exact
		// control-flow signal the toy executor could never produce.
		expect(result.state?.standard).toBeUndefined();
	});

	it("takes the ELSE arm for qty <= 10", async () => {
		const runner = makeRunner();
		runner.loadWorkflow(branchWorkflow);

		const result = await runner.execute({ qty: 3 });

		expect(result.success).toBe(true);
		expect(result.state?.seed).toEqual({ qty: 3 });
		expect(result.state?.standard).toEqual({ lane: "standard" });
		expect(result.state?.bulk).toBeUndefined();
	});

	it("exposes a DSL builder's _config directly (loadWorkflow unwraps it)", async () => {
		const runner = makeRunner();
		// Simulate a @blokjs/core builder: an object carrying its lowered IR on _config.
		runner.loadWorkflow({ _blokV2: true, _config: branchWorkflow });

		const result = await runner.execute({ qty: 25 });
		expect(result.state?.bulk).toEqual({ lane: "bulk" });
		expect(result.state?.standard).toBeUndefined();
	});
});
