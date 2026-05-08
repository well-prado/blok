import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunTracker } from "../../../src/tracing/RunTracker";

describe("RunTracker — markRunQueued (Tier 2 #6 follow-up: onLimit:queue)", () => {
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

	it("markRunQueued flips status to 'queued' and persists scheduledAt", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		const scheduledAt = Date.now() + 1000;

		tracker.markRunQueued(runId, {
			concurrencyKey: "tenant-a",
			concurrencyLimit: 1,
			currentInFlight: 1,
			scheduledAt,
		});

		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("queued");
		expect(run?.scheduledAt).toBe(scheduledAt);
		expect(run?.finishedAt).toBeUndefined();
		expect(run?.durationMs).toBeUndefined();
	});

	it("markRunQueued emits RUN_QUEUED with full payload", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun("billing-wf");
		const scheduledAt = Date.now() + 1000;

		const events: Array<{ type: string; payload?: unknown }> = [];
		const handler = (e: { type: string; payload?: unknown }) => events.push(e);
		tracker.on("event", handler);

		tracker.markRunQueued(runId, {
			concurrencyKey: "tenant-b",
			concurrencyLimit: 5,
			currentInFlight: 5,
			scheduledAt,
		});
		tracker.off("event", handler);

		const queuedEvent = events.find((e) => e.type === "RUN_QUEUED");
		expect(queuedEvent).toBeDefined();
		const payload = queuedEvent?.payload as {
			concurrencyKey: string;
			concurrencyLimit: number;
			currentInFlight: number;
			scheduledAt: number;
		};
		expect(payload.concurrencyKey).toBe("tenant-b");
		expect(payload.concurrencyLimit).toBe(5);
		expect(payload.currentInFlight).toBe(5);
		expect(payload.scheduledAt).toBe(scheduledAt);
	});

	it("markRunQueued can be called twice — second call updates scheduledAt (re-defer)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		const firstAt = Date.now() + 1000;
		const secondAt = Date.now() + 2000;

		tracker.markRunQueued(runId, {
			concurrencyKey: "k",
			concurrencyLimit: 1,
			currentInFlight: 1,
			scheduledAt: firstAt,
		});
		tracker.markRunQueued(runId, {
			concurrencyKey: "k",
			concurrencyLimit: 1,
			currentInFlight: 1,
			scheduledAt: secondAt,
		});

		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("queued");
		expect(run?.scheduledAt).toBe(secondAt);
	});

	it("markRunQueued composes with transitionRunToRunning (queue → running cycle)", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();
		const scheduledAt = Date.now() + 1000;

		tracker.markRunQueued(runId, {
			concurrencyKey: "k",
			concurrencyLimit: 1,
			currentInFlight: 1,
			scheduledAt,
		});
		expect(tracker.getStore().getRun(runId)?.status).toBe("queued");

		tracker.transitionRunToRunning(runId);
		expect(tracker.getStore().getRun(runId)?.status).toBe("running");
	});

	it("markRunQueued on unknown runId is a no-op", () => {
		const tracker = RunTracker.getInstance();
		expect(() =>
			tracker.markRunQueued("ghost", {
				concurrencyKey: "k",
				concurrencyLimit: 1,
				currentInFlight: 1,
				scheduledAt: Date.now() + 1000,
			}),
		).not.toThrow();
	});
});
