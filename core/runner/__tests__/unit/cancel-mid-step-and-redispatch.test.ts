/**
 * PR 1 follow-up · H1 + H2 integration tests.
 *
 * H1 — HTTP cancel mid-step. Operator-driven cancel of a `running` run.
 *      The in-flight step must observe `ctx.signal.aborted` and the
 *      runner must throw `RunCancelledError` between steps.
 *
 * H2 — Cancel-after-redispatch (REVIEW.md A2). A run that came from
 *      `delayed` / `debounced` / `queued` state and then resumed must be
 *      cancellable just like any `running` run. The first-pass `finally`
 *      unregisters the AbortController; without the A2 fix in
 *      TriggerBase.run's reentry branch, abortRunningRun's controller
 *      lookup would fail silently and the in-flight step would never
 *      see ctx.signal.aborted.
 *
 * These tests exercise TriggerBase.run end-to-end with a custom step
 * node that loops on `ctx.signal.aborted`. They cover the full path the
 * unit-level abortRunningRun test stubs out.
 */

import type { Context } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunCancelledError, isRunCancelledError } from "../../src/RunCancelledError";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import TriggerBase from "../../src/TriggerBase";
import { DeferredDispatchSignal } from "../../src/scheduling/DeferredDispatchSignal";
import { DeferredRunScheduler } from "../../src/scheduling/DeferredRunScheduler";
import { RunTracker } from "../../src/tracing/RunTracker";

/**
 * Minimal trigger that exposes `dispatchDeferred` so tests can simulate
 * the timer-fire re-entry without waiting on a real setTimeout.
 */
class TestTrigger extends TriggerBase {
	public stepStartedSignal = new ManualEvent();
	public allowFinishSignal = new ManualEvent();
	public stepNode: LoopingStepNode = new LoopingStepNode("loop");

	async listen(): Promise<number> {
		return 0;
	}

	override getRunner(): Runner {
		return new Runner([this.stepNode]);
	}

	setTriggerConfig(cfg: Record<string, unknown>): void {
		this.configuration.trigger = cfg as never;
		this.configuration.name = "test-wf";
		this.configuration.steps = [this.stepNode];
	}

	async exposeDispatchDeferred(ctx: Context, runId: string, expiresAt?: number): Promise<void> {
		await this.dispatchDeferred(ctx, runId, expiresAt);
	}
}

/** Manual one-shot promise used to coordinate test phases. */
class ManualEvent {
	private _resolved = false;
	private resolvers: Array<() => void> = [];

	wait(): Promise<void> {
		if (this._resolved) return Promise.resolve();
		return new Promise<void>((resolve) => this.resolvers.push(resolve));
	}

	signal(): void {
		this._resolved = true;
		for (const r of this.resolvers) r();
		this.resolvers = [];
	}

	get fired(): boolean {
		return this._resolved;
	}
}

/**
 * Looping step that pings `stepStartedSignal` then polls `ctx.signal.aborted`
 * (or `allowFinishSignal`) every 5ms. Used to assert cooperative cancellation.
 */
class LoopingStepNode extends RunnerNode {
	public stepStartedSignal: ManualEvent | null = null;
	public allowFinishSignal: ManualEvent | null = null;

	constructor(name: string) {
		super();
		this.name = name;
		this.node = name;
		this.type = "module";
		this.active = true;
	}

	async run(ctx: Context) {
		this.stepStartedSignal?.signal();
		// Poll every 5ms; consult ctx.signal.aborted on each iteration.
		while (!ctx.signal?.aborted && !this.allowFinishSignal?.fired) {
			await new Promise((r) => setTimeout(r, 5));
		}
		if (ctx.signal?.aborted) {
			// Throw an error similar to what an abort-aware fetch() would.
			throw new Error("aborted by signal");
		}
		return { success: true, data: { ok: true }, error: null };
	}
}

function makeCtx(): Context {
	const ctx = {
		id: "req-1",
		workflow_name: "test-wf",
		workflow_path: "/test.ts",
		request: { body: {}, headers: {}, params: {}, query: {}, method: "POST", path: "/test" },
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} },
		config: {},
		vars: {},
		env: {},
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;
	Object.defineProperty(ctx, "req", { get: () => ctx.request, enumerable: true, configurable: true });
	Object.defineProperty(ctx, "prev", { get: () => ctx.response, enumerable: true, configurable: true });
	return ctx;
}

describe("PR 1 H1 — HTTP cancel mid-step (integration)", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
	});

	it("cancel during execution aborts the in-flight step and stays cancelled", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({ http: { method: "POST", path: "/x" } });
		t.stepNode.stepStartedSignal = t.stepStartedSignal;
		t.stepNode.allowFinishSignal = t.allowFinishSignal;

		// We need access to ctx so we can find the registered AbortController.
		// TriggerBase creates ctx internally — instead, build ctx ourselves and
		// run with createContext-equivalent shape so the ctx.signal flow works.
		const ctx = t.createContext(undefined, "/x", "test-run-id");

		// Kick off the run in the background.
		const runPromise = t.run(ctx);

		// Wait for the looping step to start.
		await t.stepStartedSignal.wait();

		// Find the run id (TriggerBase set it on the ctx).
		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		expect(runId).toBeDefined();

		// Issue the cancel — this fires the AbortController AND flips status.
		const tracker = RunTracker.getInstance();
		const cancelled = tracker.abortRunningRun(runId);
		expect(cancelled).toBe(true);
		expect(ctx.signal?.aborted).toBe(true);

		// The looping step's next iteration sees signal.aborted and throws.
		// TriggerBase.run's catch sees the error (not a DeferredDispatchSignal /
		// ConcurrencyLimitError / RunCancelledError) and would normally call
		// failRun. The terminal-status guard (Phase 1) prevents the cancelled
		// status from being overwritten.
		await expect(runPromise).rejects.toThrow(/aborted/);

		// Run stays cancelled.
		const finalRun = tracker.getStore().getRun(runId);
		expect(finalRun?.status).toBe("cancelled");
	});

	it("cancel API throws RunCancelledError between steps when signal.aborted is set BEFORE the next step runs", async () => {
		// Verifies the RunnerSteps between-step abort check fires the
		// dedicated RunCancelledError, which TriggerBase catches without
		// re-flipping status.
		class MultiStepTrigger extends TriggerBase {
			public sawCancellation = false;
			async listen(): Promise<number> {
				return 0;
			}
			override getRunner(): Runner {
				const stepA = new InstantStepNode("a");
				const stepB = new InstantStepNode("b");
				return new Runner([stepA, stepB]);
			}
		}
		class InstantStepNode extends RunnerNode {
			constructor(name: string) {
				super();
				this.name = name;
				this.node = name;
				this.type = "module";
				this.active = true;
			}
			async run() {
				return { success: true, data: { ok: true }, error: null };
			}
		}

		const t = new MultiStepTrigger();
		t.configuration.trigger = { http: { method: "POST", path: "/x" } } as never;
		t.configuration.name = "test-multi";
		const ctx = t.createContext(undefined, "/x", "multi-run");

		// Pre-abort the ctx's signal BEFORE running. The first
		// between-step check (i=0, before any step) sees aborted=true and
		// throws RunCancelledError immediately.
		const privateSlot = ctx._PRIVATE_ as { abortController?: AbortController };
		privateSlot.abortController?.abort();

		try {
			await t.run(ctx);
			throw new Error("expected RunCancelledError");
		} catch (err) {
			expect(isRunCancelledError(err)).toBe(true);
		}
	});
});

describe("PR 1 H2 — cancel-after-redispatch (REVIEW.md A2)", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
	});

	it("re-registers the AbortController on dispatchDeferred re-entry", async () => {
		// This is the headline A2 regression test. Mechanics:
		//  1. Run a workflow with delay → first pass throws DeferredDispatchSignal,
		//     finally unregisters the controller.
		//  2. Manually invoke dispatchDeferred to simulate timer fire. The
		//     reentry branch (PR 1 A2 fix) re-registers the controller.
		//  3. While the re-entered run is mid-step, call abortRunningRun.
		//  4. Assert ctx.signal.aborted = true (the controller was found and fired).
		//  5. Assert run status stays "cancelled" (terminal-status guard).

		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", path: "/x", delay: 1000 },
		});
		t.stepNode.stepStartedSignal = t.stepStartedSignal;
		t.stepNode.allowFinishSignal = t.allowFinishSignal;

		const ctx = t.createContext(undefined, "/x", "delay-run");

		// First-pass run: scheduling gate throws DeferredDispatchSignal.
		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		expect(runId).toBeDefined();

		const tracker = RunTracker.getInstance();
		expect(tracker.getStore().getRun(runId)?.status).toBe("delayed");

		// AbortController should have been unregistered by the first-pass finally.
		// The controller object itself is still on ctx._PRIVATE_, but the
		// tracker's lookup map is empty.
		// Verify: a synthetic abortRunningRun BEFORE re-entry would not fire
		// the controller (because it's unregistered) but would still flip
		// status if the run were "running" — at this point status is
		// "delayed" so abortRunningRun returns false.
		expect(tracker.abortRunningRun(runId)).toBe(false);

		// Now simulate the timer firing — call dispatchDeferred manually.
		// The PR 1 A2 fix re-registers the controller on reentry.
		const reentryPromise = t.exposeDispatchDeferred(ctx, runId);

		// Wait for the looping step to start running (post-reentry).
		await t.stepStartedSignal.wait();

		// Now the run is "running" via re-entry. The controller should be
		// re-registered. Cancel API fires it.
		const cancelled = tracker.abortRunningRun(runId);
		expect(cancelled).toBe(true);
		expect(ctx.signal?.aborted).toBe(true);

		// dispatchDeferred swallows the error from the re-entered run's catch.
		await reentryPromise;

		// Status stays "cancelled" — the terminal-status guard prevents
		// completeRun / failRun from overwriting it.
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});
});
