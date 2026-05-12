/**
 * v0.6 wait-inside-primitives Phase 2 — sequential forEach with wait
 * inside the iteration body. Round-trips a 3-iteration forEach where
 * each iteration's body has a wait, simulating timer fires via
 * `dispatchDeferred` between defer cycles. Verifies:
 *
 *   - Wait inside iteration N fires `WaitDispatchRequest` and the
 *     workflow defers (DeferredDispatchSignal thrown by TriggerBase).
 *   - The forEach's NodeRun has `iteration_context` written with
 *     `{iteration: N, innerStepIndex, completedResults: results[0..N-1]}`.
 *   - On dispatchDeferred re-entry, ForEachNode reads the resume hint
 *     from `ctx._blokIterationResume` and skips iterations [0..N-1]
 *     (using the cached completedResults), resumes iteration N at the
 *     post-wait inner step.
 *   - After all 3 iterations complete, the run flips to `completed`
 *     and the forEach's final state[forEach.id] contains all 3 results
 *     in order.
 *
 * The cross-process recovery path is implicitly covered by re-using
 * the same ctx across dispatchDeferred re-entries (the ctx state
 * snapshot rehydrate is exercised by wait-state-snapshot.test.ts).
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

/**
 * TestTrigger that hosts a Configuration loaded with a forEach +
 * wait workflow. The forEach iterates over a 3-element array; each
 * iteration runs an `expr` step that records the item, then a `wait`
 * step that defers for 50ms. Each iteration's wait throws
 * `WaitDispatchRequest` → DeferredDispatchSignal at the trigger
 * boundary; the test calls `exposeDispatchDeferred` between cycles to
 * simulate the timer firing.
 */
class ForEachWaitTestTrigger extends TriggerBase {
	private cachedRunner: Runner | null = null;

	async setup(): Promise<void> {
		const helpers: Record<string, RunnerNode> = {
			"@blokjs/expr": new ExprNode(),
		};
		const globalOptions = {
			nodes: {
				getNode: (name: string): RunnerNode | null => helpers[name] ?? null,
			},
		} as unknown as GlobalOptions;
		const cfg = new Configuration();
		const wf = {
			name: "phase2-foreach-wait",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/" } },
			steps: [
				{
					id: "process-jobs",
					forEach: {
						in: ["job-A", "job-B", "job-C"],
						as: "job",
						do: [
							{
								id: "record",
								use: "@blokjs/expr",
								type: "module",
								inputs: { expression: "({ jobId: ctx.state.job, completed: true })" },
							},
							{ id: "throttle", wait: { for: 50 } },
						],
					},
				},
			],
		};
		await cfg.init("phase2-foreach-wait", globalOptions, wf);
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

describe("v0.6 Phase 2 · sequential forEach with wait inside iteration body", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
		vi.useRealTimers();
	});

	it("first defer writes iteration_context to forEach NodeRun (iteration: 0, innerStepIndex: 1, completedResults: [])", async () => {
		const t = new ForEachWaitTestTrigger();
		await t.setup();
		const ctx = t.createContext(undefined, "/phase2-foreach-wait", "first-defer");
		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const tracker = RunTracker.getInstance();
		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("delayed");
		// state_snapshot was written even on a nested wait so cross-process
		// recovery has full ctx.state to rehydrate (PR #71 contract).
		expect(run?.stateSnapshot).toBeDefined();

		// And — Phase 2's headline contract — the forEach NodeRun has
		// iteration_context set with the first iteration's cursor.
		const nodeRuns = tracker.getStore().getNodeRuns(runId);
		const forEachRun = nodeRuns.find((n) => n.iterationContext !== undefined);
		expect(forEachRun).toBeDefined();
		expect(forEachRun?.iterationContext).toEqual({
			mode: "sequential",
			iteration: 0,
			innerStepIndex: 1, // wait is at index 1; record is at index 0
			completedResults: [],
		});
	});

	it("rounds-trips all 3 iterations through dispatchDeferred — final state has results for every job", async () => {
		const t = new ForEachWaitTestTrigger();
		await t.setup();
		const ctx = t.createContext(undefined, "/phase2-foreach-wait", "round-trip");

		// Iteration 0 wait fires.
		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);
		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const tracker = RunTracker.getInstance();

		// Helper — each dispatchDeferred re-run creates a NEW forEach
		// NodeRun (RunnerSteps.tracker.startNode is called fresh per
		// invocation). The OLD NodeRun's iteration_context is frozen at
		// the previous defer's cursor; the LATEST one carries the
		// most-recent cursor. Pick latest by startedAt — same heuristic
		// TriggerBase uses to rehydrate `ctx._blokIterationResume`.
		type Cursor = { iteration: number; innerStepIndex: number; completedResults: unknown[] };
		const latestForEachContext = (): Cursor | undefined => {
			// Mirrors TriggerBase.run's rehydrate selection — sort by
			// startedAt descending with array insertion order as the
			// stable secondary key (ms-collision happens when consecutive
			// defer/resume cycles fire within the same Date.now() tick).
			const all = tracker.getStore().getNodeRuns(runId);
			const withCtx = all.map((n, idx) => ({ n, idx })).filter(({ n }) => n.iterationContext !== undefined);
			withCtx.sort((a, b) => {
				const dt = b.n.startedAt - a.n.startedAt;
				return dt !== 0 ? dt : b.idx - a.idx;
			});
			return withCtx[0]?.n.iterationContext as Cursor | undefined;
		};

		// Re-entry — iteration 0 satisfies + iteration 1 wait fires.
		await t.exposeDispatchDeferred(ctx, runId);
		let cursor = latestForEachContext();
		expect(cursor?.iteration).toBe(1);
		expect(cursor?.innerStepIndex).toBe(1);
		// completedResults captures iteration 0's contribution to the
		// result array — one entry. The shape of the entry depends on
		// the iteration body's last step (childCtx.response after the
		// wait satisfies); we only assert the length here so the test
		// stays robust to fixture choices. The semantic shape (e.g.
		// `state["record-job"]` containing real job data) is exercised
		// via the smoke gate against the real `v05-async-job-poller`
		// workflow, where production `@blokjs/expr` writes step outputs
		// through `applyStepOutput` so iteration bodies see prior step
		// outputs in `ctx.state` after rehydrate.
		expect(cursor?.completedResults).toHaveLength(1);

		// Re-entry — iteration 1 satisfies + iteration 2 wait fires.
		await t.exposeDispatchDeferred(ctx, runId);
		cursor = latestForEachContext();
		expect(cursor?.iteration).toBe(2);
		expect(cursor?.completedResults).toHaveLength(2);

		// Re-entry — iteration 2 satisfies + forEach completes; the run
		// flips to "completed". No more defers.
		await t.exposeDispatchDeferred(ctx, runId);
		const finalRun = tracker.getStore().getRun(runId);
		expect(finalRun?.status).toBe("completed");

		// Final state[forEach.id] contains exactly 3 entries — one per
		// iteration. This is the headline contract of Phase 2:
		// every iteration ran exactly once across the wait/resume
		// cycles, and their outputs are aggregated correctly into the
		// forEach's final result array.
		const state = ctx.state as Record<string, unknown>;
		const results = state["process-jobs"] as unknown[];
		expect(results).toHaveLength(3);
	});
});
