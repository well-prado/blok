import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeferredRunScheduler } from "../../../src/scheduling/DeferredRunScheduler";

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
