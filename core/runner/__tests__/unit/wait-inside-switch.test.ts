/**
 * v0.6 wait-inside-primitives Phase 4 — switch + wait + nested
 * primitive composition tests.
 *
 * Phase 4 introduces:
 *   - `SwitchIterationContext` discriminator (`mode: "switch"`) on the
 *     persisted iteration cursor.
 *   - A primitive-stack on ctx so nested primitives (forEach inside
 *     switch, switch inside forEach, forEach inside forEach, etc.)
 *     each write their OWN NodeRun's cursor.
 *   - Resume logic in SwitchNode that walks back into the previously
 *     matched arm at the right inner step.
 *
 * Test matrix:
 *   1. **switch + wait round-trip** — top-level switch with a wait
 *      inside the matched arm; defer + dispatchDeferred resumes the
 *      same arm and completes.
 *   2. **forEach > switch > wait** — each iteration's switch contains
 *      a wait; both the forEach's frame and the switch's frame
 *      persist to their respective NodeRuns.
 *   3. **switch > forEach > wait** — a switch arm wraps a forEach
 *      whose iteration body waits; the switch cursor stays pinned
 *      while forEach iterations defer/resume.
 *   4. **forEach > forEach > wait** — two levels of iteration; the
 *      Phase 2/3 single-slot model would lose the outer cursor here.
 */

import type { Context, ResponseContext } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Configuration from "../../src/Configuration";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import TriggerBase from "../../src/TriggerBase";
import { DeferredDispatchSignal } from "../../src/scheduling/DeferredDispatchSignal";
import { DeferredRunScheduler } from "../../src/scheduling/DeferredRunScheduler";
import { RunTracker } from "../../src/tracing/RunTracker";
import type { IterationContext, SequentialIterationContext, SwitchIterationContext } from "../../src/tracing/types";
import type GlobalOptions from "../../src/types/GlobalOptions";

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

function buildTrigger(workflow: unknown, name: string): TestTrigger {
	const t = new TestTrigger();
	t.setWorkflow(workflow, name);
	return t;
}

class TestTrigger extends TriggerBase {
	private cachedRunner: Runner | null = null;
	private pendingWorkflow: unknown = null;
	private pendingName = "";

	setWorkflow(wf: unknown, name: string): void {
		this.pendingWorkflow = wf;
		this.pendingName = name;
	}

	async setup(): Promise<void> {
		const helpers: Record<string, RunnerNode> = { "@blokjs/expr": new ExprNode() };
		const globalOptions = {
			nodes: { getNode: (n: string): RunnerNode | null => helpers[n] ?? null },
		} as unknown as GlobalOptions;
		const cfg = new Configuration();
		await cfg.init(this.pendingName, globalOptions, this.pendingWorkflow);
		this.configuration = cfg;
		this.cachedRunner = new Runner(cfg.steps as unknown as ConstructorParameters<typeof Runner>[0]);
	}

	async listen(): Promise<number> {
		return 0;
	}

	override getRunner(): Runner {
		if (!this.cachedRunner) throw new Error("setup() must be called before getRunner()");
		return this.cachedRunner;
	}

	async exposeDispatchDeferred(ctx: Context, runId: string): Promise<void> {
		await this.dispatchDeferred(ctx, runId, undefined);
	}
}

function getCursors(runId: string): Array<{ nodeName: string; cursor: IterationContext }> {
	const all = RunTracker.getInstance().getStore().getNodeRuns(runId);
	return all
		.filter((n) => n.iterationContext !== undefined)
		.map((n) => ({ nodeName: n.nodeName, cursor: n.iterationContext as IterationContext }));
}

function latestCursorByName(runId: string, nodeName: string): IterationContext | undefined {
	const all = RunTracker.getInstance().getStore().getNodeRuns(runId);
	const matches = all
		.map((n, idx) => ({ n, idx }))
		.filter(({ n }) => n.nodeName === nodeName && n.iterationContext !== undefined);
	matches.sort((a, b) => {
		const dt = b.n.startedAt - a.n.startedAt;
		return dt !== 0 ? dt : b.idx - a.idx;
	});
	return matches[0]?.n.iterationContext;
}

describe("v0.6 Phase 4 · switch + wait", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
		vi.useRealTimers();
	});

	describe("top-level switch with wait inside matched arm", () => {
		const workflow = {
			name: "p4-switch-wait",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/" } },
			steps: [
				{
					id: "route",
					switch: {
						on: "js/ctx.request.body.kind",
						cases: [
							{
								when: "fast",
								do: [{ id: "fast-handler", use: "@blokjs/expr", inputs: { expression: '({ done: "fast" })' } }],
							},
							{
								when: "slow",
								do: [
									{
										id: "pre-wait",
										use: "@blokjs/expr",
										inputs: { expression: '({ stage: "before-wait" })' },
									},
									{ id: "throttle", wait: { for: 50 } },
									{
										id: "post-wait",
										use: "@blokjs/expr",
										inputs: { expression: '({ stage: "after-wait" })' },
									},
								],
							},
						],
					},
				},
			],
		};

		it("first defer writes a switch-mode cursor with the matched caseIndex + innerStepIndex", async () => {
			const t = buildTrigger(workflow, "p4-switch-wait");
			await t.setup();
			const ctx = t.createContext(undefined, "/p4-switch-wait", "switch-first-defer");
			(ctx.request as Record<string, unknown>).body = { kind: "slow" };

			await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);
			const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;

			const cursor = latestCursorByName(runId, "route") as SwitchIterationContext | undefined;
			expect(cursor).toBeDefined();
			expect(cursor?.mode).toBe("switch");
			// `slow` is index 1 in the cases[] array.
			expect(cursor?.caseIndex).toBe(1);
			// wait is at index 1 of the matched arm (pre-wait, throttle, post-wait).
			expect(cursor?.innerStepIndex).toBe(1);
		});

		it("dispatchDeferred re-entry resumes the matched arm at the post-wait step and completes", async () => {
			const t = buildTrigger(workflow, "p4-switch-wait");
			await t.setup();
			const ctx = t.createContext(undefined, "/p4-switch-wait", "switch-round-trip");
			(ctx.request as Record<string, unknown>).body = { kind: "slow" };

			await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);
			const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;

			// Resume. The wait satisfies, post-wait runs, run completes.
			await t.exposeDispatchDeferred(ctx, runId);
			const finalRun = RunTracker.getInstance().getStore().getRun(runId);
			expect(finalRun?.status).toBe("completed");

			// SwitchNode is a passthrough — its state slot mirrors the
			// last inner step's response (post-wait's output in this
			// matched arm). Confirms the post-wait step ran AFTER the
			// wait satisfied on resume.
			const state = ctx.state as Record<string, unknown>;
			expect(state.route).toEqual({ stage: "after-wait" });
		});
	});

	describe("forEach > switch > wait — nested primitives both persist their cursors", () => {
		const workflow = {
			name: "p4-foreach-switch-wait",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/" } },
			steps: [
				{
					id: "per-item",
					forEach: {
						in: [
							{ id: "alpha", needsWait: true },
							{ id: "beta", needsWait: false },
						],
						as: "item",
						do: [
							{
								id: "router",
								switch: {
									on: "js/ctx.state.item.needsWait",
									cases: [
										{
											when: true,
											do: [
												{ id: "throttle", wait: { for: 50 } },
												{
													id: "after-wait",
													use: "@blokjs/expr",
													inputs: { expression: "({ handled: ctx.state.item.id })" },
												},
											],
										},
									],
									default: [
										{
											id: "skip-wait",
											use: "@blokjs/expr",
											inputs: { expression: "({ handled: ctx.state.item.id, skipped: true })" },
										},
									],
								},
							},
						],
					},
				},
			],
		};

		it("first defer writes BOTH frames (forEach + switch) to their respective NodeRuns", async () => {
			const t = buildTrigger(workflow, "p4-foreach-switch-wait");
			await t.setup();
			const ctx = t.createContext(undefined, "/p4-foreach-switch-wait", "fe-sw-first");
			await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

			const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
			const cursors = getCursors(runId);
			// Two cursors: one on `per-item` (forEach), one on `router` (switch).
			const foreachCursor = cursors.find((c) => c.nodeName === "per-item")?.cursor as
				| SequentialIterationContext
				| undefined;
			const switchCursor = cursors.find((c) => c.nodeName === "router")?.cursor as SwitchIterationContext | undefined;

			expect(foreachCursor).toBeDefined();
			expect(foreachCursor?.mode).toBe("sequential");
			expect(foreachCursor?.iteration).toBe(0);
			// In the outer forEach's iteration body, the switch is at index 0.
			expect(foreachCursor?.innerStepIndex).toBe(0);

			expect(switchCursor).toBeDefined();
			expect(switchCursor?.mode).toBe("switch");
			// `when: true` is the first case → index 0.
			expect(switchCursor?.caseIndex).toBe(0);
			// wait is at index 0 of the matched arm.
			expect(switchCursor?.innerStepIndex).toBe(0);
		});

		it("rounds-trips through dispatchDeferred and completes both iterations", async () => {
			const t = buildTrigger(workflow, "p4-foreach-switch-wait");
			await t.setup();
			const ctx = t.createContext(undefined, "/p4-foreach-switch-wait", "fe-sw-round-trip");

			// First pass: iteration 0 (needsWait: true) fires the wait.
			await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);
			const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;

			// Resume — iteration 0 satisfies its wait, iteration 1 takes
			// the default arm (no wait) and completes the forEach.
			await t.exposeDispatchDeferred(ctx, runId);
			const finalRun = RunTracker.getInstance().getStore().getRun(runId);
			expect(finalRun?.status).toBe("completed");

			// Final forEach result array has 2 entries.
			const state = ctx.state as Record<string, unknown>;
			const results = state["per-item"] as unknown[];
			expect(results).toHaveLength(2);
		});
	});

	describe("switch > forEach > wait — switch arm wraps a forEach with waits", () => {
		const workflow = {
			name: "p4-switch-foreach-wait",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/" } },
			steps: [
				{
					id: "route",
					switch: {
						on: "js/'enabled'",
						cases: [
							{
								when: "enabled",
								do: [
									{
										id: "per-item",
										forEach: {
											in: ["a", "b"],
											as: "letter",
											do: [
												{
													id: "record",
													use: "@blokjs/expr",
													inputs: { expression: "({ letter: ctx.state.letter })" },
												},
												{ id: "throttle", wait: { for: 50 } },
											],
										},
									},
								],
							},
						],
					},
				},
			],
		};

		it("first defer writes switch frame (pinned to caseIndex 0) + forEach frame (iteration 0)", async () => {
			const t = buildTrigger(workflow, "p4-switch-foreach-wait");
			await t.setup();
			const ctx = t.createContext(undefined, "/p4-switch-foreach-wait", "sw-fe-first");
			await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

			const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
			const routeCursor = latestCursorByName(runId, "route") as SwitchIterationContext | undefined;
			const foreachCursor = latestCursorByName(runId, "per-item") as SequentialIterationContext | undefined;

			expect(routeCursor?.mode).toBe("switch");
			expect(routeCursor?.caseIndex).toBe(0);
			// In the switch's matched arm, per-item is at index 0.
			expect(routeCursor?.innerStepIndex).toBe(0);

			expect(foreachCursor?.mode).toBe("sequential");
			expect(foreachCursor?.iteration).toBe(0);
			// wait is at index 1 of the forEach body (record, throttle).
			expect(foreachCursor?.innerStepIndex).toBe(1);
		});

		it("rounds-trips both iterations through dispatchDeferred and completes", async () => {
			const t = buildTrigger(workflow, "p4-switch-foreach-wait");
			await t.setup();
			const ctx = t.createContext(undefined, "/p4-switch-foreach-wait", "sw-fe-round-trip");

			await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);
			const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;

			// Resume #1 — iter 0 satisfies, iter 1 fires the wait.
			await t.exposeDispatchDeferred(ctx, runId);
			let run = RunTracker.getInstance().getStore().getRun(runId);
			expect(run?.status).toBe("delayed");

			// Resume #2 — iter 1 satisfies, forEach completes, switch
			// completes, run completes.
			await t.exposeDispatchDeferred(ctx, runId);
			run = RunTracker.getInstance().getStore().getRun(runId);
			expect(run?.status).toBe("completed");
		});
	});

	describe("forEach > forEach > wait — two levels of iteration; Phase 2/3 single-slot would lose the outer cursor", () => {
		const workflow = {
			name: "p4-nested-foreach-wait",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/" } },
			steps: [
				{
					id: "outer",
					forEach: {
						in: ["X", "Y"],
						as: "row",
						do: [
							{
								id: "inner",
								forEach: {
									in: [1, 2],
									as: "col",
									do: [
										{
											id: "record",
											use: "@blokjs/expr",
											inputs: { expression: "({ row: ctx.state.row, col: ctx.state.col })" },
										},
										{ id: "throttle", wait: { for: 50 } },
									],
								},
							},
						],
					},
				},
			],
		};

		it("first defer writes BOTH outer + inner forEach cursors with their respective iteration indices", async () => {
			const t = buildTrigger(workflow, "p4-nested-foreach-wait");
			await t.setup();
			const ctx = t.createContext(undefined, "/p4-nested-foreach-wait", "fe-fe-first");
			await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

			const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
			const outerCursor = latestCursorByName(runId, "outer") as SequentialIterationContext | undefined;
			const innerCursor = latestCursorByName(runId, "inner") as SequentialIterationContext | undefined;

			// Outer is at iteration 0 (row="X"), inner step index 0 (inner forEach is at outer's body[0]).
			expect(outerCursor?.iteration).toBe(0);
			expect(outerCursor?.innerStepIndex).toBe(0);

			// Inner is at iteration 0 (col=1), inner step index 1 (wait is at body[1]).
			expect(innerCursor?.iteration).toBe(0);
			expect(innerCursor?.innerStepIndex).toBe(1);
		});

		it("rounds-trips all 4 (2 outer × 2 inner) iterations through dispatchDeferred and completes", async () => {
			const t = buildTrigger(workflow, "p4-nested-foreach-wait");
			await t.setup();
			const ctx = t.createContext(undefined, "/p4-nested-foreach-wait", "fe-fe-round-trip");

			// First wait fires (outer 0, inner 0).
			await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);
			const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;

			// 4 inner waits total — defer chain.
			for (let i = 0; i < 4; i += 1) {
				const run = RunTracker.getInstance().getStore().getRun(runId);
				if (run?.status === "completed") break;
				await t.exposeDispatchDeferred(ctx, runId);
			}

			const finalRun = RunTracker.getInstance().getStore().getRun(runId);
			expect(finalRun?.status).toBe("completed");

			const state = ctx.state as Record<string, unknown>;
			const outerResults = state.outer as unknown[];
			// Outer aggregates 2 rows; each row is the inner forEach result
			// (2 cols → array of 2). Just assert the shape.
			expect(outerResults).toHaveLength(2);
		});
	});
});
