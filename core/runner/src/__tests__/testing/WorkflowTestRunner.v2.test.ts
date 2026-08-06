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

// =============================================================================
// Studio Skip/Stop debug controls (canvas header toggles: `active: false` /
// `stop: true`). WorkflowTestRunner's v2 path (`executeV2`) delegates to the
// REAL `Configuration` + `Runner` → `RunnerSteps.runSteps` — the exact loop
// production runs — so these flags are honored with ZERO changes to
// WorkflowTestRunner itself (VERIFIED here, not assumed): `Runner.run` calls
// `this.runSteps(...)` (RunnerSteps.ts), whose per-step loop checks
// `if (!step.active) { …skip…; continue; }` BEFORE `if (step.stop) break;`
// (see core/runner/CLAUDE.md "Step Execution Flow"). The legacy toy
// executor (`executeSteps`/`executeStep`, used only for `{name, node}`
// steps with no `id`/`use`/`type`) does NOT check either flag — these tests
// use v2-shaped steps (`id`/`use`) specifically to route through the real
// engine, not the toy loop.
// =============================================================================
describe("WorkflowTestRunner — Studio Skip/Stop debug controls (active:false / stop:true)", () => {
	it("skips a step with active:false — flow continues, the skipped step writes no state", async () => {
		const runner = makeRunner();
		runner.loadWorkflow({
			schemaVersion: "2",
			name: "wtr-v2-active-false",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{ id: "a", use: "echo", inputs: { n: 1 } },
				{ id: "b", use: "echo", inputs: { n: 2 }, active: false },
				{ id: "c", use: "echo", inputs: { n: 3 } },
			],
		});

		const result = await runner.execute({});

		expect(result.success).toBe(true);
		expect(result.state?.a).toEqual({ n: 1 });
		expect(result.state?.b).toBeUndefined();
		expect(result.state?.c).toEqual({ n: 3 });
	});

	it("halts the run before a step with stop:true — nothing at or after it runs", async () => {
		const runner = makeRunner();
		runner.loadWorkflow({
			schemaVersion: "2",
			name: "wtr-v2-stop",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{ id: "a", use: "echo", inputs: { n: 1 } },
				{ id: "b", use: "echo", inputs: { n: 2 } },
				{ id: "c", use: "echo", inputs: { n: 3 }, stop: true },
			],
		});

		const result = await runner.execute({});

		// The run completes normally (stop breaks the loop, it does not error).
		expect(result.success).toBe(true);
		expect(result.state?.a).toEqual({ n: 1 });
		expect(result.state?.b).toEqual({ n: 2 });
		expect(result.state?.c).toBeUndefined();
	});
});
