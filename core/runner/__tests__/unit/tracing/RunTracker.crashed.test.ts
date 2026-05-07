import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunTracker } from "../../../src/tracing/RunTracker";

describe("RunTracker — crashed + timedOut (Tier 2 quick-wins)", () => {
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

	it("markRunCrashed flips status to 'crashed' and persists error", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();

		tracker.markRunCrashed(runId, { error: new Error("OOM") });

		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("crashed");
		expect(run?.finishedAt).toBeDefined();
		expect(run?.durationMs).toBeDefined();
		expect(run?.error).toBeDefined();
	});

	it("markRunCrashed emits a RUN_CRASHED event", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();

		const events: Array<{ type: string }> = [];
		const handler = (event: { type: string }) => events.push(event);
		tracker.on("event", handler);

		tracker.markRunCrashed(runId, { error: new Error("boom") });
		tracker.off("event", handler);

		expect(events.some((e) => e.type === "RUN_CRASHED")).toBe(true);
	});

	it("markRunCrashed handles non-Error thrown values", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();

		tracker.markRunCrashed(runId, { error: "string-error" });

		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("crashed");
		expect(run?.error).toBeDefined();
	});

	it("markRunTimedOut flips status to 'timedOut' and emits RUN_TIMED_OUT", () => {
		const tracker = RunTracker.getInstance();
		const runId = startBaseRun();

		const events: Array<{ type: string; payload?: unknown }> = [];
		tracker.on("event", (e: { type: string; payload?: unknown }) => events.push(e));

		tracker.markRunTimedOut(runId, {
			stepId: "fetch-data",
			maxDurationMs: 30_000,
			attemptsExhausted: 3,
		});

		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("timedOut");
		expect(run?.finishedAt).toBeDefined();

		const timedOutEvent = events.find((e) => e.type === "RUN_TIMED_OUT");
		expect(timedOutEvent).toBeDefined();
		const payload = timedOutEvent?.payload as {
			stepId: string;
			maxDurationMs: number;
			attemptsExhausted: number;
		};
		expect(payload.stepId).toBe("fetch-data");
		expect(payload.maxDurationMs).toBe(30_000);
		expect(payload.attemptsExhausted).toBe(3);
	});

	it("markRunCrashed on unknown runId is a no-op", () => {
		const tracker = RunTracker.getInstance();
		expect(() => tracker.markRunCrashed("ghost", { error: new Error("x") })).not.toThrow();
	});

	it("markRunTimedOut on unknown runId is a no-op", () => {
		const tracker = RunTracker.getInstance();
		expect(() =>
			tracker.markRunTimedOut("ghost", { stepId: "x", maxDurationMs: 1000, attemptsExhausted: 1 }),
		).not.toThrow();
	});
});
