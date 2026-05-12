import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RedisDebounceBackend } from "../../src/scheduling/RedisDebounceBackend";

/**
 * Real-Redis integration test for `RedisDebounceBackend` (Tier C #1).
 *
 * Closes the integration test debt deferred when PR #90 shipped. Validates
 * that the Lua scripts (REGISTER_PING / FINALIZE / PURGE_EXPIRED_BUCKET)
 * work against a real Redis server.
 *
 * Gated on `BLOK_INTEGRATION_REDIS_URL`. Skipped when unset.
 */

const REDIS_URL = process.env.BLOK_INTEGRATION_REDIS_URL;
const d = REDIS_URL ? describe : describe.skip;

const baseOpts = (overrides?: Partial<Parameters<RedisDebounceBackend["registerPing"]>[0]>) => ({
	workflowName: "wf",
	debounceKey: "k",
	mode: "trailing" as const,
	delayMs: 500,
	maxDelayMs: undefined,
	runId: "run_1",
	processId: "proc_A",
	ownerLeaseMs: 60_000,
	now: Date.now(),
	...overrides,
});

d("RedisDebounceBackend — real Redis", () => {
	let backendA: RedisDebounceBackend;
	let backendB: RedisDebounceBackend;
	const prefix = `blok-test-c1-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

	beforeAll(async () => {
		backendA = new RedisDebounceBackend({ url: REDIS_URL, keyPrefix: prefix });
		await backendA.connect();
		backendB = new RedisDebounceBackend({ url: REDIS_URL, keyPrefix: prefix });
		await backendB.connect();
	});

	afterAll(async () => {
		await backendA.purgeExpired(Date.now() + 60 * 60 * 1000);
		await backendA.disconnect();
		await backendB.disconnect();
	});

	beforeEach(async () => {
		await backendA.purgeExpired(Date.now() + 60 * 60 * 1000);
	});

	afterEach(async () => {
		await backendA.purgeExpired(Date.now() + 60 * 60 * 1000);
	});

	it("first ping returns owner-new", async () => {
		const now = Date.now();
		const res = await backendA.registerPing(baseOpts({ debounceKey: "k1", now }));
		expect(res.outcome).toBe("owner-new");
		expect(res.activeRunId).toBe("run_1");
		expect(res.pingCount).toBe(1);
		expect(res.scheduledAt).toBe(now + 500);
	});

	it("same process pinging again returns owner-extend", async () => {
		const now = Date.now();
		await backendA.registerPing(baseOpts({ debounceKey: "k2", now }));
		const second = await backendA.registerPing(baseOpts({ debounceKey: "k2", runId: "run_2", now: now + 200 }));
		expect(second.outcome).toBe("owner-extend");
		expect(second.activeRunId).toBe("run_1");
		expect(second.pingCount).toBe(2);
		expect(second.scheduledAt).toBe(now + 200 + 500);
	});

	it("different process pinging returns coalesce", async () => {
		const now = Date.now();
		await backendA.registerPing(baseOpts({ debounceKey: "k3", now }));
		const second = await backendB.registerPing(
			baseOpts({ debounceKey: "k3", processId: "proc_B", runId: "r2", now: now + 200 }),
		);
		expect(second.outcome).toBe("coalesce");
		expect(second.activeRunId).toBe("run_1");
	});

	it("owner-lease expired allows takeover via owner-new", async () => {
		const now = Date.now();
		await backendA.registerPing(baseOpts({ debounceKey: "k4", ownerLeaseMs: 1, now }));
		// Wait past the 1ms lease.
		await new Promise((r) => setTimeout(r, 20));
		const takeover = await backendB.registerPing(
			baseOpts({ debounceKey: "k4", processId: "proc_B", runId: "takeover", now: Date.now() }),
		);
		expect(takeover.outcome).toBe("owner-new");
		expect(takeover.activeRunId).toBe("takeover");
	});

	it("finalize fires when owner still owns AND scheduledAt elapsed", async () => {
		const now = Date.now();
		const reg = await backendA.registerPing(baseOpts({ debounceKey: "k5", now }));
		const res = await backendA.finalize("wf", "k5", reg.activeRunId, now + 600);
		expect(res.finalize).toBe("fire");
	});

	it("finalize reschedules when scheduledAt pushed by coalesce ping from another process", async () => {
		const now = Date.now();
		const reg = await backendA.registerPing(baseOpts({ debounceKey: "k6", now }));
		// Coalesce ping pushes scheduledAt forward.
		await backendB.registerPing(baseOpts({ debounceKey: "k6", processId: "proc_B", runId: "r2", now: now + 300 }));
		// Owner finalize at original scheduledAt — should reschedule, not fire.
		const res = await backendA.finalize("wf", "k6", reg.activeRunId, now + 500);
		expect(res.finalize).toBe("reschedule");
		if (res.finalize !== "reschedule") return;
		expect(res.scheduledAt).toBe(now + 300 + 500);
	});

	it("finalize abandoned when runId no longer owns (lease handoff happened)", async () => {
		const now = Date.now();
		await backendA.registerPing(baseOpts({ debounceKey: "k7", ownerLeaseMs: 1, now }));
		await new Promise((r) => setTimeout(r, 20));
		await backendB.registerPing(
			baseOpts({ debounceKey: "k7", processId: "proc_B", runId: "owner_b", now: Date.now() }),
		);
		// Original owner tries to finalize — should be abandoned.
		const res = await backendA.finalize("wf", "k7", "run_1", Date.now() + 600);
		expect(res.finalize).toBe("abandoned");
	});

	it("cancel deletes an active bucket", async () => {
		await backendA.registerPing(baseOpts({ debounceKey: "k8" }));
		const cancelled = await backendA.cancel("wf", "k8");
		expect(cancelled).toBe(true);
		const after = await backendA.cancel("wf", "k8");
		expect(after).toBe(false);
	});

	it("contended registerPing from two instances elects exactly one owner", async () => {
		const key = `contention-${Math.random().toString(36).slice(2)}`;
		const now = Date.now();
		const [r1, r2] = await Promise.all([
			backendA.registerPing(baseOpts({ debounceKey: key, processId: "proc_A", runId: "p1-run", now })),
			backendB.registerPing(baseOpts({ debounceKey: key, processId: "proc_B", runId: "p2-run", now })),
		]);
		const owners = [r1, r2].filter((r) => r.outcome === "owner-new");
		const losers = [r1, r2].filter((r) => r.outcome === "coalesce");
		// Lua atomicity: exactly one process wins owner-new; the other sees
		// the freshly-installed lease and coalesces.
		expect(owners.length).toBe(1);
		expect(losers.length).toBe(1);
		// The coalescer's activeRunId points at the winning runId.
		const winnerRunId = owners[0].activeRunId;
		expect(losers[0].activeRunId).toBe(winnerRunId);
	});
});
