/**
 * v0.5 forEach + loop end-to-end integration tests.
 *
 * Boots Configuration with a workflow definition + node registry,
 * runs it through Runner, and asserts on ctx.state. Covers:
 *
 *   forEach:
 *     - sequential mode produces results in order
 *     - parallel mode produces results in order (despite out-of-order completion)
 *     - empty input produces empty array
 *     - per-iteration state isolation
 *     - inner step errors propagate
 *
 *   loop:
 *     - while-condition controls iteration count
 *     - state mutations carry forward between iterations
 *     - maxIterations cap throws LoopMaxIterationsError
 */

import { $, lt } from "@blokjs/helper";
import type { Context, NodeBase, ResponseContext } from "@blokjs/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import Configuration from "../../src/Configuration";
import { LoopMaxIterationsError } from "../../src/LoopMaxIterationsError";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import { defineNode } from "../../src/defineNode";
import type GlobalOptions from "../../src/types/GlobalOptions";

/**
 * Tiny @blokjs/expr replica for tests — evaluates a JS expression
 * against ctx and returns the result.
 */
class ExprNode extends RunnerNode {
	constructor() {
		super();
		this.name = "@blokjs/expr";
		this.node = "@blokjs/expr";
		this.type = "module";
		this.active = true;
	}
	async run(ctx: Context): Promise<ResponseContext> {
		const opts = ((ctx.config as Record<string, unknown> | undefined)?.[this.name] ?? {}) as {
			inputs?: { expression?: string };
		};
		const expr = opts.inputs?.expression ?? "undefined";
		const data = (ctx.response?.data ?? ctx.request?.body ?? {}) as Record<string, unknown>;
		const vars = (ctx.vars ?? {}) as Record<string, unknown>;
		const fn = new Function("ctx", "data", "vars", `"use strict";return (${expr});`);
		return { success: true, data: fn(ctx, data, vars), error: null };
	}
}

/**
 * Tiny @blokjs/ctx-publish replica — sets ctx.state[name] = value.
 */
class CtxPublishNode extends RunnerNode {
	constructor() {
		super();
		this.name = "@blokjs/ctx-publish";
		this.node = "@blokjs/ctx-publish";
		this.type = "module";
		this.active = true;
	}
	async run(ctx: Context): Promise<ResponseContext> {
		const opts = ((ctx.config as Record<string, unknown> | undefined)?.[this.name] ?? {}) as {
			inputs?: { name?: string; value?: unknown };
		};
		const name = opts.inputs?.name ?? "";
		const value = opts.inputs?.value;
		const state = (ctx.state ?? {}) as Record<string, unknown>;
		state[name] = value;
		return { success: true, data: { name, value }, error: null };
	}
}

/**
 * A REAL `defineNode` node — unlike the hand-rolled RunnerNode replicas above,
 * it goes through the full `BlokService` pipeline, so its `ctx.response` is a
 * `BlokResponse` ENVELOPE (`{ data, contentType, success, error, steps }`).
 * This is what the @blokjs/* nodes a consumer actually uses produce, and what
 * made `forEach` leak envelopes before the fix. Returns `{ id, ok }` from the
 * per-iteration var, or `undefined` when `n === 0` (to exercise the sentinel).
 */
const RealEnvelopeNode = defineNode({
	name: "real-envelope",
	description: "test fixture — a real defineNode node (produces a BlokResponse envelope)",
	input: z.object({}),
	output: z.union([z.object({ id: z.number(), ok: z.boolean() }), z.undefined()]),
	async execute(ctx) {
		const n = (ctx.state as Record<string, unknown>).n as number;
		if (n === 0) return undefined;
		return { id: n, ok: true };
	},
});

/** A real defineNode whose body wraps a throwing path in tryCatch-style resilience. */
const MaybeFailNode = defineNode({
	name: "maybe-fail",
	description: "test fixture — throws when n is even",
	input: z.object({}),
	output: z.object({ n: z.number() }),
	async execute(ctx) {
		const n = (ctx.state as Record<string, unknown>).n as number;
		if (n % 2 === 0) throw new Error(`boom ${n}`);
		return { n };
	},
});

const ifElse = defineNode({
	name: "@blokjs/if-else",
	description: "test-local mirror of the real if-else flow node",
	flow: true,
	input: z.array(z.object({ type: z.enum(["if", "else"]), condition: z.string().optional(), steps: z.array(z.any()) })),
	output: z.array(z.any()),
	execute: (ctx, conditions) => {
		for (const c of conditions) {
			if (c.condition && c.condition.trim() !== "") {
				const result = Function("ctx", `"use strict";return (${c.condition});`)(ctx);
				if (result) return c.steps as never[];
			} else {
				return c.steps as never[];
			}
		}
		return [] as never[];
	},
});

/** A real defineNode that just returns already-mapped inputs. */
const CacheEchoNode = defineNode({
	name: "cache-echo",
	description: "test fixture — echo mapped inputs",
	input: z.object({
		value: z.unknown(),
		label: z.string(),
		copy: z.unknown().optional(),
	}),
	output: z.object({
		value: z.unknown(),
		label: z.string(),
		copy: z.unknown().optional(),
	}),
	async execute(_ctx, input) {
		return input;
	},
});

/**
 * Build a Configuration from a workflow definition + helper nodes.
 */
async function bootConfig(workflowDef: unknown): Promise<{ config: Configuration; ctx: Context }> {
	const config = new Configuration();
	const helpers: Record<string, RunnerNode> = {
		"@blokjs/expr": new ExprNode(),
		"@blokjs/ctx-publish": new CtxPublishNode(),
		"@blokjs/if-else": ifElse as unknown as RunnerNode,
		"real-envelope": RealEnvelopeNode as unknown as RunnerNode,
		"maybe-fail": MaybeFailNode as unknown as RunnerNode,
		"cache-echo": CacheEchoNode as unknown as RunnerNode,
	};
	const globalOptions = {
		nodes: {
			getNode: (name: string): RunnerNode | null => helpers[name] ?? null,
		},
	} as unknown as GlobalOptions;
	await config.init("test-wf", globalOptions, workflowDef);
	const state: Record<string, unknown> = {};
	const ctx = {
		id: "test-req",
		workflow_name: "test-wf",
		workflow_path: "/test",
		request: { body: {}, headers: {}, params: {}, query: {} },
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
	return { config, ctx };
}

function spyOnExpressionCompiles(marker: string): string[] {
	const NativeFunction = globalThis.Function;
	const compiledBodies: string[] = [];
	vi.spyOn(globalThis, "Function").mockImplementation(((...args: string[]) => {
		const body = args.at(-1);
		if (typeof body === "string" && body.includes(marker)) compiledBodies.push(body);
		return NativeFunction(...args);
	}) as unknown as FunctionConstructor);
	return compiledBodies;
}

describe("v0.5 forEach + loop integration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("forEach", () => {
		it("sequential mode iterates in order and stores results array", async () => {
			const wfDef = {
				name: "test-foreach-seq",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "doubled",
						forEach: {
							in: [1, 2, 3, 4, 5],
							as: "n",
							mode: "sequential",
							do: [
								{
									id: "double",
									use: "@blokjs/expr",
									type: "module",
									inputs: { expression: "ctx.state.n * 2" },
								},
							],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			const runner = new Runner(config.steps as NodeBase[]);
			await runner.run(ctx);

			const state = ctx.state as Record<string, unknown>;
			expect(state.doubled).toEqual([2, 4, 6, 8, 10]);
		});

		it("parallel mode preserves index order in results", async () => {
			const wfDef = {
				name: "test-foreach-par",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "results",
						forEach: {
							in: [10, 20, 30, 40, 50],
							as: "v",
							mode: "parallel",
							concurrency: 3,
							do: [
								{
									id: "compute",
									use: "@blokjs/expr",
									type: "module",
									inputs: { expression: "ctx.state.v + 1" },
								},
							],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			const runner = new Runner(config.steps as NodeBase[]);
			await runner.run(ctx);

			expect((ctx.state as Record<string, unknown>).results).toEqual([11, 21, 31, 41, 51]);
		});

		it("parallel mode isolates per-iteration state writes", async () => {
			const wfDef = {
				name: "test-foreach-par-isolation",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "results",
						forEach: {
							in: [1, 2, 3, 4, 5],
							as: "v",
							mode: "parallel",
							concurrency: 5,
							do: [
								{
									id: "write-temp",
									use: "@blokjs/ctx-publish",
									type: "module",
									inputs: { name: "temp", value: "js/ctx.state.v * 10" },
								},
								{
									id: "read-temp",
									use: "@blokjs/expr",
									type: "module",
									inputs: { expression: "({ v: ctx.state.v, temp: ctx.state.temp })" },
								},
							],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			const runner = new Runner(config.steps as NodeBase[]);
			await runner.run(ctx);

			expect((ctx.state as Record<string, unknown>).results).toEqual([
				{ v: 1, temp: 10 },
				{ v: 2, temp: 20 },
				{ v: 3, temp: 30 },
				{ v: 4, temp: 40 },
				{ v: 5, temp: 50 },
			]);
			expect((ctx.state as Record<string, unknown>).temp).toBeUndefined();
		});

		it("empty input array produces empty results", async () => {
			const wfDef = {
				name: "test-foreach-empty",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "results",
						forEach: {
							in: [],
							as: "v",
							do: [{ id: "x", use: "@blokjs/expr", type: "module", inputs: { expression: "1" } }],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			const runner = new Runner(config.steps as NodeBase[]);
			await runner.run(ctx);

			expect((ctx.state as Record<string, unknown>).results).toEqual([]);
		});

		it("exposes the iteration index at ctx.state[as + 'Index']", async () => {
			const wfDef = {
				name: "test-foreach-index",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "indices",
						forEach: {
							in: ["a", "b", "c"],
							as: "letter",
							mode: "sequential",
							do: [
								{
									id: "echo-index",
									use: "@blokjs/expr",
									type: "module",
									inputs: { expression: "ctx.state.letterIndex" },
								},
							],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			const runner = new Runner(config.steps as NodeBase[]);
			await runner.run(ctx);

			expect((ctx.state as Record<string, unknown>).indices).toEqual([0, 1, 2]);
		});

		// Regression for TASK-foreach-output-shape: a body using a REAL
		// defineNode node (BlokResponse envelope) must aggregate UNWRAPPED
		// values — `ctx.state[<loopId>]` reads like every other state key, NOT
		// an array of `{ data, success, error, contentType, steps }` envelopes.
		it("unwraps the BlokResponse envelope from real (defineNode) nodes — sequential", async () => {
			const wfDef = {
				name: "test-foreach-unwrap-seq",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "loop",
						forEach: {
							in: [1, 2, 3],
							as: "n",
							mode: "sequential",
							do: [{ id: "make", use: "real-envelope", type: "module", inputs: {} }],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			await new Runner(config.steps as NodeBase[]).run(ctx);
			expect((ctx.state as Record<string, unknown>).loop).toEqual([
				{ id: 1, ok: true },
				{ id: 2, ok: true },
				{ id: 3, ok: true },
			]);
		});

		it("unwraps the BlokResponse envelope from real (defineNode) nodes — parallel", async () => {
			const wfDef = {
				name: "test-foreach-unwrap-par",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "loop",
						forEach: {
							in: [1, 2, 3, 4],
							as: "n",
							mode: "parallel",
							concurrency: 2,
							do: [{ id: "make", use: "real-envelope", type: "module", inputs: {} }],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			await new Runner(config.steps as NodeBase[]).run(ctx);
			expect((ctx.state as Record<string, unknown>).loop).toEqual([
				{ id: 1, ok: true },
				{ id: 2, ok: true },
				{ id: 3, ok: true },
				{ id: 4, ok: true },
			]);
		});

		it("preserves the null sentinel for iterations that return undefined", async () => {
			// real-envelope returns undefined when n === 0.
			const wfDef = {
				name: "test-foreach-sentinel",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "loop",
						forEach: {
							in: [1, 0, 2],
							as: "n",
							mode: "sequential",
							do: [{ id: "make", use: "real-envelope", type: "module", inputs: {} }],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			await new Runner(config.steps as NodeBase[]).run(ctx);
			expect((ctx.state as Record<string, unknown>).loop).toEqual([{ id: 1, ok: true }, null, { id: 2, ok: true }]);
		});

		it("aggregates a tryCatch body's catch result unwrapped (per-item resilience)", async () => {
			// maybe-fail throws on even n; the tryCatch catch returns { ok:false }.
			// The aggregated slot must be the unwrapped { ok:false } / { n } — not
			// an envelope — so `loop.filter(r => r.ok)` works as authors expect.
			const wfDef = {
				name: "test-foreach-trycatch",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "loop",
						forEach: {
							in: [1, 2, 3],
							as: "n",
							mode: "sequential",
							do: [
								{
									id: "guard",
									tryCatch: {
										try: [{ id: "risky", use: "maybe-fail", type: "module", inputs: {} }],
										catch: [
											{
												id: "fallback",
												use: "@blokjs/expr",
												type: "module",
												inputs: { expression: "({ ok: false })" },
											},
										],
									},
								},
							],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			await new Runner(config.steps as NodeBase[]).run(ctx);
			expect((ctx.state as Record<string, unknown>).loop).toEqual([{ n: 1 }, { ok: false }, { n: 3 }]);
		});

		it("evaluates branch conditions against the current forEach item", async () => {
			const wfDef = {
				name: "test-foreach-branch-item-condition",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "routes",
						forEach: {
							in: [
								{ id: "a", ready: true },
								{ id: "b", ready: false },
							],
							as: "item",
							mode: "sequential",
							do: [
								{
									id: "route-item",
									branch: {
										when: "ctx.state.item.ready",
										then: [
											{
												id: "mark-ready",
												use: "@blokjs/ctx-publish",
												type: "module",
												inputs: { name: "decision", value: "ready" },
											},
										],
										else: [
											{
												id: "mark-wait",
												use: "@blokjs/ctx-publish",
												type: "module",
												inputs: { name: "decision", value: "wait" },
											},
										],
									},
								},
								{
									id: "echo-decision",
									use: "@blokjs/expr",
									type: "module",
									inputs: { expression: "({ id: ctx.state.item.id, decision: ctx.state.decision })" },
								},
							],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			await new Runner(config.steps as NodeBase[]).run(ctx);

			expect((ctx.state as Record<string, unknown>).routes).toEqual([
				{ id: "a", decision: "ready" },
				{ id: "b", decision: "wait" },
			]);
			expect((ctx.state as Record<string, unknown>).decision).toBeUndefined();
		});

		it.each([
			["sequential", "cache426SeqItem"],
			["parallel", "cache426ParItem"],
		] as const)("does not recompile mapper expressions per %s iteration", async (mode, as) => {
			const valueExpr = `ctx.state.${as} * 10`;
			const labelExpr = `\`v=\${ctx.state.${as}}\``;
			const wfDef = {
				name: `test-foreach-cache-${mode}`,
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "loop",
						forEach: {
							in: [1, 2, 3, 4, 5, 6],
							as,
							mode,
							concurrency: 3,
							do: [
								{
									id: "echo",
									use: "cache-echo",
									type: "module",
									inputs: {
										value: `js/${valueExpr}`,
										copy: `js/${valueExpr}`,
										label: `js/${labelExpr}`,
									},
								},
							],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			const compiledBodies = spyOnExpressionCompiles(as);

			await new Runner(config.steps as NodeBase[]).run(ctx);

			expect((ctx.state as Record<string, unknown>).loop).toEqual([
				{ value: 10, copy: 10, label: "v=1" },
				{ value: 20, copy: 20, label: "v=2" },
				{ value: 30, copy: 30, label: "v=3" },
				{ value: 40, copy: 40, label: "v=4" },
				{ value: 50, copy: 50, label: "v=5" },
				{ value: 60, copy: 60, label: "v=6" },
			]);
			expect(compiledBodies).toHaveLength(2);
		});

		it("does not recompile nested forEach mapper expressions per nested item", async () => {
			const wfDef = {
				name: "test-foreach-cache-nested",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "outer",
						forEach: {
							in: [1, 2],
							as: "cache426OuterItem",
							mode: "sequential",
							do: [
								{
									id: "inner",
									forEach: {
										in: "js/[ctx.state.cache426OuterItem, ctx.state.cache426OuterItem + 100]",
										as: "cache426InnerItem",
										mode: "sequential",
										do: [
											{
												id: "nested-echo",
												use: "cache-echo",
												type: "module",
												inputs: {
													value: "js/ctx.state.cache426OuterItem + ctx.state.cache426InnerItem",
													copy: "js/ctx.state.cache426OuterItem + ctx.state.cache426InnerItem",
													label: "js/`pair=${ctx.state.cache426OuterItem}:${ctx.state.cache426InnerItem}`",
												},
											},
										],
									},
								},
							],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			const compiledBodies = spyOnExpressionCompiles("cache426");

			await new Runner(config.steps as NodeBase[]).run(ctx);

			expect((ctx.state as Record<string, unknown>).outer).toEqual([
				[
					{ value: 2, copy: 2, label: "pair=1:1" },
					{ value: 102, copy: 102, label: "pair=1:101" },
				],
				[
					{ value: 4, copy: 4, label: "pair=2:2" },
					{ value: 104, copy: 104, label: "pair=2:102" },
				],
			]);
			expect(compiledBodies).toHaveLength(3);
			expect(new Set(compiledBodies)).toHaveLength(3);
		});
	});

	describe("loop", () => {
		it("while-condition controls iteration count", async () => {
			const wfDef = {
				name: "test-loop-counter",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "init",
						use: "@blokjs/ctx-publish",
						type: "module",
						inputs: { name: "n", value: 0 },
					},
					{
						id: "incr-loop",
						loop: {
							while: "ctx.state.n < 5",
							do: [
								{
									id: "incr",
									use: "@blokjs/ctx-publish",
									type: "module",
									inputs: { name: "n", value: "js/ctx.state.n + 1" },
								},
							],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			const runner = new Runner(config.steps as NodeBase[]);
			await runner.run(ctx);

			expect((ctx.state as Record<string, unknown>).n).toBe(5);
		});

		it("exposes the iteration counter at ctx.state[<id>Index]", async () => {
			const wfDef = {
				name: "test-loop-index",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "counter-loop",
						loop: {
							while: "ctx.state['counter-loopIndex'] < 3",
							do: [
								{
									id: "tick",
									use: "@blokjs/expr",
									type: "module",
									inputs: { expression: "ctx.state['counter-loopIndex']" },
								},
							],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			const runner = new Runner(config.steps as NodeBase[]);
			await runner.run(ctx);

			// After exit, the counter has advanced past the last successful iteration.
			expect((ctx.state as Record<string, unknown>)["counter-loopIndex"]).toBe(3);
		});

		it("terminates from a raw op expression over the loop counter handle", async () => {
			const whileExpr = lt($.state["poll-loopIndex"], 3);
			expect(whileExpr).toBe('ctx.state["poll-loopIndex"] < 3');

			const wfDef = {
				name: "test-loop-counter-op",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "poll-loop",
						loop: {
							while: whileExpr,
							maxIterations: 10,
							do: [
								{
									id: "echo-index",
									use: "@blokjs/expr",
									type: "module",
									inputs: { expression: 'ctx.state["poll-loopIndex"]' },
								},
							],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			await new Runner(config.steps as NodeBase[]).run(ctx);

			expect((ctx.state as Record<string, unknown>)["poll-loopIndex"]).toBe(3);
		});

		it("throws LoopMaxIterationsError when cap is exceeded", async () => {
			const wfDef = {
				name: "test-loop-cap",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/x" } },
				steps: [
					{
						id: "runaway",
						loop: {
							while: "true",
							maxIterations: 3,
							do: [
								{
									id: "noop",
									use: "@blokjs/expr",
									type: "module",
									inputs: { expression: "1" },
								},
							],
						},
					},
				],
			};
			const { config, ctx } = await bootConfig(wfDef);
			const runner = new Runner(config.steps as NodeBase[]);
			let caught: unknown = null;
			try {
				await runner.run(ctx);
			} catch (err) {
				caught = err;
			}
			// The error may be wrapped — check that it carries the LoopMaxIterationsError signature.
			const errString =
				caught instanceof LoopMaxIterationsError
					? caught.message
					: caught instanceof Error
						? caught.message
						: String(caught) + (ctx.response?.error?.message ?? "");
			const ctxErr = ctx.response?.error?.message ?? "";
			const combined = `${errString} ${ctxErr}`;
			expect(combined).toMatch(/exceeded maxIterations|LoopMaxIterationsError/);
			expect((ctx.state as Record<string, unknown>).runawayIndex).toBe(3);
		});
	});
});
