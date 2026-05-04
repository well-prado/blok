import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeferredRunScheduler } from "../../../src/scheduling/DeferredRunScheduler";
import { RunTracker } from "../../../src/tracing/RunTracker";

describe("DeferredRunScheduler", () => {
	beforeEach(() => {
		DeferredRunScheduler.resetInstance();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		DeferredRunScheduler.resetInstance();
	});

	it("singleton returns the same instance", () => {
		const a = DeferredRunScheduler.getInstance();
		const b = DeferredRunScheduler.getInstance();
		expect(a).toBe(b);
	});

	it("schedules a dispatch and fires after the delay", async () => {
		const sched = DeferredRunScheduler.getInstance();
		const fn = vi.fn(async () => undefined);
		sched.schedule("run-1", Date.now() + 1000, fn);

		expect(sched.has("run-1")).toBe(true);
		expect(sched.size()).toBe(1);

		vi.advanceTimersByTime(999);
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(sched.has("run-1")).toBe(false);
		expect(sched.size()).toBe(0);
	});

	it("cancel returns true when an entry exists and prevents the dispatch", () => {
		const sched = DeferredRunScheduler.getInstance();
		const fn = vi.fn(async () => undefined);
		sched.schedule("run-1", Date.now() + 1000, fn);

		expect(sched.cancel("run-1")).toBe(true);
		vi.advanceTimersByTime(2000);
		expect(fn).not.toHaveBeenCalled();
	});

	it("cancel returns false on unknown runId", () => {
		const sched = DeferredRunScheduler.getInstance();
		expect(sched.cancel("ghost")).toBe(false);
	});

	it("re-scheduling the same runId replaces the prior timer", () => {
		const sched = DeferredRunScheduler.getInstance();
		const oldFn = vi.fn(async () => undefined);
		const newFn = vi.fn(async () => undefined);

		sched.schedule("run-1", Date.now() + 5000, oldFn);
		sched.schedule("run-1", Date.now() + 1000, newFn);

		vi.advanceTimersByTime(1100);
		expect(oldFn).not.toHaveBeenCalled();
		expect(newFn).toHaveBeenCalledTimes(1);
	});

	it("clamps past-due dispatchAt to fire on next tick", async () => {
		const sched = DeferredRunScheduler.getInstance();
		const fn = vi.fn(async () => undefined);

		sched.schedule("run-1", Date.now() - 5000, fn); // past
		await vi.advanceTimersByTimeAsync(0);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("drainAll fires every pending dispatch and empties the queue", async () => {
		const sched = DeferredRunScheduler.getInstance();
		const a = vi.fn(async () => undefined);
		const b = vi.fn(async () => undefined);
		sched.schedule("a", Date.now() + 60_000, a);
		sched.schedule("b", Date.now() + 90_000, b);

		await sched.drainAll();
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
		expect(sched.size()).toBe(0);
	});

	it("clear cancels everything without firing", () => {
		const sched = DeferredRunScheduler.getInstance();
		const a = vi.fn(async () => undefined);
		sched.schedule("a", Date.now() + 1000, a);
		sched.clear();
		vi.advanceTimersByTime(2000);
		expect(a).not.toHaveBeenCalled();
		expect(sched.size()).toBe(0);
	});

	it("a thrown dispatchFn does not poison subsequent dispatches", async () => {
		const sched = DeferredRunScheduler.getInstance();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const bad = vi.fn(async () => {
			throw new Error("boom");
		});
		const good = vi.fn(async () => undefined);

		sched.schedule("bad", Date.now() + 100, bad);
		sched.schedule("good", Date.now() + 200, good);

		await vi.advanceTimersByTimeAsync(300);
		// Allow the rejected promise's catch to run.
		await Promise.resolve();

		expect(bad).toHaveBeenCalledTimes(1);
		expect(good).toHaveBeenCalledTimes(1);
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});
});

describe("DeferredRunScheduler — durable persistence (Tier 2 #5+#7 follow-up)", () => {
	beforeEach(() => {
		DeferredRunScheduler.resetInstance();
		RunTracker.resetInstance();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		DeferredRunScheduler.resetInstance();
		RunTracker.resetInstance();
	});

	it("schedule with persist writes a row to the store; cancel deletes it", () => {
		const sched = DeferredRunScheduler.getInstance();
		const tracker = RunTracker.getInstance();
		const fn = vi.fn(async () => undefined);

		sched.schedule("run-1", Date.now() + 60_000, fn, {
			workflowName: "wf",
			triggerType: "http",
			dispatchStatus: "delayed",
			payload: { method: "POST", path: "/x", body: { foo: "bar" } },
		});

		const rows = tracker.getStore().getScheduledDispatches();
		expect(rows.length).toBe(1);
		expect(rows[0].runId).toBe("run-1");
		expect(rows[0].dispatchStatus).toBe("delayed");

		const cancelled = sched.cancel("run-1");
		expect(cancelled).toBe(true);
		expect(tracker.getStore().getScheduledDispatches().length).toBe(0);
	});

	it("timer fire deletes the persisted row before invoking dispatchFn", async () => {
		const sched = DeferredRunScheduler.getInstance();
		const tracker = RunTracker.getInstance();

		const dispatched: string[] = [];
		const fn = vi.fn(async () => {
			// Inside the dispatch, the row should already be gone.
			dispatched.push(
				...tracker
					.getStore()
					.getScheduledDispatches()
					.map((r) => r.runId),
			);
		});

		sched.schedule("run-2", Date.now() + 100, fn, {
			workflowName: "wf",
			triggerType: "http",
			dispatchStatus: "delayed",
			payload: null,
		});

		expect(tracker.getStore().getScheduledDispatches().length).toBe(1);

		await vi.advanceTimersByTimeAsync(150);
		await Promise.resolve();

		expect(fn).toHaveBeenCalledTimes(1);
		// The dispatchFn observed an empty store: persistence was cleared first.
		expect(dispatched.length).toBe(0);
		expect(tracker.getStore().getScheduledDispatches().length).toBe(0);
	});

	it("re-scheduling the same runId updates the persisted row in place", () => {
		const sched = DeferredRunScheduler.getInstance();
		const tracker = RunTracker.getInstance();

		sched.schedule("run-3", Date.now() + 1000, async () => undefined, {
			workflowName: "wf",
			triggerType: "http",
			dispatchStatus: "queued",
			payload: { v: 1 },
		});
		sched.schedule("run-3", Date.now() + 5000, async () => undefined, {
			workflowName: "wf",
			triggerType: "http",
			dispatchStatus: "queued",
			payload: { v: 2 },
		});

		const rows = tracker.getStore().getScheduledDispatches();
		expect(rows.length).toBe(1);
		expect((rows[0].payload as { v: number }).v).toBe(2);
	});

	it("schedule WITHOUT persist does not write a row (zero-overhead default)", () => {
		const sched = DeferredRunScheduler.getInstance();
		const tracker = RunTracker.getInstance();
		sched.schedule("run-4", Date.now() + 1000, async () => undefined);
		expect(tracker.getStore().getScheduledDispatches().length).toBe(0);
	});

	it("cancel(runId, true) deletes a persisted row even when the timer is gone", () => {
		const sched = DeferredRunScheduler.getInstance();
		const tracker = RunTracker.getInstance();

		// Persist a row directly (simulating a row from a prior process).
		tracker.getStore().upsertScheduledDispatch({
			runId: "orphan",
			workflowName: "wf",
			triggerType: "http",
			scheduledAt: Date.now() + 10_000,
			dispatchStatus: "delayed",
			payload: null,
			createdAt: Date.now(),
		});
		expect(tracker.getStore().getScheduledDispatches().length).toBe(1);

		// No in-memory entry exists for "orphan". Default cancel returns false.
		expect(sched.cancel("orphan")).toBe(false);
		expect(tracker.getStore().getScheduledDispatches().length).toBe(1);

		// cancelPersistedOnly=true forces the persisted-row delete.
		expect(sched.cancel("orphan", true)).toBe(true);
		expect(tracker.getStore().getScheduledDispatches().length).toBe(0);
	});
});
