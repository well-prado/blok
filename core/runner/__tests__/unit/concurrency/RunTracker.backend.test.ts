import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConcurrencyBackend } from "../../../src/concurrency/ConcurrencyBackend";
import { RunTracker } from "../../../src/tracing/RunTracker";

function makeMockBackend(): ConcurrencyBackend & {
	acquireSpy: ReturnType<typeof vi.fn>;
	releaseSpy: ReturnType<typeof vi.fn>;
} {
	const acquireSpy = vi.fn(async () => ({ acquired: true, currentInFlight: 1 }));
	const releaseSpy = vi.fn(async () => undefined);
	return {
		name: "mock",
		connect: vi.fn(async () => undefined),
		disconnect: vi.fn(async () => undefined),
		acquireSlot: acquireSpy as unknown as ConcurrencyBackend["acquireSlot"],
		releaseSlot: releaseSpy as unknown as ConcurrencyBackend["releaseSlot"],
		purgeExpired: vi.fn(async () => 0) as unknown as ConcurrencyBackend["purgeExpired"],
		acquireSpy,
		releaseSpy,
	};
}

describe("RunTracker — concurrency backend delegation (Tier 2 #6 follow-up)", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
	});

	it("uses the local store when no backend is set (default)", async () => {
		const tracker = RunTracker.getInstance();
		const result = await tracker.acquireConcurrencySlot("wf", "k", 1, "run_1", Date.now() + 60_000);
		expect(result.acquired).toBe(true);
		expect(tracker.getConcurrencyBackend()).toBeNull();
	});

	it("delegates to backend.acquireSlot when a backend is installed", async () => {
		const tracker = RunTracker.getInstance();
		const backend = makeMockBackend();
		tracker.setConcurrencyBackend(backend);

		const expiry = Date.now() + 60_000;
		const result = await tracker.acquireConcurrencySlot("wf", "k", 5, "run_1", expiry);

		expect(result).toEqual({ acquired: true, currentInFlight: 1 });
		expect(backend.acquireSpy).toHaveBeenCalledWith("wf", "k", 5, "run_1", expiry);
	});

	it("delegates to backend.releaseSlot when a backend is installed", async () => {
		const tracker = RunTracker.getInstance();
		const backend = makeMockBackend();
		tracker.setConcurrencyBackend(backend);

		await tracker.releaseConcurrencySlot("wf", "k", "run_1");
		expect(backend.releaseSpy).toHaveBeenCalledWith("wf", "k", "run_1");
	});

	it("uninstall via setConcurrencyBackend(null) reverts to local store", async () => {
		const tracker = RunTracker.getInstance();
		const backend = makeMockBackend();
		tracker.setConcurrencyBackend(backend);
		tracker.setConcurrencyBackend(null);

		await tracker.acquireConcurrencySlot("wf", "k", 1, "run_1", Date.now() + 60_000);
		// Backend was uninstalled before the call.
		expect(backend.acquireSpy).not.toHaveBeenCalled();
	});

	it("backend errors propagate from acquireConcurrencySlot", async () => {
		const tracker = RunTracker.getInstance();
		const backend = makeMockBackend();
		(backend.acquireSpy as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("nats unreachable"));
		tracker.setConcurrencyBackend(backend);

		await expect(tracker.acquireConcurrencySlot("wf", "k", 1, "run_1", Date.now() + 60_000)).rejects.toThrow(
			"nats unreachable",
		);
	});
});
