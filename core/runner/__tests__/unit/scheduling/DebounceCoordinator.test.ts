import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebounceCoordinator } from "../../../src/scheduling/DebounceCoordinator";

describe("DebounceCoordinator — leading mode", () => {
	beforeEach(() => {
		DebounceCoordinator.resetInstance();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		DebounceCoordinator.resetInstance();
	});

	it("first ping returns fire-immediate outcome", () => {
		const co = DebounceCoordinator.getInstance();
		const fire = vi.fn(async () => undefined);

		const result = co.register({
			workflowName: "w",
			debounceKey: "k",
			mode: "leading",
			delayMs: 1000,
			runId: "run_first",
			onFire: fire,
		});

		expect(result.outcome).toBe("fire-immediate");
		expect(result.activeRunId).toBe("run_first");
		expect(result.pingCount).toBe(1);
		// Caller is responsible for synchronous execution; coordinator does NOT call onFire for leading.
		expect(fire).not.toHaveBeenCalled();
	});

	it("subsequent pings within the window coalesce", () => {
		const co = DebounceCoordinator.getInstance();
		const fire = vi.fn(async () => undefined);

		co.register({
			workflowName: "w",
			debounceKey: "k",
			mode: "leading",
			delayMs: 1000,
			runId: "run_first",
			onFire: fire,
		});
		const second = co.register({
			workflowName: "w",
			debounceKey: "k",
			mode: "leading",
			delayMs: 1000,
			runId: "run_second",
			onFire: fire,
		});

		expect(second.outcome).toBe("coalesce");
		expect(second.activeRunId).toBe("run_first"); // points back at the firer
		expect(second.pingCount).toBe(2);
	});

	it("after delayMs of silence, a new ping fires fresh", () => {
		const co = DebounceCoordinator.getInstance();
		const fire = vi.fn(async () => undefined);

		co.register({
			workflowName: "w",
			debounceKey: "k",
			mode: "leading",
			delayMs: 1000,
			runId: "run_a",
			onFire: fire,
		});
		vi.advanceTimersByTime(1100);

		const result = co.register({
			workflowName: "w",
			debounceKey: "k",
			mode: "leading",
			delayMs: 1000,
			runId: "run_b",
			onFire: fire,
		});
		expect(result.outcome).toBe("fire-immediate");
		expect(result.activeRunId).toBe("run_b");
	});
});

describe("DebounceCoordinator — trailing mode", () => {
	beforeEach(() => {
		DebounceCoordinator.resetInstance();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		DebounceCoordinator.resetInstance();
	});

	it("first ping returns schedule-trailing with scheduledAt", async () => {
		const co = DebounceCoordinator.getInstance();
		const fire = vi.fn(async () => undefined);

		const result = co.register({
			workflowName: "w",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_first",
			onFire: fire,
		});
		expect(result.outcome).toBe("schedule-trailing");
		expect(result.activeRunId).toBe("run_first");
		expect(result.scheduledAt).toBeGreaterThan(Date.now());
		expect(result.pingCount).toBe(1);

		await vi.advanceTimersByTimeAsync(500);
		expect(fire).toHaveBeenCalledTimes(1);
	});

	it("each ping resets the timer (latest-wins payload)", async () => {
		const co = DebounceCoordinator.getInstance();
		const oldFire = vi.fn(async () => undefined);
		const newFire = vi.fn(async () => undefined);

		const first = co.register({
			workflowName: "w",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_first",
			onFire: oldFire,
		});
		expect(first.outcome).toBe("schedule-trailing");

		await vi.advanceTimersByTimeAsync(400);
		const second = co.register({
			workflowName: "w",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_second",
			onFire: newFire,
		});
		expect(second.outcome).toBe("coalesce");
		expect(second.activeRunId).toBe("run_first"); // first run still owns the window
		expect(second.pingCount).toBe(2);

		await vi.advanceTimersByTimeAsync(400);
		expect(oldFire).not.toHaveBeenCalled();
		expect(newFire).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(100);
		expect(oldFire).not.toHaveBeenCalled();
		expect(newFire).toHaveBeenCalledTimes(1);
	});

	it("maxDelayMs forces a fire even with continuous pings inside delayMs", async () => {
		const co = DebounceCoordinator.getInstance();
		const fire = vi.fn(async () => undefined);

		co.register({
			workflowName: "w",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			maxDelayMs: 1500,
			runId: "run_active",
			onFire: fire,
		});

		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(400);
			co.register({
				workflowName: "w",
				debounceKey: "k",
				mode: "trailing",
				delayMs: 500,
				maxDelayMs: 1500,
				runId: `run_loser_${i}`,
				onFire: fire,
			});
		}
		expect(fire).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(400);
		expect(fire).toHaveBeenCalledTimes(1);
	});

	it("isolates buckets across keys", async () => {
		const co = DebounceCoordinator.getInstance();
		const fireA = vi.fn(async () => undefined);
		const fireB = vi.fn(async () => undefined);

		co.register({
			workflowName: "w",
			debounceKey: "A",
			mode: "trailing",
			delayMs: 500,
			runId: "run_A",
			onFire: fireA,
		});
		co.register({
			workflowName: "w",
			debounceKey: "B",
			mode: "trailing",
			delayMs: 500,
			runId: "run_B",
			onFire: fireB,
		});

		await vi.advanceTimersByTimeAsync(500);
		expect(fireA).toHaveBeenCalledTimes(1);
		expect(fireB).toHaveBeenCalledTimes(1);
	});

	it("isolates buckets across workflows", async () => {
		const co = DebounceCoordinator.getInstance();
		const fireW1 = vi.fn(async () => undefined);
		const fireW2 = vi.fn(async () => undefined);

		co.register({
			workflowName: "w1",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_w1",
			onFire: fireW1,
		});
		co.register({
			workflowName: "w2",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_w2",
			onFire: fireW2,
		});

		await vi.advanceTimersByTimeAsync(500);
		expect(fireW1).toHaveBeenCalledTimes(1);
		expect(fireW2).toHaveBeenCalledTimes(1);
	});

	it("cancel removes an active window without firing", async () => {
		const co = DebounceCoordinator.getInstance();
		const fire = vi.fn(async () => undefined);

		co.register({
			workflowName: "w",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_x",
			onFire: fire,
		});
		expect(co.cancel("w", "k")).toBe(true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(fire).not.toHaveBeenCalled();
		expect(co.size()).toBe(0);
	});

	it("cancel returns false on unknown bucket", () => {
		const co = DebounceCoordinator.getInstance();
		expect(co.cancel("nope", "nope")).toBe(false);
	});

	it("clear cancels all windows without firing", async () => {
		const co = DebounceCoordinator.getInstance();
		const fire = vi.fn(async () => undefined);

		co.register({
			workflowName: "w",
			debounceKey: "A",
			mode: "trailing",
			delayMs: 500,
			runId: "run_A",
			onFire: fire,
		});
		co.register({
			workflowName: "w",
			debounceKey: "B",
			mode: "trailing",
			delayMs: 500,
			runId: "run_B",
			onFire: fire,
		});
		co.clear();

		await vi.advanceTimersByTimeAsync(1000);
		expect(fire).not.toHaveBeenCalled();
		expect(co.size()).toBe(0);
	});

	it("has() reports active windows", () => {
		const co = DebounceCoordinator.getInstance();
		expect(co.has("w", "k")).toBe(false);
		co.register({
			workflowName: "w",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_x",
			onFire: async () => undefined,
		});
		expect(co.has("w", "k")).toBe(true);
	});
});
