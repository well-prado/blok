/**
 * v0.6 wait-inside-primitives Phase 3 — Loop with wait inside the
 * iteration body. Round-trips a while-loop where each iteration's body
 * has a wait, simulating timer fires via `dispatchDeferred` between
 * defer cycles. Verifies:
 *
 *   - Wait inside iteration N fires `WaitDispatchRequest` and the
 *     workflow defers (DeferredDispatchSignal thrown by TriggerBase).
 *   - The loop's NodeRun has `iteration_context` written with
 *     `{iteration: N, innerStepIndex, completedResults: []}` — Loop
 *     doesn't aggregate results so completedResults is empty.
 *   - On dispatchDeferred re-entry, LoopNode reads the resume hint
 *     from `ctx._blokIterationResume` and starts at iteration N
 *     (NOT 0 — re-running prior iterations would re-execute their
 *     side effects).
 *   - For the resumed iteration, the inner runner picks up
 *     `_blokInnerResumeIndex` and skips the pre-wait steps.
 *   - After the while-condition terminates, the run flips to
 *     `completed` and state mutations from every iteration are
 *     visible (the loop counter advanced once per iteration).
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

/**
 * Minimal state-mutation helper. Increments `ctx.state[<key>]` by
 * `<delta>` (or initialises to `delta` when absent). Direct mutation
 * bypasses the `applyStepOutput` path — that helper needs the runtime
 * step model (with its own `name` / `as` fields), but a RunnerNode
 * subclass only sees the node singleton. Production workflows use
 * `@blokjs/expr` + the step's `as` field; the test fixture sidesteps
 * that machinery to keep the assertion surface small.
 *
 * State mutations carry forward across iterations because LoopNode
 * shares state by reference between parent and child ctx (no deep
 * clone), so child mutations are visible to subsequent iterations.
 */
class StateBumpNode extends RunnerNode {
	constructor() {
		super();
		this.name = "state-bump";
		this.node = "state-bump";
		this.type = "module";
		this.active = true;
	}
	async run(ctx: Context): Promise<ResponseContext> {
		const opts = ((ctx.config as Record<string, unknown> | undefined)?.[this.name] ?? {}) as {
			inputs?: { key?: string; delta?: number };
		};
		const key = opts.inputs?.key ?? "counter";
		const delta = typeof opts.inputs?.delta === "number" ? opts.inputs.delta : 1;
		const state = (ctx.state ?? {}) as Record<string, unknown>;
		const current = typeof state[key] === "number" ? (state[key] as number) : 0;
		const next = current + delta;
		state[key] = next;
		// Return an envelope-shaped object (not a primitive) — RunnerSteps
		// assigns `ctx.response.contentType` between top-level steps, which
		// throws on a primitive ctx.response. Matches the production
		// convention that step `data` is an object.
		return { success: true, data: { key, value: next }, error: null };
	}
}

/**
 * TestTrigger that hosts a Configuration loaded with a loop + wait
 * workflow. The loop runs while `state.attempt < 3` — three iterations.
 * Each iteration: increment `state.attempt` via expr, then wait 50ms.
 * Each iteration's wait throws `WaitDispatchRequest` → the trigger
 * boundary converts it to a `DeferredDispatchSignal`; the test calls
 * `exposeDispatchDeferred` between cycles to simulate the timer firing.
 */
class LoopWaitTestTrigger extends TriggerBase {
	private cachedRunner: Runner | null = null;

	async setup(): Promise<void> {
		const helpers: Record<string, RunnerNode> = {
			"state-bump": new StateBumpNode(),
		};
		const globalOptions = {
			nodes: {
				getNode: (name: string): RunnerNode | null => helpers[name] ?? null,
			},
		} as unknown as GlobalOptions;
		const cfg = new Configuration();
		const wf = {
			name: "phase3-loop-wait",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/" } },
			steps: [
				{
					id: "init",
					use: "state-bump",
					type: "module",
					inputs: { key: "attempt", delta: 0 },
				},
				{
					id: "poll-loop",
					loop: {
						while: "(ctx.state.attempt ?? 0) < 3",
						maxIterations: 10,
						do: [
							{
								id: "advance",
								use: "state-bump",
								type: "module",
								inputs: { key: "attempt", delta: 1 },
							},
							{ id: "throttle", wait: { for: 50 } },
						],
					},
				},
			],
		};
		await cfg.init("phase3-loop-wait", globalOptions, wf);
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

describe("v0.6 Phase 3 · Loop with wait inside iteration body", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
		vi.useRealTimers();
	});

	it("first defer writes iteration_context to loop NodeRun (iteration: 0, innerStepIndex: 1, completedResults: [])", async () => {
		const t = new LoopWaitTestTrigger();
		await t.setup();
		const ctx = t.createContext(undefined, "/phase3-loop-wait", "first-defer");
		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const tracker = RunTracker.getInstance();
		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("delayed");
		// state_snapshot was written even on a nested wait so cross-process
		// recovery has full ctx.state to rehydrate (Phase 1 contract).
		expect(run?.stateSnapshot).toBeDefined();

		// Phase 3 headline contract — the loop NodeRun has
		// iteration_context set with the first iteration's cursor.
		const nodeRuns = tracker.getStore().getNodeRuns(runId);
		const loopRun = nodeRuns.find((n) => n.iterationContext !== undefined);
		expect(loopRun).toBeDefined();
		expect(loopRun?.iterationContext).toEqual({
			iteration: 0,
			innerStepIndex: 1, // wait is at index 1; advance is at index 0
			completedResults: [], // Loop doesn't aggregate results
		});
	});

	it("rounds-trips 3 iterations through dispatchDeferred — final state.attempt reaches 3", async () => {
		const t = new LoopWaitTestTrigger();
		await t.setup();
		const ctx = t.createContext(undefined, "/phase3-loop-wait", "round-trip");

		// Iteration 0 wait fires.
		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);
		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const tracker = RunTracker.getInstance();

		// Helper — each dispatchDeferred re-run creates a NEW loop NodeRun
		// (RunnerSteps.tracker.startNode is called fresh per invocation).
		// Pick latest by startedAt — same heuristic TriggerBase uses to
		// rehydrate `ctx._blokIterationResume`.
		type Cursor = { iteration: number; innerStepIndex: number; completedResults: unknown[] };
		const latestLoopContext = (): Cursor | undefined => {
			// Mirrors TriggerBase.run's rehydrate selection — sort by
			// startedAt descending, with array insertion order as the
			// stable secondary key for ms-collision (sub-second wait
			// deadlines pack multiple NodeRuns into the same millisecond).
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
		let cursor = latestLoopContext();
		expect(cursor?.iteration).toBe(1);
		expect(cursor?.innerStepIndex).toBe(1);
		// Loop's cursor always has empty completedResults — it doesn't
		// accumulate iteration results (returns the LAST iteration's
		// output, not all of them).
		expect(cursor?.completedResults).toEqual([]);

		// Re-entry — iteration 1 satisfies + iteration 2 wait fires.
		await t.exposeDispatchDeferred(ctx, runId);
		cursor = latestLoopContext();
		expect(cursor?.iteration).toBe(2);
		expect(cursor?.completedResults).toEqual([]);

		// Re-entry — iteration 2 satisfies + while-condition becomes
		// false (state.attempt === 3) → loop exits, run flips to
		// `completed`. No more defers.
		await t.exposeDispatchDeferred(ctx, runId);
		const finalRun = tracker.getStore().getRun(runId);
		expect(finalRun?.status).toBe("completed");

		// Loop's state mutations carry forward iteration → iteration.
		// state.attempt was 0, then 1, 2, 3 across the three iterations.
		// On final completion the value is 3.
		const state = ctx.state as Record<string, unknown>;
		expect(state.attempt).toBe(3);
	});

	it("loop counter advances exactly once per iteration across defer cycles (no double-execution on resume)", async () => {
		const t = new LoopWaitTestTrigger();
		await t.setup();
		const ctx = t.createContext(undefined, "/phase3-loop-wait", "no-double-exec");

		// Fresh run — wait fires after iteration 0's advance.
		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);
		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const tracker = RunTracker.getInstance();

		// After first wait throw, state.attempt should be 1 (iteration 0
		// ran advance, then deferred at the wait).
		expect((ctx.state as Record<string, unknown>).attempt).toBe(1);

		// Re-entry — iteration 0 wait satisfies, control returns to the
		// loop body, iteration 1 starts, advances state.attempt → 2,
		// then defers at the wait. If the resume incorrectly re-ran
		// iteration 0 from step 0, state.attempt would be 3 (1 + 1 + 1)
		// instead of 2.
		await t.exposeDispatchDeferred(ctx, runId);
		expect((ctx.state as Record<string, unknown>).attempt).toBe(2);

		// Same proof for iteration 2.
		await t.exposeDispatchDeferred(ctx, runId);
		expect((ctx.state as Record<string, unknown>).attempt).toBe(3);

		// Drain the final resume so the test cleanly completes.
		await t.exposeDispatchDeferred(ctx, runId);
		const finalRun = tracker.getStore().getRun(runId);
		expect(finalRun?.status).toBe("completed");
	});
});
