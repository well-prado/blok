import { http, branch, defineNode, forEach, gt, step, switchOn, tryCatch, workflow } from "@blokjs/core";
import type { Handle } from "@blokjs/core";
/**
 * Handle-DSL control-flow E2E (issue #601) — branch / forEach / switchOn /
 * tryCatch authored ENTIRELY via @blokjs/core, run through the REAL Blok
 * engine (Configuration + Runner) via the just-fixed WorkflowTestRunner, with
 * assertions on the REAL `ctx.state` the run produces.
 *
 * "Live infra" here is the production flow-node machinery itself — the same
 * ForEachNode / SwitchNode / TryCatchNode + @blokjs/if-else + Mapper +
 * PersistenceHelper (Rule 0) that ship to users. No mocks of the engine; the
 * only registered node beyond the workflow's own is the inline mirror of
 * `@blokjs/if-else` that `branch()` lowers to (importing the published node
 * would pull a heavier package into this thin barrel's test graph — the mirror
 * is the exact shape order-intake.test.ts / branch.test.ts already prove).
 *
 * forEach / switchOn / tryCatch are runner BUILT-INS (Configuration resolves
 * them internally via forEachResolver/switchResolver/tryCatchResolver — see
 * Configuration.getNodes), so they need NO node registration.
 *
 * Gated (opt-out) + namespaced: each workflow name carries a random suffix so a
 * shared trace store never collides across concurrent targets.
 */
import { WorkflowTestRunner } from "@blokjs/core/testing";
import type { Context } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const RUN = !process.env.BLOK_SKIP_DSL_E2E;
const nsName = (base: string): string => `${base}-${Math.random().toString(36).slice(2)}`;

// Inline mirror of @blokjs/if-else — the flow node `branch()` lowers to. Evals
// each `when` via raw Function (bare `ctx.*` string, per ADR 0004), returns the
// matching arm's steps. Identical shape to order-intake.test.ts.
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

/** Echo a lane tag (used by both branch arms and switch cases). */
const tag = defineNode({
	name: "tag",
	description: "echoes a lane/case tag",
	input: z.object({ lane: z.string() }),
	output: z.object({ lane: z.string() }),
	execute: (_ctx: Context, input) => ({ lane: input.lane }),
});

/** Double the per-item value — proves the forEach `as` handle resolves. */
const dbl = defineNode({
	name: "dbl",
	description: "doubles n, echoes the iteration index",
	input: z.object({ n: z.number(), i: z.number() }),
	output: z.object({ doubled: z.number(), at: z.number() }),
	execute: (_ctx: Context, input) => ({ doubled: input.n * 2, at: input.i }),
});

/** Always throws — exercises the tryCatch catch arm + Rule 0. */
const boom = defineNode({
	name: "boom",
	description: "always throws",
	input: z.object({}),
	output: z.object({}),
	execute: () => {
		throw new Error("kaboom");
	},
});

/** Records the caught error's code + stepId (reads $.error via the catch arm). */
const record = defineNode({
	name: "record",
	description: "captures the caught error envelope fields",
	input: z.object({ code: z.number().optional(), stepId: z.string().optional() }),
	output: z.object({ code: z.number().optional(), stepId: z.string().optional() }),
	execute: (_ctx: Context, input) => ({ code: input.code, stepId: input.stepId }),
});

/** A runner wired with the workflow's nodes + the if-else mirror. */
function makeRunner(): WorkflowTestRunner {
	const r = new WorkflowTestRunner();
	r.registerNode("@blokjs/if-else", ifElse);
	r.registerNode("tag", tag);
	r.registerNode("dbl", dbl);
	r.registerNode("boom", boom);
	r.registerNode("record", record);
	return r;
}

describe.skipIf(!RUN)("dsl:control-flow — branch/forEach/switchOn/tryCatch through the real engine", () => {
	it("branch takes the correct arm; the untaken arm's state is undefined", async () => {
		const wf = await workflow(nsName("branch-e2e"), { version: "1.0.0", trigger: http.post("/branch") }, (req) => {
			const n = (req.body as { n: Handle<number> }).n;
			branch("lane", gt(n, 10), {
				then: () => {
					step("bulk", tag, { lane: "bulk" });
				},
				else: () => {
					step("standard", tag, { lane: "standard" });
				},
			});
		});

		const runner = makeRunner();
		runner.loadWorkflow(wf);

		const big = await runner.execute({ n: 25 });
		expect(big.success).toBe(true);
		expect(big.state?.bulk).toEqual({ lane: "bulk" });
		expect(big.state?.standard).toBeUndefined();

		const small = await runner.execute({ n: 3 });
		expect(small.success).toBe(true);
		expect(small.state?.standard).toEqual({ lane: "standard" });
		expect(small.state?.bulk).toBeUndefined();
	});

	it("forEach iterates (sequential) — the `as`/`asIndex` handles resolve per item", async () => {
		const wf = await workflow(nsName("foreach-seq-e2e"), { version: "1.0.0", trigger: http.post("/seq") }, (req) => {
			const nums = (req.body as { nums: Handle<number[]> }).nums;
			forEach(
				nums,
				(item, index) => {
					step("double", dbl, { n: item, i: index });
				},
				{ id: "results", as: "num" },
			);
		});

		const runner = makeRunner();
		runner.loadWorkflow(wf);
		const out = await runner.execute({ nums: [1, 2, 3] });

		expect(out.success).toBe(true);
		// The loop's results array lands at state[id]. Each entry is the inner
		// step's output derived from the `as` item + `asIndex` — proving both
		// per-iteration handles resolved against the child ctx state.
		expect(out.state?.results).toEqual([
			{ doubled: 2, at: 0 },
			{ doubled: 4, at: 1 },
			{ doubled: 6, at: 2 },
		]);
	});

	it("forEach iterates (parallel) — bounded concurrency yields the same ordered results", async () => {
		const wf = await workflow(nsName("foreach-par-e2e"), { version: "1.0.0", trigger: http.post("/par") }, (req) => {
			const nums = (req.body as { nums: Handle<number[]> }).nums;
			forEach(
				nums,
				(item, index) => {
					step("double", dbl, { n: item, i: index });
				},
				{ id: "results", as: "num", mode: "parallel", concurrency: 2 },
			);
		});

		const runner = makeRunner();
		runner.loadWorkflow(wf);
		const out = await runner.execute({ nums: [10, 20, 30, 40] });

		expect(out.success).toBe(true);
		// Parallel aggregation preserves input order (results[index]).
		expect(out.state?.results).toEqual([
			{ doubled: 20, at: 0 },
			{ doubled: 40, at: 1 },
			{ doubled: 60, at: 2 },
			{ doubled: 80, at: 3 },
		]);
	});

	it("switchOn selects the right case; other cases' state is undefined", async () => {
		const wf = await workflow(nsName("switch-e2e"), { version: "1.0.0", trigger: http.post("/switch") }, (req) => {
			const kind = (req.body as { kind: Handle<string> }).kind;
			switchOn(
				kind,
				{
					cases: [
						{ when: "a", do: () => step("caseA", tag, { lane: "A" }) },
						{ when: ["b", "c"], do: () => step("caseBC", tag, { lane: "BC" }) },
					],
					default: () => step("caseDefault", tag, { lane: "D" }),
				},
				{ id: "route" },
			);
		});

		const runner = makeRunner();
		runner.loadWorkflow(wf);

		const a = await runner.execute({ kind: "a" });
		expect(a.success).toBe(true);
		expect(a.state?.caseA).toEqual({ lane: "A" });
		expect(a.state?.caseBC).toBeUndefined();
		expect(a.state?.caseDefault).toBeUndefined();

		const c = await runner.execute({ kind: "c" });
		expect(c.success).toBe(true);
		expect(c.state?.caseBC).toEqual({ lane: "BC" }); // array `when` any-of match
		expect(c.state?.caseA).toBeUndefined();
		expect(c.state?.caseDefault).toBeUndefined();

		const other = await runner.execute({ kind: "zzz" });
		expect(other.success).toBe(true);
		expect(other.state?.caseDefault).toEqual({ lane: "D" });
		expect(other.state?.caseA).toBeUndefined();
		expect(other.state?.caseBC).toBeUndefined();
	});

	it("tryCatch: catch arm runs on a thrown try step; $.error.{code,stepId} populated; failed step's state undefined (Rule 0)", async () => {
		const wf = await workflow(nsName("trycatch-e2e"), { version: "1.0.0", trigger: http.post("/guard") }, () => {
			tryCatch("guard", {
				try: () => {
					step("explode", boom, {});
				},
				catch: (error) => {
					step("caught", record, { code: error.code, stepId: error.stepId });
				},
			});
		});

		const runner = makeRunner();
		runner.loadWorkflow(wf);
		const out = await runner.execute({});

		expect(out.success).toBe(true);
		// Rule 0: the step that threw wrote NOTHING to state.
		expect(out.state?.explode).toBeUndefined();
		// The catch arm ran, and it read a populated $.error envelope: a plain
		// `throw new Error` inside a defineNode is mapped to GlobalError(500),
		// and stepId is the failed try step's id.
		expect(out.state?.caught).toEqual({ code: 500, stepId: "explode" });
	});
});
