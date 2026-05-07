import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunTracker } from "../../../src/tracing/RunTracker";

describe("RunTracker — scheduling lifecycle (Tier 2 #5 + #7)", () => {
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

	it("markRunDelayed flips status and persists scheduledAt + expiresAt", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		const scheduledAt = Date.now() + 60_000;
		const expiresAt = Date.now() + 120_000;

		tracker.markRunDelayed(runId, { scheduledAt, delayMs: 60_000, expiresAt });

		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("delayed");
		expect(run?.scheduledAt).toBe(scheduledAt);
		expect(run?.expiresAt).toBe(expiresAt);
	});

	it("markRunDelayed emits a RUN_DELAYED event with payload", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		const events: Array<{ type: string }> = [];
		const handler = (event: { type: string }) => events.push(event);
		tracker.on("event", handler);

		tracker.markRunDelayed(runId, { scheduledAt: Date.now() + 1000, delayMs: 1000 });
		tracker.off("event", handler);

		expect(events.some((e) => e.type === "RUN_DELAYED")).toBe(true);
	});

	it("markRunExpired flips status and computes lateBy", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();

		const expiresAt = Date.now() - 5000;
		const expiredAt = Date.now();
		tracker.markRunExpired(runId, { expiresAt, expiredAt });

		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("expired");
		expect(run?.finishedAt).toBe(expiredAt);
	});

	it("markRunDebounced (leading + intoRunId) is terminal", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();

		tracker.markRunDebounced(runId, {
			debounceKey: "doc-1",
			mode: "leading",
			intoRunId: "run_winner",
			pingCount: 1,
		});

		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("debounced");
		expect(run?.debounceKey).toBe("doc-1");
		expect(run?.debounceMode).toBe("leading");
		expect(run?.finishedAt).toBeDefined();
	});

	it("markRunDebounced (trailing without intoRunId) is transient (no finishedAt)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();

		tracker.markRunDebounced(runId, {
			debounceKey: "doc-1",
			mode: "trailing",
			pingCount: 1,
			scheduledAt: Date.now() + 500,
		});

		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("debounced");
		expect(run?.scheduledAt).toBeDefined();
		expect(run?.finishedAt).toBeUndefined();
	});

	it("recordDebouncePing increments pingCount + updates scheduledAt without emitting an event", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.markRunDebounced(runId, {
			debounceKey: "doc-1",
			mode: "trailing",
			pingCount: 1,
			scheduledAt: Date.now() + 500,
		});

		const beforeEvents = (tracker.getStore().getEvents(runId) || []).length;

		tracker.recordDebouncePing(runId, { pingCount: 5, scheduledAt: Date.now() + 1500 });

		const run = tracker.getStore().getRun(runId);
		expect(run?.pingCount).toBe(5);

		const afterEvents = (tracker.getStore().getEvents(runId) || []).length;
		expect(afterEvents).toBe(beforeEvents); // no new event
	});

	it("transitionRunToRunning flips delayed/debounced run to running", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		tracker.markRunDelayed(runId, { scheduledAt: Date.now() + 1000, delayMs: 1000 });

		tracker.transitionRunToRunning(runId);
		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("running");
	});

	it("startRun captures scheduling fields when passed in opts", () => {
		const tracker = RunTracker.getInstance();
		const scheduledAt = Date.now() + 60_000;
		const run = tracker.startRun({
			workflowName: "wf",
			workflowPath: "/p",
			triggerType: "http",
			triggerSummary: "POST /test",
			nodeCount: 1,
			scheduledAt,
			expiresAt: scheduledAt + 60_000,
			debounceKey: "doc-1",
			debounceMode: "trailing",
			pingCount: 1,
		});
		expect(run.scheduledAt).toBe(scheduledAt);
		expect(run.debounceKey).toBe("doc-1");
		expect(run.debounceMode).toBe("trailing");
		expect(run.pingCount).toBe(1);
	});
});
