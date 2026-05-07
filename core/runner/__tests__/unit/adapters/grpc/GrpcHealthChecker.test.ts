import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrpcHealthChecker } from "../../../../src/adapters/grpc/GrpcHealthChecker";

describe("GrpcHealthChecker", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("rejects invalid options at construction time", () => {
		expect(
			() =>
				new GrpcHealthChecker(async () => true, {
					intervalMs: 0,
					failureThreshold: 1,
				}),
		).toThrow(/intervalMs must be > 0/);

		expect(
			() =>
				new GrpcHealthChecker(async () => true, {
					intervalMs: 1000,
					failureThreshold: 0,
				}),
		).toThrow(/failureThreshold must be ≥ 1/);
	});

	it("starts available and reports failures count of zero before any tick", () => {
		const checker = new GrpcHealthChecker(async () => true, {
			intervalMs: 1000,
			failureThreshold: 3,
		});
		expect(checker.isAvailable()).toBe(true);
		expect(checker.getFailureCount()).toBe(0);
	});

	it("opens the circuit after `failureThreshold` consecutive failures", async () => {
		const probe = vi.fn().mockResolvedValue(false);
		const stateHistory: boolean[] = [];
		const checker = new GrpcHealthChecker(probe, {
			intervalMs: 1000,
			failureThreshold: 3,
			onStateChange: (next) => stateHistory.push(next),
		});

		await checker.tick();
		expect(checker.isAvailable()).toBe(true);
		expect(checker.getFailureCount()).toBe(1);

		await checker.tick();
		expect(checker.isAvailable()).toBe(true);
		expect(checker.getFailureCount()).toBe(2);

		await checker.tick();
		expect(checker.isAvailable()).toBe(false);
		expect(checker.getFailureCount()).toBe(3);

		// onStateChange fires exactly once per transition.
		expect(stateHistory).toEqual([false]);
	});

	it("closes the circuit on the first successful probe and resets failures", async () => {
		let healthy = false;
		const probe = vi.fn(async () => healthy);
		const checker = new GrpcHealthChecker(probe, {
			intervalMs: 1000,
			failureThreshold: 2,
		});

		await checker.tick();
		await checker.tick();
		expect(checker.isAvailable()).toBe(false);

		healthy = true;
		await checker.tick();

		expect(checker.isAvailable()).toBe(true);
		expect(checker.getFailureCount()).toBe(0);
	});

	it("treats a thrown probe as a failure rather than crashing the loop", async () => {
		const probe = vi.fn().mockRejectedValue(new Error("network down"));
		const checker = new GrpcHealthChecker(probe, {
			intervalMs: 1000,
			failureThreshold: 2,
		});

		await checker.tick();
		await checker.tick();

		expect(checker.isAvailable()).toBe(false);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("coalesces concurrent ticks (a slow probe doesn't queue more)", async () => {
		let resolveProbe!: (value: boolean) => void;
		const probe = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolveProbe = resolve;
				}),
		);
		const checker = new GrpcHealthChecker(probe, {
			intervalMs: 1000,
			failureThreshold: 3,
		});

		const first = checker.tick();
		const secondImmediate = checker.tick();

		// While `first` is in-flight, the second tick is dropped — no extra probe call.
		expect(probe).toHaveBeenCalledTimes(1);

		resolveProbe(true);
		await first;
		await secondImmediate;
	});

	it("`start()` schedules ticks at intervalMs and `stop()` cancels them", async () => {
		const probe = vi.fn().mockResolvedValue(true);
		const checker = new GrpcHealthChecker(probe, {
			intervalMs: 5_000,
			failureThreshold: 3,
		});

		checker.start();
		// Idempotent — second start is a no-op.
		checker.start();

		// Advance two intervals; expect two probes.
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(probe).toHaveBeenCalledTimes(2);

		checker.stop();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(probe).toHaveBeenCalledTimes(2);

		// Restart works after stop.
		checker.start();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(probe).toHaveBeenCalledTimes(3);

		checker.stop();
	});

	it("does not fire onStateChange when the probe outcome matches current state", async () => {
		const probe = vi.fn().mockResolvedValue(true);
		const onStateChange = vi.fn();
		const checker = new GrpcHealthChecker(probe, {
			intervalMs: 1000,
			failureThreshold: 1,
			onStateChange,
		});

		await checker.tick();
		await checker.tick();
		await checker.tick();

		// Already available; no transition events.
		expect(onStateChange).not.toHaveBeenCalled();
	});
});
