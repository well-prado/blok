import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NatsKvDebounceBackend } from "../../src/scheduling/NatsKvDebounceBackend";

/**
 * Real-NATS integration test for `NatsKvDebounceBackend` (Tier C #1).
 *
 * Closes the integration test debt deferred when PR #90 shipped for the
 * NATS KV backend. Fake-KV unit tests cover the contract; this suite
 * exercises real CAS, real network timing, and cross-instance
 * coordination.
 *
 * Gated on `BLOK_INTEGRATION_NATS_SERVERS`. Skipped when unset.
 */

const NATS_SERVERS = process.env.BLOK_INTEGRATION_NATS_SERVERS;
const d = NATS_SERVERS ? describe : describe.skip;

const baseOpts = (overrides?: Partial<Parameters<NatsKvDebounceBackend["registerPing"]>[0]>) => ({
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

d("NatsKvDebounceBackend — real NATS", () => {
	let backendA: NatsKvDebounceBackend;
	let backendB: NatsKvDebounceBackend;
	const bucket = `blok-test-d-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

	beforeAll(async () => {
		backendA = new NatsKvDebounceBackend({
			servers: NATS_SERVERS?.split(",").map((s) => s.trim()) ?? [],
			bucketName: bucket,
		});
		await backendA.connect();
		backendB = new NatsKvDebounceBackend({
			servers: NATS_SERVERS?.split(",").map((s) => s.trim()) ?? [],
			bucketName: bucket,
		});
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
		expect(res.scheduledAt).toBe(now + 500);
	});

	it("same process pinging again returns owner-extend", async () => {
		const now = Date.now();
		await backendA.registerPing(baseOpts({ debounceKey: "k2", now }));
		const second = await backendA.registerPing(baseOpts({ debounceKey: "k2", runId: "run_2", now: now + 200 }));
		expect(second.outcome).toBe("owner-extend");
		expect(second.activeRunId).toBe("run_1");
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

	it("finalize reschedules when coalesce ping pushed scheduledAt forward", async () => {
		const now = Date.now();
		const reg = await backendA.registerPing(baseOpts({ debounceKey: "k6", now }));
		await backendB.registerPing(baseOpts({ debounceKey: "k6", processId: "proc_B", runId: "r2", now: now + 300 }));
		const res = await backendA.finalize("wf", "k6", reg.activeRunId, now + 500);
		expect(res.finalize).toBe("reschedule");
		if (res.finalize !== "reschedule") return;
		expect(res.scheduledAt).toBe(now + 300 + 500);
	});

	it("finalize abandoned when lease handoff happened", async () => {
		const now = Date.now();
		await backendA.registerPing(baseOpts({ debounceKey: "k7", ownerLeaseMs: 1, now }));
		await new Promise((r) => setTimeout(r, 20));
		await backendB.registerPing(
			baseOpts({ debounceKey: "k7", processId: "proc_B", runId: "owner_b", now: Date.now() }),
		);
		const res = await backendA.finalize("wf", "k7", "run_1", Date.now() + 600);
		expect(res.finalize).toBe("abandoned");
	});

	it("cancel deletes an active bucket", async () => {
		await backendA.registerPing(baseOpts({ debounceKey: "k8" }));
		const cancelled = await backendA.cancel("wf", "k8");
		expect(cancelled).toBe(true);
	});
});
