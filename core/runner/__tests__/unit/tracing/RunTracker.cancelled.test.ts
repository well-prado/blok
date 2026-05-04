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
