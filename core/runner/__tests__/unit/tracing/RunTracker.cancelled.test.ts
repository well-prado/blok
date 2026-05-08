import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunTracker } from "../../../src/tracing/RunTracker";

describe("RunTracker — cancelRun (Tier 2 polish)", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
	});

	function startBaseRun(workflowName = "wf"): string {
		const tracker = RunTracker.getInstance();
		const run = tracker.startRun({
			workflowName,
			workflowPath: "/p",
			triggerType: "http",
			triggerSummary: "POST /test",
			nodeCount: 1,
		});
		return run.id;
	}

	it("cancels a delayed run and emits RUN_CANCELLED", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.markRunDelayed(runId, { scheduledAt: Date.now() + 60_000, delayMs: 60_000 });

		const events: Array<{ type: string; payload?: unknown }> = [];
		const handler = (e: { type: string; payload?: unknown }) => events.push(e);
		tracker.on("event", handler);

		const ok = tracker.cancelRun(runId);
		tracker.off("event", handler);

		expect(ok).toBe(true);
		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("cancelled");
		expect(run?.finishedAt).toBeDefined();
		expect(run?.durationMs).toBeDefined();

		const cancelledEvent = events.find((e) => e.type === "RUN_CANCELLED");
		expect(cancelledEvent).toBeDefined();
		const payload = cancelledEvent?.payload as { previousStatus: string };
		expect(payload.previousStatus).toBe("delayed");
	});

	it("cancels a queued run", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.markRunQueued(runId, {
			concurrencyKey: "k",
			concurrencyLimit: 1,
			currentInFlight: 1,
			scheduledAt: Date.now() + 1000,
		});

		const ok = tracker.cancelRun(runId);
		expect(ok).toBe(true);
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});

	it("cancels a debounced run", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.markRunDebounced(runId, {
			debounceKey: "k",
			mode: "trailing",
			pingCount: 1,
			scheduledAt: Date.now() + 500,
		});

		const ok = tracker.cancelRun(runId);
		expect(ok).toBe(true);
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});

	it("accepts cancellation for a running run (Tier 2 follow-up: cooperative AbortSignal)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		// Run is `running` immediately after startRun. Tier 2 follow-up
		// extended cancelRun to accept "running" so abortRunningRun can
		// flip status before the in-flight step's RunCancelledError throws.

		const ok = tracker.cancelRun(runId);
		expect(ok).toBe(true);
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});

	it("rejects cancellation for a completed run", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.completeRun(runId, { ok: true });

		const ok = tracker.cancelRun(runId);
		expect(ok).toBe(false);
		expect(tracker.getStore().getRun(runId)?.status).toBe("completed");
	});

	it("returns false for unknown runId", () => {
		const tracker = RunTracker.getInstance();
		expect(tracker.cancelRun("ghost")).toBe(false);
	});

	it("re-cancelling a cancelled run is idempotent (returns false the second time)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.markRunDelayed(runId, { scheduledAt: Date.now() + 60_000, delayMs: 60_000 });

		expect(tracker.cancelRun(runId)).toBe(true);
		expect(tracker.cancelRun(runId)).toBe(false);
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});
});

describe("RunTracker — terminal status guards (PR 1 follow-up)", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
	});

	function startBaseRun(workflowName = "wf"): string {
		const tracker = RunTracker.getInstance();
		const run = tracker.startRun({
			workflowName,
			workflowPath: "/p",
			triggerType: "http",
			triggerSummary: "POST /test",
			nodeCount: 1,
		});
		return run.id;
	}

	it("completeRun is a no-op on a cancelled run (defense in depth for A2)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.cancelRun(runId);
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");

		// Late-arriving completeRun (e.g., from a runner that didn't see
		// the cancel) must not flip status back.
		tracker.completeRun(runId, { result: "late" });
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});

	it("failRun is a no-op on a cancelled run (defense in depth for A2)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.cancelRun(runId);
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");

		tracker.failRun(runId, new Error("late failure"));
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});

	it("completeRun preserves expired status when called late", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.markRunExpired(runId, { expiresAt: Date.now(), expiredAt: Date.now() });
		expect(tracker.getStore().getRun(runId)?.status).toBe("expired");

		tracker.completeRun(runId);
		expect(tracker.getStore().getRun(runId)?.status).toBe("expired");
	});

	it("failRun preserves throttled status when called late", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.markRunThrottled(runId, {
			concurrencyKey: "k",
			concurrencyLimit: 1,
			currentInFlight: 1,
		});
		expect(tracker.getStore().getRun(runId)?.status).toBe("throttled");

		tracker.failRun(runId, new Error("late"));
		expect(tracker.getStore().getRun(runId)?.status).toBe("throttled");
	});
});

describe("RunTracker — abortRunningRun (Tier 2 follow-up: cooperative AbortSignal)", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
	});

	function startRun(): string {
		return RunTracker.getInstance().startRun({
			workflowName: "wf",
			workflowPath: "/p",
			triggerType: "http",
			triggerSummary: "POST /test",
			nodeCount: 1,
		}).id;
	}

	it("fires the registered AbortController and flips status to cancelled", () => {
		const tracker = RunTracker.getInstance();
		const runId = startRun();
		const controller = new AbortController();
		tracker.registerAbortController(runId, controller);

		expect(controller.signal.aborted).toBe(false);
		const result = tracker.abortRunningRun(runId);

		expect(result).toBe(true);
		expect(controller.signal.aborted).toBe(true);
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});

	it("returns false when the run is not in 'running' status", () => {
		const tracker = RunTracker.getInstance();
		const runId = startRun();
		tracker.completeRun(runId);

		const controller = new AbortController();
		tracker.registerAbortController(runId, controller);
		expect(tracker.abortRunningRun(runId)).toBe(false);
		// Controller was NOT aborted because the run wasn't running.
		expect(controller.signal.aborted).toBe(false);
	});

	it("returns false for unknown runId", () => {
		expect(RunTracker.getInstance().abortRunningRun("ghost")).toBe(false);
	});

	it("aborts even when no controller is registered (still flips status)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startRun();
		// No registerAbortController call.
		const result = tracker.abortRunningRun(runId);
		// Status flips because cancelRun accepts running; the abort itself is a no-op.
		expect(result).toBe(true);
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});

	it("unregisterAbortController removes the controller; subsequent abort doesn't fire it", () => {
		const tracker = RunTracker.getInstance();
		const runId = startRun();
		const controller = new AbortController();
		tracker.registerAbortController(runId, controller);
		tracker.unregisterAbortController(runId);

		tracker.abortRunningRun(runId);
		expect(controller.signal.aborted).toBe(false);
	});
});

describe("RunTracker — startNode wait field (Tier 2 #4 indicator)", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
	});

	function startBaseRun(): string {
		const tracker = RunTracker.getInstance();
		const run = tracker.startRun({
			workflowName: "wf",
			workflowPath: "/p",
			triggerType: "http",
			triggerSummary: "POST /test",
			nodeCount: 1,
		});
		return run.id;
	}

	it("captures wait:true on the NodeRun (sync sub-workflow)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		const node = tracker.startNode(runId, {
			nodeName: "child",
			nodeType: "subworkflow",
			depth: 0,
			stepIndex: 0,
			wait: true,
		});
		const stored = tracker.getStore().getNodeRun(node.id);
		expect(stored?.wait).toBe(true);
	});

	it("captures wait:false on the NodeRun (async sub-workflow)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		const node = tracker.startNode(runId, {
			nodeName: "fire-and-forget",
			nodeType: "subworkflow",
			depth: 0,
			stepIndex: 0,
			wait: false,
		});
		const stored = tracker.getStore().getNodeRun(node.id);
		expect(stored?.wait).toBe(false);
	});

	it("leaves wait undefined for non-subworkflow nodes", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		const node = tracker.startNode(runId, {
			nodeName: "regular-step",
			nodeType: "module",
			depth: 0,
			stepIndex: 0,
		});
		const stored = tracker.getStore().getNodeRun(node.id);
		expect(stored?.wait).toBeUndefined();
	});
});

describe("RunTracker — cancelRun cascade (PR 5 G1)", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
	});

	function startBaseRun(workflowName = "wf", parentRunId?: string): string {
		const tracker = RunTracker.getInstance();
		const run = tracker.startRun({
			workflowName,
			workflowPath: "/p",
			triggerType: parentRunId ? "subworkflow" : "http",
			triggerSummary: "POST /test",
			nodeCount: 1,
			parentRunId,
		});
		return run.id;
	}

	it("cascades cancellation to in-flight async children (parent + 3 children)", () => {
		const tracker = RunTracker.getInstance();
		const parentId = startBaseRun();
		// Three async (wait:false) children, each in a different cancellable state.
		const childRunningId = startBaseRun("child-running", parentId);
		const childDelayedId = startBaseRun("child-delayed", parentId);
		tracker.markRunDelayed(childDelayedId, { scheduledAt: Date.now() + 60_000, delayMs: 60_000 });
		const childQueuedId = startBaseRun("child-queued", parentId);
		tracker.markRunQueued(childQueuedId, {
			concurrencyKey: "k",
			concurrencyLimit: 1,
			currentInFlight: 1,
			scheduledAt: Date.now() + 1_000,
		});

		const ok = tracker.cancelRun(parentId);
		expect(ok).toBe(true);

		const store = tracker.getStore();
		expect(store.getRun(parentId)?.status).toBe("cancelled");
		expect(store.getRun(childRunningId)?.status).toBe("cancelled");
		expect(store.getRun(childDelayedId)?.status).toBe("cancelled");
		expect(store.getRun(childQueuedId)?.status).toBe("cancelled");
	});

	it("preserves children already in terminal state (cancel respects status guard)", () => {
		const tracker = RunTracker.getInstance();
		const parentId = startBaseRun();

		const completedChild = startBaseRun("child-done", parentId);
		tracker.completeRun(completedChild, { ok: true });

		const failedChild = startBaseRun("child-fail", parentId);
		tracker.failRun(failedChild, new Error("boom"));

		const cancellableChild = startBaseRun("child-delayed", parentId);
		tracker.markRunDelayed(cancellableChild, { scheduledAt: Date.now() + 60_000, delayMs: 60_000 });

		tracker.cancelRun(parentId);

		const store = tracker.getStore();
		expect(store.getRun(parentId)?.status).toBe("cancelled");
		// Terminal children stay terminal — cascade only touches cancellable states.
		expect(store.getRun(completedChild)?.status).toBe("completed");
		expect(store.getRun(failedChild)?.status).toBe("failed");
		// The cancellable sibling still gets cascaded.
		expect(store.getRun(cancellableChild)?.status).toBe("cancelled");
	});

	it("recurses through nested descendants (3-level tree)", () => {
		const tracker = RunTracker.getInstance();
		const grandparentId = startBaseRun("grandparent");
		const parentId = startBaseRun("parent", grandparentId);
		const grandchildAId = startBaseRun("grandchild-a", parentId);
		const grandchildBId = startBaseRun("grandchild-b", parentId);
		tracker.markRunDelayed(grandchildBId, { scheduledAt: Date.now() + 60_000, delayMs: 60_000 });

		tracker.cancelRun(grandparentId);

		const store = tracker.getStore();
		expect(store.getRun(grandparentId)?.status).toBe("cancelled");
		expect(store.getRun(parentId)?.status).toBe("cancelled");
		expect(store.getRun(grandchildAId)?.status).toBe("cancelled");
		expect(store.getRun(grandchildBId)?.status).toBe("cancelled");
	});

	it("opt-out via { cascade: false } leaves children untouched", () => {
		const tracker = RunTracker.getInstance();
		const parentId = startBaseRun();
		const childId = startBaseRun("child", parentId);
		tracker.markRunDelayed(childId, { scheduledAt: Date.now() + 60_000, delayMs: 60_000 });

		tracker.cancelRun(parentId, { cascade: false });

		const store = tracker.getStore();
		expect(store.getRun(parentId)?.status).toBe("cancelled");
		// Child is still delayed — explicit opt-out preserved its lifecycle.
		expect(store.getRun(childId)?.status).toBe("delayed");
	});
});

// Review fix-up · BUG-1. Every markRun* method that flips status now
// guards against overwriting a terminal status. Without these guards,
// concurrent operator-cancel + crash auto-flip + scheduled-dispatch
// re-entry races could silently undo a `cancelled` / `crashed` /
// `failed` / `expired` outcome by re-flipping the run to a transient
// state. One test per method.
describe("RunTracker — markRun* terminal-status guards (review fix-up)", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
	});

	function startBaseRun(): string {
		const tracker = RunTracker.getInstance();
		const run = tracker.startRun({
			workflowName: "wf",
			workflowPath: "/p",
			triggerType: "http",
			triggerSummary: "POST /test",
			nodeCount: 1,
		});
		return run.id;
	}

	it("markRunThrottled is a no-op on a cancelled run", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.cancelRun(runId);
		tracker.markRunThrottled(runId, { concurrencyKey: "k", concurrencyLimit: 1, currentInFlight: 1 });
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});

	it("markRunQueued is a no-op on a cancelled run (race in onLimit:queue path)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.cancelRun(runId);
		tracker.markRunQueued(runId, {
			concurrencyKey: "k",
			concurrencyLimit: 1,
			currentInFlight: 1,
			scheduledAt: Date.now() + 1000,
		});
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});

	it("markRunDelayed is a no-op on a cancelled run (race in wait.for re-entry)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.cancelRun(runId);
		tracker.markRunDelayed(runId, { scheduledAt: Date.now() + 60_000, delayMs: 60_000 });
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});

	it("markRunExpired is a no-op on a cancelled run (TTL fires after operator cancel)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.cancelRun(runId);
		tracker.markRunExpired(runId, { expiresAt: Date.now() - 1000, expiredAt: Date.now() });
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});

	it("markRunDebounced is a no-op on a cancelled run", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.cancelRun(runId);
		tracker.markRunDebounced(runId, {
			debounceKey: "k",
			mode: "trailing",
			pingCount: 1,
			scheduledAt: Date.now() + 500,
		});
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});

	it("markRunCrashed is a no-op on a cancelled run (boot orphan recovery race)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.cancelRun(runId);
		tracker.markRunCrashed(runId, { error: new Error("boot crash") });
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});

	it("markRunTimedOut is a no-op on a cancelled run (maxDuration fires after cancel)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.cancelRun(runId);
		tracker.markRunTimedOut(runId, { stepId: "x", maxDurationMs: 1000, attemptsExhausted: 3 });
		expect(tracker.getStore().getRun(runId)?.status).toBe("cancelled");
	});

	it("markRun* preserves crashed status when called after auto-flip", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.markRunCrashed(runId, { error: new Error("boom") });
		// All subsequent transitions are no-ops.
		tracker.markRunDelayed(runId, { scheduledAt: Date.now() + 1000, delayMs: 1000 });
		tracker.markRunExpired(runId, { expiresAt: 0, expiredAt: 0 });
		tracker.markRunQueued(runId, {
			concurrencyKey: "k",
			concurrencyLimit: 1,
			currentInFlight: 1,
			scheduledAt: Date.now() + 1000,
		});
		expect(tracker.getStore().getRun(runId)?.status).toBe("crashed");
	});
});
