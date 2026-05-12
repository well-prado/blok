import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DebounceBackend,
	DebounceFinalizeResult,
	DebounceRegisterBackendOpts,
	DebounceRegisterBackendResult,
} from "../../../src/scheduling/DebounceBackend";
import { DebounceCoordinator } from "../../../src/scheduling/DebounceCoordinator";

/**
 * Fake cross-process debounce backend. Drives the coordinator's
 * cross-process orchestration without standing up a real broker. Two
 * coordinators can share one bus to simulate two processes interacting
 * over the same bucket.
 */
interface BusBucket {
	mode: "leading" | "trailing";
	delayMs: number;
	maxDelayMs?: number;
	maxDelayDeadline?: number;
	firstPingAt: number;
	lastPingAt: number;
	pingCount: number;
	activeRunId: string;
	ownerProcessId: string;
	ownerLeaseExpiresAt: number;
	scheduledAt: number;
}

class FakeBus {
	buckets = new Map<string, BusBucket>();
}

function makeBackend(bus: FakeBus, label: string): DebounceBackend {
	const computeScheduledAt = (
		existing: BusBucket | undefined,
		opts: { now: number; delayMs: number; maxDelayMs?: number },
	) => {
		const naive = opts.now + opts.delayMs;
		let deadline: number | undefined;
		if (existing?.maxDelayDeadline !== undefined) deadline = existing.maxDelayDeadline;
		else if (opts.maxDelayMs !== undefined) deadline = opts.now + opts.maxDelayMs;
		return deadline !== undefined ? Math.min(naive, deadline) : naive;
	};

	return {
		name: `fake-${label}`,
		async connect(): Promise<void> {
			/* no-op */
		},
		async disconnect(): Promise<void> {
			/* no-op */
		},
		async registerPing(opts: DebounceRegisterBackendOpts): Promise<DebounceRegisterBackendResult> {
			const key = `${opts.workflowName}__${opts.debounceKey}`;
			const existing = bus.buckets.get(key);
			const ownerActive = existing !== undefined && existing.ownerLeaseExpiresAt > opts.now;

			if (!existing || !ownerActive) {
				const next: BusBucket = {
					mode: opts.mode,
					delayMs: opts.delayMs,
					maxDelayMs: opts.maxDelayMs,
					maxDelayDeadline:
						existing?.maxDelayDeadline ?? (opts.maxDelayMs !== undefined ? opts.now + opts.maxDelayMs : undefined),
					firstPingAt: existing?.firstPingAt ?? opts.now,
					lastPingAt: opts.now,
					pingCount: (existing?.pingCount ?? 0) + 1,
					activeRunId: opts.runId,
					ownerProcessId: opts.processId,
					ownerLeaseExpiresAt: opts.now + opts.ownerLeaseMs,
					scheduledAt: computeScheduledAt(existing, opts),
				};
				bus.buckets.set(key, next);
				return {
					outcome: "owner-new",
					activeRunId: next.activeRunId,
					scheduledAt: next.scheduledAt,
					pingCount: next.pingCount,
				};
			}
			if (existing.ownerProcessId === opts.processId) {
				existing.lastPingAt = opts.now;
				existing.pingCount += 1;
				existing.ownerLeaseExpiresAt = opts.now + opts.ownerLeaseMs;
				existing.scheduledAt = computeScheduledAt(existing, opts);
				return {
					outcome: "owner-extend",
					activeRunId: existing.activeRunId,
					scheduledAt: existing.scheduledAt,
					pingCount: existing.pingCount,
				};
			}
			existing.lastPingAt = opts.now;
			existing.pingCount += 1;
			existing.scheduledAt = computeScheduledAt(existing, opts);
			return {
				outcome: "coalesce",
				activeRunId: existing.activeRunId,
				scheduledAt: existing.scheduledAt,
				pingCount: existing.pingCount,
			};
		},
		async finalize(
			workflowName: string,
			debounceKey: string,
			runId: string,
			now: number,
		): Promise<DebounceFinalizeResult> {
			const key = `${workflowName}__${debounceKey}`;
			const doc = bus.buckets.get(key);
			if (!doc) return { finalize: "abandoned" };
			if (doc.activeRunId !== runId) return { finalize: "abandoned" };
			if (now < doc.scheduledAt) return { finalize: "reschedule", scheduledAt: doc.scheduledAt };
			bus.buckets.delete(key);
			return { finalize: "fire" };
		},
		async cancel(workflowName: string, debounceKey: string): Promise<boolean> {
			return bus.buckets.delete(`${workflowName}__${debounceKey}`);
		},
		async purgeExpired(now: number): Promise<number> {
			let n = 0;
			for (const [k, doc] of bus.buckets.entries()) {
				if (doc.ownerLeaseExpiresAt <= now && doc.scheduledAt <= now) {
					bus.buckets.delete(k);
					n++;
				}
			}
			return n;
		},
	};
}

describe("DebounceCoordinator — cross-process orchestration (Tier C #1)", () => {
	beforeEach(() => {
		DebounceCoordinator.resetInstance();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		DebounceCoordinator.resetInstance();
	});

	it("first ping in the cluster becomes owner; the OWNER's local timer fires", async () => {
		const bus = new FakeBus();
		const co = DebounceCoordinator.getInstance();
		co.setBackend(makeBackend(bus, "A"));
		const fire = vi.fn(async () => undefined);

		const res = await co.register({
			workflowName: "wf",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_1",
			onFire: fire,
		});
		expect(res.outcome).toBe("schedule-trailing");
		expect(res.activeRunId).toBe("run_1");
		expect(bus.buckets.size).toBe(1);

		await vi.advanceTimersByTimeAsync(500);
		expect(fire).toHaveBeenCalledTimes(1);
		expect(bus.buckets.size).toBe(0); // finalize=fire deletes the bucket
	});

	it("non-owner process coalesces", async () => {
		const bus = new FakeBus();
		const coA = DebounceCoordinator.getInstance();
		coA.setBackend(makeBackend(bus, "A"));
		DebounceCoordinator.resetInstance();

		// Process A's coordinator.
		const procA = DebounceCoordinator.getInstance();
		procA.setBackend(makeBackend(bus, "A"));
		const fireA = vi.fn(async () => undefined);
		const a = await procA.register({
			workflowName: "wf",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_A",
			onFire: fireA,
		});
		expect(a.outcome).toBe("schedule-trailing");

		// Process B's coordinator — fresh singleton + same bus. Different
		// processId (the coordinator generates its own).
		DebounceCoordinator.resetInstance();
		const procB = DebounceCoordinator.getInstance();
		procB.setBackend(makeBackend(bus, "B"));
		const fireB = vi.fn(async () => undefined);
		const b = await procB.register({
			workflowName: "wf",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_B",
			onFire: fireB,
		});
		expect(b.outcome).toBe("coalesce");
		expect(b.activeRunId).toBe("run_A");
		// Process B has NO local timer for this bucket.
		expect(procB.size()).toBe(0);

		// Advance — process A's timer is what should fire. (resetInstance discarded procA's coordinator state too, so the fire won't happen via procA; but the bus still has the row and B has no local timer for it. That's the expected single-owner-survives semantic.)
		await vi.advanceTimersByTimeAsync(500);
		expect(fireB).not.toHaveBeenCalled();
	});

	it("owner-death lease expiry → next ping takes over", async () => {
		const bus = new FakeBus();
		DebounceCoordinator.resetInstance();
		const procA = DebounceCoordinator.getInstance();
		procA.setOwnerLeaseMs(1_000); // short lease for the test
		procA.setBackend(makeBackend(bus, "A"));
		const fireA = vi.fn(async () => undefined);
		await procA.register({
			workflowName: "wf",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 5_000,
			runId: "run_A",
			onFire: fireA,
		});
		// Bus shows A as owner.
		const docBeforeHandoff = bus.buckets.get("wf__k");
		expect(docBeforeHandoff?.activeRunId).toBe("run_A");

		// Move time past A's owner-lease (1s). A is now considered dead.
		await vi.advanceTimersByTimeAsync(2_000);

		// Process B pings — should take over.
		DebounceCoordinator.resetInstance();
		const procB = DebounceCoordinator.getInstance();
		procB.setOwnerLeaseMs(60_000);
		procB.setBackend(makeBackend(bus, "B"));
		const fireB = vi.fn(async () => undefined);
		const b = await procB.register({
			workflowName: "wf",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_B",
			onFire: fireB,
		});
		expect(b.outcome).toBe("schedule-trailing");
		expect(b.activeRunId).toBe("run_B");
		expect(bus.buckets.get("wf__k")?.activeRunId).toBe("run_B");

		await vi.advanceTimersByTimeAsync(500);
		expect(fireB).toHaveBeenCalledTimes(1);
	});

	it("local timer fire on bucket pushed by other processes reschedules instead of firing", async () => {
		const bus = new FakeBus();
		DebounceCoordinator.resetInstance();
		const procA = DebounceCoordinator.getInstance();
		procA.setBackend(makeBackend(bus, "A"));
		const fireA = vi.fn(async () => undefined);
		await procA.register({
			workflowName: "wf",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_A",
			onFire: fireA,
		});

		// Other-process ping pushes scheduledAt forward.
		await vi.advanceTimersByTimeAsync(300);
		const backendOther = makeBackend(bus, "OTHER");
		await backendOther.registerPing({
			workflowName: "wf",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_OTHER",
			processId: "proc_OTHER",
			ownerLeaseMs: 60_000,
			now: Date.now(),
		});

		// A's local timer fires at the original scheduledAt — should
		// reschedule because the bus's scheduledAt was pushed.
		await vi.advanceTimersByTimeAsync(200); // total 500ms
		expect(fireA).not.toHaveBeenCalled();

		// After the new scheduledAt elapses (~800ms total), A fires.
		await vi.advanceTimersByTimeAsync(500);
		expect(fireA).toHaveBeenCalledTimes(1);
	});

	it("backend failure on registerPing falls back to in-memory window (fail-open)", async () => {
		DebounceCoordinator.resetInstance();
		const co = DebounceCoordinator.getInstance();
		const throwing: DebounceBackend = {
			name: "throwing",
			async connect() {},
			async disconnect() {},
			async registerPing() {
				throw new Error("broker down");
			},
			async finalize() {
				return { finalize: "abandoned" };
			},
			async cancel() {
				return false;
			},
			async purgeExpired() {
				return 0;
			},
		};
		co.setBackend(throwing);
		const fire = vi.fn(async () => undefined);
		const res = await co.register({
			workflowName: "wf",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_1",
			onFire: fire,
		});
		// Fell back to local — schedule-trailing emitted from the local fast path.
		expect(res.outcome).toBe("schedule-trailing");
		await vi.advanceTimersByTimeAsync(500);
		expect(fire).toHaveBeenCalledTimes(1);
	});

	it("leading mode owner-new outcome translates to fire-immediate", async () => {
		const bus = new FakeBus();
		DebounceCoordinator.resetInstance();
		const co = DebounceCoordinator.getInstance();
		co.setBackend(makeBackend(bus, "A"));
		const fire = vi.fn(async () => undefined);
		const res = await co.register({
			workflowName: "wf",
			debounceKey: "k",
			mode: "leading",
			delayMs: 1_000,
			runId: "run_1",
			onFire: fire,
		});
		expect(res.outcome).toBe("fire-immediate");
		// Coordinator does NOT call onFire for leading (caller does).
		expect(fire).not.toHaveBeenCalled();
	});

	it("leading mode coalesces subsequent pings within the window", async () => {
		const bus = new FakeBus();
		DebounceCoordinator.resetInstance();
		const co = DebounceCoordinator.getInstance();
		co.setBackend(makeBackend(bus, "A"));
		const fire = vi.fn(async () => undefined);
		await co.register({
			workflowName: "wf",
			debounceKey: "k",
			mode: "leading",
			delayMs: 1_000,
			runId: "run_1",
			onFire: fire,
		});
		const second = await co.register({
			workflowName: "wf",
			debounceKey: "k",
			mode: "leading",
			delayMs: 1_000,
			runId: "run_2",
			onFire: fire,
		});
		// Same processId — owner-extend in the backend, which maps to local "coalesce" outcome for leading.
		expect(second.outcome).toBe("coalesce");
	});

	it("cancel deletes the bus bucket AND clears the local timer", async () => {
		const bus = new FakeBus();
		DebounceCoordinator.resetInstance();
		const co = DebounceCoordinator.getInstance();
		co.setBackend(makeBackend(bus, "A"));
		const fire = vi.fn(async () => undefined);
		await co.register({
			workflowName: "wf",
			debounceKey: "k",
			mode: "trailing",
			delayMs: 500,
			runId: "run_1",
			onFire: fire,
		});
		expect(bus.buckets.size).toBe(1);

		const cancelled = await co.cancel("wf", "k");
		expect(cancelled).toBe(true);
		expect(bus.buckets.size).toBe(0);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(fire).not.toHaveBeenCalled();
	});
});
