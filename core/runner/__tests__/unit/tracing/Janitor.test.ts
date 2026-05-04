import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryRunStore } from "../../../src/tracing/InMemoryRunStore";
import { Janitor } from "../../../src/tracing/Janitor";

describe("Janitor (Tier 2 follow-up · periodic storage cleanup)", () => {
	beforeEach(() => {
		Janitor.resetInstance();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		Janitor.resetInstance();
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	it("getInstance returns a singleton; subsequent calls don't replace it", () => {
		const store = new InMemoryRunStore();
		const a = Janitor.getInstance(store);
		const b = Janitor.getInstance(store);
		expect(a).toBe(b);
	});

	it("runOnce purges past-TTL idempotency cache, expired locks, and expired dispatches", async () => {
		const store = new InMemoryRunStore();
		const past = Date.now() - 1000;
		const future = Date.now() + 60_000;

		// Idempotency cache — expired entry.
		store.setIdempotencyCache("wf", "step", "key1", {
			data: { x: 1 },
			cachedAt: past,
			expiresAt: past,
			sourceRunId: "src",
			sourceNodeRunId: "src-node",
		});

		// Concurrency lock — expired lease.
		store.acquireConcurrencySlot("wf", "k", 5, "run_dead", past);

		// Scheduled dispatch — past TTL.
		store.upsertScheduledDispatch({
			runId: "disp_dead",
			workflowName: "wf",
			triggerType: "http",
			scheduledAt: past,
			expiresAt: past,
			dispatchStatus: "delayed",
			payload: null,
			createdAt: past,
		});

		// Live dispatch (no TTL) — should NOT be purged.
		store.upsertScheduledDispatch({
			runId: "disp_live",
			workflowName: "wf",
			triggerType: "http",
			scheduledAt: future,
			dispatchStatus: "delayed",
			payload: null,
			createdAt: Date.now(),
		});

		const stats = await Janitor.getInstance(store).runOnce();

		expect(stats.idempotencyCachePurged).toBe(1);
		expect(stats.concurrencySlotsPurged).toBe(1);
		expect(stats.scheduledDispatchesPurged).toBe(1);
		expect(stats.durationMs).toBeGreaterThanOrEqual(0);

		// Live dispatch survives.
		expect(store.getScheduledDispatches().length).toBe(1);
		expect(store.getScheduledDispatches()[0].runId).toBe("disp_live");
	});

	it("start registers an interval timer; stop clears it", () => {
		vi.useFakeTimers();
		const store = new InMemoryRunStore();
		const j = Janitor.getInstance(store);

		expect(j.isRunning()).toBe(false);
		const started = j.start(60_000);
		expect(started).toBe(true);
		expect(j.isRunning()).toBe(true);

		j.stop();
		expect(j.isRunning()).toBe(false);
	});

	it("start is idempotent — second call returns false without replacing the timer", () => {
		vi.useFakeTimers();
		const store = new InMemoryRunStore();
		const j = Janitor.getInstance(store);

		expect(j.start(60_000)).toBe(true);
		expect(j.start(60_000)).toBe(false);
		expect(j.isRunning()).toBe(true);
	});

	it("start respects BLOK_JANITOR_DISABLED=1 (no-op)", () => {
		vi.stubEnv("BLOK_JANITOR_DISABLED", "1");
		const store = new InMemoryRunStore();
		const j = Janitor.getInstance(store);
		expect(j.start()).toBe(false);
		expect(j.isRunning()).toBe(false);
	});

	it("start reads BLOK_JANITOR_INTERVAL_MS env var", async () => {
		vi.useFakeTimers();
		vi.stubEnv("BLOK_JANITOR_INTERVAL_MS", "100");
		const store = new InMemoryRunStore();
		const past = Date.now() - 1000;
		store.upsertScheduledDispatch({
			runId: "d1",
			workflowName: "w",
			triggerType: "http",
			scheduledAt: past,
			expiresAt: past,
			dispatchStatus: "delayed",
			payload: null,
			createdAt: past,
		});

		const j = Janitor.getInstance(store);
		j.start();

		// Advance past one interval — sweep should have run.
		await vi.advanceTimersByTimeAsync(150);
		await Promise.resolve();

		expect(store.getScheduledDispatches().length).toBe(0);
	});

	it("runOnce serializes overlapping invocations (in-flight guard)", async () => {
		const store = new InMemoryRunStore();
		const j = Janitor.getInstance(store);

		const past = Date.now() - 1000;
		store.upsertScheduledDispatch({
			runId: "d1",
			workflowName: "w",
			triggerType: "http",
			scheduledAt: past,
			expiresAt: past,
			dispatchStatus: "delayed",
			payload: null,
			createdAt: past,
		});

		const [a, b] = await Promise.all([j.runOnce(), j.runOnce()]);
		// One should report the purge (1 row); the other returns 0 stats.
		const purgedTotals = [a, b].map((s) => s.scheduledDispatchesPurged);
		expect(purgedTotals.sort()).toEqual([0, 1]);
	});

	it("a failing purge method does not abort the others", async () => {
		const store = new InMemoryRunStore();
		// Force purgeExpiredIdempotencyCache to throw.
		const original = store.purgeExpiredIdempotencyCache.bind(store);
		store.purgeExpiredIdempotencyCache = (() => {
			throw new Error("boom");
		}) as unknown as typeof store.purgeExpiredIdempotencyCache;

		const past = Date.now() - 1000;
		store.acquireConcurrencySlot("wf", "k", 1, "dead", past);

		const j = Janitor.getInstance(store);
		const stats = await j.runOnce();

		// The failing purge reports 0; the others still ran.
		expect(stats.idempotencyCachePurged).toBe(0);
		expect(stats.concurrencySlotsPurged).toBe(1);

		// Restore for cleanup.
		store.purgeExpiredIdempotencyCache = original;
	});
});
