import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TriggerBase from "../../../src/TriggerBase";
import { RunTracker } from "../../../src/tracing/RunTracker";

describe("RunTracker — markAllRunningRunsAsCrashed (Tier 2 quick-wins follow-up)", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
	});

	function startRun(workflowName: string): string {
		return RunTracker.getInstance().startRun({
			workflowName,
			workflowPath: "/p",
			triggerType: "http",
			triggerSummary: "POST /test",
			nodeCount: 1,
		}).id;
	}

	it("flips every running run to crashed and returns the count", () => {
		const tracker = RunTracker.getInstance();
		const r1 = startRun("wf-A");
		const r2 = startRun("wf-B");
		const r3 = startRun("wf-C");

		const flipped = tracker.markAllRunningRunsAsCrashed(new Error("OOM"));

		expect(flipped).toBe(3);
		for (const id of [r1, r2, r3]) {
			expect(tracker.getStore().getRun(id)?.status).toBe("crashed");
		}
	});

	it("emits RUN_CRASHED for each flipped run", () => {
		const tracker = RunTracker.getInstance();
		startRun("a");
		startRun("b");

		const events: Array<{ type: string }> = [];
		const handler = (e: { type: string }) => events.push(e);
		tracker.on("event", handler);

		tracker.markAllRunningRunsAsCrashed(new Error("boom"));
		tracker.off("event", handler);

		expect(events.filter((e) => e.type === "RUN_CRASHED").length).toBe(2);
	});

	it("ignores runs in non-running states", () => {
		const tracker = RunTracker.getInstance();
		const r1 = startRun("wf-A");
		const r2 = startRun("wf-B");
		tracker.completeRun(r1, { ok: true });
		tracker.failRun(r2, new Error("oops"));

		const r3 = startRun("wf-C");
		const flipped = tracker.markAllRunningRunsAsCrashed(new Error("crash"));

		expect(flipped).toBe(1);
		expect(tracker.getStore().getRun(r1)?.status).toBe("completed");
		expect(tracker.getStore().getRun(r2)?.status).toBe("failed");
		expect(tracker.getStore().getRun(r3)?.status).toBe("crashed");
	});

	it("respects maxStartedAt filter (orphan-recovery threshold)", () => {
		const tracker = RunTracker.getInstance();
		const r1 = startRun("wf-A");
		const r2 = startRun("wf-B");

		// Force r1's startedAt into the past so the filter only catches it.
		const r1Run = tracker.getStore().getRun(r1);
		if (r1Run) {
			tracker.getStore().updateRun(r1, { ...r1Run, startedAt: r1Run.startedAt - 60_000 });
		}
		const cutoff = Date.now() - 30_000;

		const flipped = tracker.markAllRunningRunsAsCrashed(new Error("orphan"), { maxStartedAt: cutoff });

		expect(flipped).toBe(1);
		expect(tracker.getStore().getRun(r1)?.status).toBe("crashed");
		expect(tracker.getStore().getRun(r2)?.status).toBe("running");
	});
});

describe("TriggerBase.recoverOrphanedRuns + installCrashHandlers", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
		TriggerBase.resetCrashHandlersInstalled();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		RunTracker.resetInstance();
		TriggerBase.resetCrashHandlersInstalled();
		vi.unstubAllEnvs();
	});

	function startRun(workflowName = "wf"): string {
		return RunTracker.getInstance().startRun({
			workflowName,
			workflowPath: "/p",
			triggerType: "http",
			triggerSummary: "POST /test",
			nodeCount: 1,
		}).id;
	}

	it("recoverOrphanedRuns flips runs older than the threshold", () => {
		const tracker = RunTracker.getInstance();
		const r1 = startRun();
		const r2 = startRun();
		// r1 is 5min old, r2 is fresh.
		const r1Run = tracker.getStore().getRun(r1);
		if (r1Run) tracker.getStore().updateRun(r1, { ...r1Run, startedAt: r1Run.startedAt - 5 * 60_000 });

		const flipped = TriggerBase.recoverOrphanedRuns(2 * 60_000);

		expect(flipped).toBe(1);
		expect(tracker.getStore().getRun(r1)?.status).toBe("crashed");
		expect(tracker.getStore().getRun(r2)?.status).toBe("running");
	});

	it("recoverOrphanedRuns reads BLOK_ORPHAN_THRESHOLD_MS env var", () => {
		const tracker = RunTracker.getInstance();
		const r1 = startRun();
		const r1Run = tracker.getStore().getRun(r1);
		if (r1Run) tracker.getStore().updateRun(r1, { ...r1Run, startedAt: r1Run.startedAt - 30_000 });

		// Default 2min would NOT flip a 30s-old run; lower threshold via env.
		vi.stubEnv("BLOK_ORPHAN_THRESHOLD_MS", "10000");

		const flipped = TriggerBase.recoverOrphanedRuns();
		expect(flipped).toBe(1);
	});

	it("recoverOrphanedRuns is a no-op when BLOK_CRASH_AUTOFLIP_DISABLED=1", () => {
		const tracker = RunTracker.getInstance();
		const r1 = startRun();
		const r1Run = tracker.getStore().getRun(r1);
		if (r1Run) tracker.getStore().updateRun(r1, { ...r1Run, startedAt: r1Run.startedAt - 5 * 60_000 });

		vi.stubEnv("BLOK_CRASH_AUTOFLIP_DISABLED", "1");

		const flipped = TriggerBase.recoverOrphanedRuns(60_000);
		expect(flipped).toBe(0);
		expect(tracker.getStore().getRun(r1)?.status).toBe("running");
	});

	it("installCrashHandlers is idempotent — second call does not double-install", () => {
		// Snapshot listener counts before/after to verify no leak.
		const before = process.listenerCount("uncaughtException");

		TriggerBase.installCrashHandlers();
		const afterFirst = process.listenerCount("uncaughtException");

		TriggerBase.installCrashHandlers();
		const afterSecond = process.listenerCount("uncaughtException");

		expect(afterFirst).toBe(before + 1);
		expect(afterSecond).toBe(afterFirst);

		// Cleanup — remove the listener we added so other tests aren't affected.
		const listeners = process.listeners("uncaughtException");
		process.removeListener("uncaughtException", listeners[listeners.length - 1]);
		const rejectionListeners = process.listeners("unhandledRejection");
		process.removeListener("unhandledRejection", rejectionListeners[rejectionListeners.length - 1]);
	});

	it("installCrashHandlers respects BLOK_CRASH_AUTOFLIP_DISABLED=1 (no install)", () => {
		vi.stubEnv("BLOK_CRASH_AUTOFLIP_DISABLED", "1");
		const before = process.listenerCount("uncaughtException");
		TriggerBase.installCrashHandlers();
		expect(process.listenerCount("uncaughtException")).toBe(before);
	});
});
