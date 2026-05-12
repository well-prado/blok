import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NatsKvConcurrencyBackend } from "../../src/concurrency/NatsKvConcurrencyBackend";

/**
 * Real-NATS integration test for `NatsKvConcurrencyBackend` (Tier H #3).
 *
 * Closes Tier H #3 from BACKLOG.md — fake-KV unit tests cover the CAS
 * loop, this suite catches NATS KV API quirks, real network round-trip
 * timing under contention, and cross-instance behavior.
 *
 * Gated on `BLOK_INTEGRATION_NATS_SERVERS`. Skipped when unset.
 *
 * Bring up the test fixtures via:
 *   docker compose -f infra/testing/docker-compose.yml up -d nats
 */

const NATS_SERVERS = process.env.BLOK_INTEGRATION_NATS_SERVERS;
const d = NATS_SERVERS ? describe : describe.skip;

d("NatsKvConcurrencyBackend — real NATS", () => {
	let backend: NatsKvConcurrencyBackend;
	let backend2: NatsKvConcurrencyBackend;
	const bucket = `blok-test-c-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

	beforeAll(async () => {
		backend = new NatsKvConcurrencyBackend({
			servers: NATS_SERVERS?.split(",").map((s) => s.trim()) ?? [],
			bucketName: bucket,
		});
		await backend.connect();
		backend2 = new NatsKvConcurrencyBackend({
			servers: NATS_SERVERS?.split(",").map((s) => s.trim()) ?? [],
			bucketName: bucket,
		});
		await backend2.connect();
	});

	afterAll(async () => {
		await backend.purgeExpired(Date.now() + 60 * 60 * 1000);
		await backend.disconnect();
		await backend2.disconnect();
	});

	beforeEach(async () => {
		await backend.purgeExpired(Date.now() + 60 * 60 * 1000);
	});

	afterEach(async () => {
		await backend.purgeExpired(Date.now() + 60 * 60 * 1000);
	});

	it("first acquire grants the slot in a fresh bucket", async () => {
		const result = await backend.acquireSlot("wf", "k1", 5, "run_1", Date.now() + 60_000);
		expect(result.acquired).toBe(true);
		expect(result.currentInFlight).toBe(1);
	});

	it("acquires up to the limit and denies the next", async () => {
		const expiry = Date.now() + 60_000;
		expect((await backend.acquireSlot("wf", "k2", 2, "run_1", expiry)).acquired).toBe(true);
		expect((await backend.acquireSlot("wf", "k2", 2, "run_2", expiry)).acquired).toBe(true);
		const denied = await backend.acquireSlot("wf", "k2", 2, "run_3", expiry);
		expect(denied.acquired).toBe(false);
		expect(denied.currentInFlight).toBe(2);
	});

	it("re-acquire with same runId refreshes lease without growing count", async () => {
		const first = await backend.acquireSlot("wf", "k3", 5, "run_1", Date.now() + 60_000);
		expect(first.acquired).toBe(true);
		const refresh = await backend.acquireSlot("wf", "k3", 5, "run_1", Date.now() + 120_000);
		expect(refresh.currentInFlight).toBe(1);
	});

	it("release frees the slot for the next acquire", async () => {
		await backend.acquireSlot("wf", "k4", 1, "run_1", Date.now() + 60_000);
		await backend.releaseSlot("wf", "k4", "run_1");
		const next = await backend.acquireSlot("wf", "k4", 1, "run_2", Date.now() + 60_000);
		expect(next.acquired).toBe(true);
	});

	it("two backend instances see the same state across processes", async () => {
		const r1 = await backend.acquireSlot("wf", "shared", 1, "p1-run", Date.now() + 60_000);
		expect(r1.acquired).toBe(true);
		const r2 = await backend2.acquireSlot("wf", "shared", 1, "p2-run", Date.now() + 60_000);
		expect(r2.acquired).toBe(false);
		await backend.releaseSlot("wf", "shared", "p1-run");
		const r3 = await backend2.acquireSlot("wf", "shared", 1, "p2-run", Date.now() + 60_000);
		expect(r3.acquired).toBe(true);
	});

	it("CAS contention from two instances resolves correctly under limit=1", async () => {
		const key = `contention-${Math.random().toString(36).slice(2)}`;
		const expiry = Date.now() + 60_000;
		// Many parallel attempts — only one should win at limit=1.
		const attempts = await Promise.all([
			backend.acquireSlot("wf", key, 1, "p1", expiry),
			backend2.acquireSlot("wf", key, 1, "p2", expiry),
		]);
		const grants = attempts.filter((r) => r.acquired);
		// OCC + bounded retry guarantees at most 1 grant; over-coalesce
		// fallback is not in the concurrency backend, so we must see
		// exactly 1.
		expect(grants.length).toBe(1);
	});

	it("lazy-purges expired leases on next acquire to same bucket", async () => {
		const past = Date.now() - 1000;
		await backend.acquireSlot("wf", "expiring", 1, "dead", past);
		const fresh = await backend.acquireSlot("wf", "expiring", 1, "alive", Date.now() + 60_000);
		expect(fresh.acquired).toBe(true);
		expect(fresh.currentInFlight).toBe(1);
	});

	it("purgeExpired sweeps every bucket and reports the count", async () => {
		const past = Date.now() - 1000;
		const future = Date.now() + 60_000;
		await backend.acquireSlot("wf", "purge-alive", 5, "alive", future);
		await backend.acquireSlot("wf", "purge-dead", 5, "dead", past);
		const purged = await backend.purgeExpired(Date.now());
		expect(purged).toBeGreaterThanOrEqual(1);
	});
});
