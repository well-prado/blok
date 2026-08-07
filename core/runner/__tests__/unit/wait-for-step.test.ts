/**
 * PR 4 — wait.for(duration) / wait.until(date) step primitive integration.
 *
 * Tests the full path:
 *   1. RunnerSteps detects a wait step on first pass
 *   2. Sets `lastCompletedStepIndex` cursor before throwing WaitDispatchRequest
 *   3. TriggerBase catches and translates to scheduling: marks run "delayed",
 *      registers DeferredRunScheduler timer, throws DeferredDispatchSignal
 *   4. On dispatchDeferred re-entry, RunnerSteps reads the cursor and skips
 *      pre-wait steps; wait step itself flips to satisfied; post-wait steps
 *      execute fresh
 */

import type { Context } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import TriggerBase from "../../src/TriggerBase";

import { DeferredDispatchSignal } from "../../src/scheduling/DeferredDispatchSignal";
import { DeferredRunScheduler } from "../../src/scheduling/DeferredRunScheduler";
import { RunTracker } from "../../src/tracing/RunTracker";
import { applyStepOutput } from "../../src/workflow/PersistenceHelper";

class CountingStepNode extends RunnerNode {
	public runCount = 0;
	public lastResponse: unknown = null;

	constructor(name: string, response: unknown) {
		super();
		this.name = name;
		this.node = name;
		this.type = "module";
		this.active = true;
		this.lastResponse = response;
	}

	async run(ctx: Context) {
		this.runCount += 1;
		const response = { success: true, data: this.lastResponse, error: null };
		// Persist exactly the way a real node does (`Blok.run` /
		// `RuntimeAdapterNode.run` call this; `NodeBase.process` does not), so
		// `ctx.state["step-a"]` is populated for the #704 reference tests below.
		applyStepOutput(ctx, this, response);
		return response;
	}
}

// Minimal "wait" node — RunnerSteps intercepts before invoking it, so this
// is just a placeholder so the runner has something at the step index.
class WaitPlaceholderNode extends RunnerNode {
	public waitForMs?: number;
	public waitUntil?: number | string;
	/** #704 — resolved-at-dispatch halves. */
	public waitForExpr?: string;
	public waitUntilExpr?: string;

	constructor(name: string, waitForMs?: number, waitUntil?: number | string) {
		super();
		this.name = name;
		this.node = "@blokjs/wait";
		this.type = "wait";
		this.active = true;
		this.waitForMs = waitForMs;
		this.waitUntil = waitUntil;
	}

	async run() {
		// Should never actually be invoked — runner intercepts wait steps.
		return { success: true, data: { __waited__: true }, error: null };
	}
}

class TestTrigger extends TriggerBase {
	public stepA = new CountingStepNode("step-a", { value: 1 });
	public waitStep = new WaitPlaceholderNode("wait-1", undefined, undefined);
	public stepB = new CountingStepNode("step-b", { value: 2 });

	async listen(): Promise<number> {
		return 0;
	}

	override getRunner(): Runner {
		return new Runner([this.stepA, this.waitStep, this.stepB]);
	}

	configureWait(waitForMs?: number, waitUntil?: number | string): void {
		this.waitStep.waitForMs = waitForMs;
		this.waitStep.waitUntil = waitUntil;
		this.waitStep.waitForExpr = undefined;
		this.waitStep.waitUntilExpr = undefined;
		this.configuration.name = "wait-test-wf";
		this.configuration.trigger = { http: { method: "POST", path: "/wait-test" } } as never;
	}

	/** #704 — configure the resolved-at-dispatch form. */
	configureWaitExpr(opts: { forExpr?: string; untilExpr?: string }): void {
		this.configureWait(undefined, undefined);
		this.waitStep.waitForExpr = opts.forExpr;
		this.waitStep.waitUntilExpr = opts.untilExpr;
	}

	async exposeDispatchDeferred(ctx: Context, runId: string): Promise<void> {
		await this.dispatchDeferred(ctx, runId, undefined);
	}
}

describe("PR 4 — wait.for(duration) integration", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
		vi.useRealTimers();
	});

	it("first-pass wait throws DeferredDispatchSignal + marks run delayed + sets resume cursor", async () => {
		const t = new TestTrigger();
		t.configureWait(5_000); // 5s wait

		const ctx = t.createContext(undefined, "/wait-test", "wait-run-1");

		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		// Step A ran once (pre-wait), step B did NOT run (post-wait, deferred).
		expect(t.stepA.runCount).toBe(1);
		expect(t.stepB.runCount).toBe(0);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const tracker = RunTracker.getInstance();
		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("delayed");
		// Resume cursor: step A is at index 0, so cursor = 0 (last completed = 0).
		// Wait is at index 1, so cursor = 1 - 1 = 0.
		expect(run?.lastCompletedStepIndex).toBe(0);
		expect(run?.scheduledAt).toBeDefined();
	});

	it("dispatchDeferred re-entry skips pre-wait steps and executes post-wait steps", async () => {
		const t = new TestTrigger();
		t.configureWait(5_000);

		const ctx = t.createContext(undefined, "/wait-test", "wait-run-2");

		// First pass — schedules + throws.
		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);
		expect(t.stepA.runCount).toBe(1);
		expect(t.stepB.runCount).toBe(0);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const tracker = RunTracker.getInstance();

		// Simulate timer fire — call dispatchDeferred manually.
		await t.exposeDispatchDeferred(ctx, runId);

		// Step A should NOT have re-run (resume skipped).
		// Step B should have run (post-wait, fresh execution).
		expect(t.stepA.runCount).toBe(1); // unchanged
		expect(t.stepB.runCount).toBe(1); // new

		// Run completed normally.
		const finalRun = tracker.getStore().getRun(runId);
		expect(finalRun?.status).toBe("completed");
	});

	it("wait.for(0) is a no-op (immediate satisfaction, no scheduling)", async () => {
		const t = new TestTrigger();
		t.configureWait(0); // immediate

		const ctx = t.createContext(undefined, "/wait-test", "wait-run-3");

		// Should NOT throw — wait deadline is now/past, runner advances inline.
		await t.run(ctx);

		expect(t.stepA.runCount).toBe(1);
		expect(t.stepB.runCount).toBe(1);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const finalRun = RunTracker.getInstance().getStore().getRun(runId);
		expect(finalRun?.status).toBe("completed");
	});

	it("wait.until(<past date>) is a no-op (deadline already passed)", async () => {
		const t = new TestTrigger();
		t.configureWait(undefined, Date.now() - 60_000); // 1min ago

		const ctx = t.createContext(undefined, "/wait-test", "wait-run-4");

		await t.run(ctx);

		expect(t.stepA.runCount).toBe(1);
		expect(t.stepB.runCount).toBe(1);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		expect(RunTracker.getInstance().getStore().getRun(runId)?.status).toBe("completed");
	});

	it("wait.until(<future date>) schedules + resumes on dispatchDeferred", async () => {
		const t = new TestTrigger();
		const futureMs = Date.now() + 5_000;
		t.configureWait(undefined, futureMs);

		const ctx = t.createContext(undefined, "/wait-test", "wait-run-5");

		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const run = RunTracker.getInstance().getStore().getRun(runId);
		expect(run?.scheduledAt).toBe(futureMs);
		expect(run?.status).toBe("delayed");

		// Resume.
		await t.exposeDispatchDeferred(ctx, runId);

		expect(t.stepB.runCount).toBe(1);
		expect(RunTracker.getInstance().getStore().getRun(runId)?.status).toBe("completed");
	});

	it("DeferredRunScheduler has a registered timer for the wait deadline", async () => {
		const t = new TestTrigger();
		t.configureWait(60_000);

		const ctx = t.createContext(undefined, "/wait-test", "wait-run-6");
		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		expect(DeferredRunScheduler.getInstance().has(runId)).toBe(true);
	});

	// Review fix-up · BUG-2. A malformed `wait.until` string used to fall
	// through to `Date.now()` (immediate no-op). The original review caught
	// this — silent failures are the worst kind. Now: throws a helpful
	// error so the trace + Studio's error surface show the failure.
	it("wait.until(<unparseable string>) throws a helpful error instead of silently completing", async () => {
		const t = new TestTrigger();
		t.configureWait(undefined, "tommorrow"); // intentional typo

		const ctx = t.createContext(undefined, "/wait-test", "wait-run-7");

		// The thrown error gets wrapped by the runner's error handling, but
		// the message must surface the typo + parsing guidance.
		await expect(t.run(ctx)).rejects.toThrow(/wait\.until.*cannot parse.*tommorrow/i);

		// The pre-wait step ran (the failure happened AT the wait step,
		// not before it).
		expect(t.stepA.runCount).toBe(1);
		// The post-wait step never ran.
		expect(t.stepB.runCount).toBe(0);
	});
});

/**
 * #704 — dynamic delays. `wait.for` / `wait.until` written as a reference are
 * carried as a `js/` wire string by `normalizeWaitStep` and resolved against
 * the LIVE ctx here, at the moment the wait step executes. `step-a` runs
 * before the wait, so its output is in `ctx.state` by then.
 */
describe("#704 — wait.for / wait.until resolved at dispatch time", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
	});

	it("wait.for resolves a ref to a NUMBER of milliseconds", async () => {
		const t = new TestTrigger();
		t.stepA.lastResponse = { delayMs: 5_000 };
		t.configureWaitExpr({ forExpr: 'js/ctx.state["step-a"].delayMs' });

		const ctx = t.createContext(undefined, "/wait-test", "wait-expr-1");
		const before = Date.now();
		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const run = RunTracker.getInstance().getStore().getRun(runId);
		expect(run?.status).toBe("delayed");
		// The deadline came from state, not from the workflow document.
		expect(run?.scheduledAt).toBeGreaterThanOrEqual(before + 5_000);
		expect(run?.scheduledAt).toBeLessThan(before + 5_000 + 2_000);
		expect(t.stepB.runCount).toBe(0);

		// …and the durable-scheduler + re-entry path still completes the run.
		await t.exposeDispatchDeferred(ctx, runId);
		expect(t.stepA.runCount).toBe(1);
		expect(t.stepB.runCount).toBe(1);
		expect(RunTracker.getInstance().getStore().getRun(runId)?.status).toBe("completed");
	});

	it("wait.for resolves a ref to a DURATION STRING", async () => {
		const t = new TestTrigger();
		t.stepA.lastResponse = { backoff: "5s" };
		t.configureWaitExpr({ forExpr: 'js/ctx.state["step-a"].backoff' });

		const ctx = t.createContext(undefined, "/wait-test", "wait-expr-2");
		const before = Date.now();
		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const run = RunTracker.getInstance().getStore().getRun(runId);
		expect(run?.scheduledAt).toBeGreaterThanOrEqual(before + 5_000);
		expect(DeferredRunScheduler.getInstance().has(runId)).toBe(true);
	});

	it("wait.until resolves a ref to an absolute deadline", async () => {
		const t = new TestTrigger();
		const futureMs = Date.now() + 5_000;
		t.stepA.lastResponse = { scheduledAt: futureMs };
		t.configureWaitExpr({ untilExpr: 'js/ctx.state["step-a"].scheduledAt' });

		const ctx = t.createContext(undefined, "/wait-test", "wait-expr-3");
		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		expect(RunTracker.getInstance().getStore().getRun(runId)?.scheduledAt).toBe(futureMs);

		await t.exposeDispatchDeferred(ctx, runId);
		expect(t.stepB.runCount).toBe(1);
	});

	it("a resolved delay already in the past satisfies inline (no scheduling)", async () => {
		const t = new TestTrigger();
		t.stepA.lastResponse = { delayMs: 0 };
		t.configureWaitExpr({ forExpr: 'js/ctx.state["step-a"].delayMs' });

		const ctx = t.createContext(undefined, "/wait-test", "wait-expr-4");
		await t.run(ctx);

		expect(t.stepB.runCount).toBe(1);
		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		expect(RunTracker.getInstance().getStore().getRun(runId)?.status).toBe("completed");
	});

	it("an UNRESOLVABLE ref fails the step with an error naming the step and the field", async () => {
		const t = new TestTrigger();
		t.configureWaitExpr({ forExpr: 'js/ctx.state["never-ran"].delayMs' });

		const ctx = t.createContext(undefined, "/wait-test", "wait-expr-5");

		await expect(t.run(ctx)).rejects.toThrow(/wait\.for on step "wait-1".*never-ran/s);
		// The failure is AT the wait step: the pre-wait step ran, the post-wait
		// step did not, and nothing was scheduled.
		expect(t.stepA.runCount).toBe(1);
		expect(t.stepB.runCount).toBe(0);
		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		expect(DeferredRunScheduler.getInstance().has(runId)).toBe(false);
	});

	it("a ref that resolves to a NON-duration names the step, the field and the value", async () => {
		const t = new TestTrigger();
		t.stepA.lastResponse = { delayMs: "half an hour" };
		t.configureWaitExpr({ forExpr: 'js/ctx.state["step-a"].delayMs' });

		const ctx = t.createContext(undefined, "/wait-test", "wait-expr-6");

		await expect(t.run(ctx)).rejects.toThrow(/wait\.for on step "wait-1".*half an hour/s);
		expect(t.stepB.runCount).toBe(0);
	});

	// Reload safety. `ctx.state` is restored from a BEST-EFFORT snapshot: the
	// runner skips it when it fails to serialize or exceeds
	// BLOK_STATE_SNAPSHOT_MAX_BYTES. Re-resolving the reference on re-entry
	// would then throw and kill a run at a wait it had already served, so the
	// runner must not re-resolve — the wait is already satisfied.
	it("re-entry does NOT re-resolve the reference (survives a lost state snapshot)", async () => {
		const t = new TestTrigger();
		t.stepA.lastResponse = { delayMs: 5_000 };
		t.configureWaitExpr({ forExpr: 'js/ctx.state["step-a"].delayMs' });

		const ctx = t.createContext(undefined, "/wait-test", "wait-expr-7");
		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		// Simulate the cross-process restore that could not rehydrate state.
		RunTracker.getInstance().getStore().updateRun(runId, { stateSnapshot: undefined });
		const state = ctx.state as Record<string, unknown>;
		for (const key of Object.keys(state)) delete state[key];

		await t.exposeDispatchDeferred(ctx, runId);

		expect(t.stepB.runCount).toBe(1);
		expect(RunTracker.getInstance().getStore().getRun(runId)?.status).toBe("completed");
	});
});
