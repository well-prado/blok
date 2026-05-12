import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RedisConcurrencyBackend } from "../../src/concurrency/RedisConcurrencyBackend";

/**
 * Real-Redis integration test for `RedisConcurrencyBackend` (Tier C #4).
 *
 * Closes the integration test debt deferred when PR #89 shipped. Validates
 * that the Lua scripts (ACQUIRE / RELEASE / PURGE_BUCKET) work against a
 * real Redis server — fake-ioredis unit tests cover the contract, this
 * suite catches cjson encoding regressions, real ioredis quirks, and
 * cross-backend instance contention.
 *
 * Gated on `BLOK_INTEGRATION_REDIS_URL`. Skipped when unset (so local
 * `bun run test` doesn't require a docker-compose).
 *
 * Bring up the test fixtures via `docker compose -f infra/testing/docker-compose.yml up -d redis`.
 */

const REDIS_URL = process.env.BLOK_INTEGRATION_REDIS_URL;
const d = REDIS_URL ? describe : describe.skip;

d("RedisConcurrencyBackend — real Redis", () => {
	let backend: RedisConcurrencyBackend;
	let backend2: RedisConcurrencyBackend;

	// Unique prefix per test run so concurrent CI jobs don't collide on a
	// shared Redis. Sufficient isolation without DB switching.
	const prefix = `blok-test-c4-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

	beforeAll(async () => {
		backend = new RedisConcurrencyBackend({ url: REDIS_URL, keyPrefix: prefix });
		await backend.connect();
		// Second backend instance against the same Redis to simulate a
		// second process under contention.
		backend2 = new RedisConcurrencyBackend({ url: REDIS_URL, keyPrefix: prefix });
		await backend2.connect();
	});

	afterAll(async () => {
		// Best-effort sweep — drop anything left over.
		await backend.purgeExpired(Date.now() + 60 * 60 * 1000);
		await backend.disconnect();
		await backend2.disconnect();
	});

	beforeEach(async () => {
		// Sweep before each test so prior leaks don't leak between cases.
		await backend.purgeExpired(Date.now() + 60 * 60 * 1000);
	});

	afterEach(async () => {
		await backend.purgeExpired(Date.now() + 60 * 60 * 1000);
	});

	it("first acquire creates the bucket and grants the slot", async () => {
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

	it("re-acquire with same runId refreshes the lease without growing count", async () => {
		const first = await backend.acquireSlot("wf", "k3", 5, "run_1", Date.now() + 60_000);
		expect(first.acquired).toBe(true);
		const refresh = await backend.acquireSlot("wf", "k3", 5, "run_1", Date.now() + 120_000);
		expect(refresh.acquired).toBe(true);
		expect(refresh.currentInFlight).toBe(1);
	});

	it("release frees the slot for the next acquire", async () => {
		await backend.acquireSlot("wf", "k4", 1, "run_1", Date.now() + 60_000);
		await backend.releaseSlot("wf", "k4", "run_1");
		const next = await backend.acquireSlot("wf", "k4", 1, "run_2", Date.now() + 60_000);
		expect(next.acquired).toBe(true);
		expect(next.currentInFlight).toBe(1);
	});

	it("releaseSlot of an unknown runId is idempotent", async () => {
		await expect(backend.releaseSlot("wf", "k5", "ghost")).resolves.toBeUndefined();
	});

	it("isolates buckets across workflow + key", async () => {
		const expiry = Date.now() + 60_000;
		expect((await backend.acquireSlot("wfA", "k", 1, "a", expiry)).acquired).toBe(true);
		expect((await backend.acquireSlot("wfB", "k", 1, "b", expiry)).acquired).toBe(true);
		expect((await backend.acquireSlot("wfA", "k2", 1, "c", expiry)).acquired).toBe(true);
	});

	it("two backend instances (simulating two processes) see the same state", async () => {
		// Process 1 takes the slot.
		const r1 = await backend.acquireSlot("wf", "shared", 1, "p1-run", Date.now() + 60_000);
		expect(r1.acquired).toBe(true);

		// Process 2 tries — should be denied since the bucket is at limit.
		const r2 = await backend2.acquireSlot("wf", "shared", 1, "p2-run", Date.now() + 60_000);
		expect(r2.acquired).toBe(false);
		expect(r2.currentInFlight).toBe(1);

		// Process 1 releases.
		await backend.releaseSlot("wf", "shared", "p1-run");

		// Process 2 retries — should now succeed.
		const r3 = await backend2.acquireSlot("wf", "shared", 1, "p2-run", Date.now() + 60_000);
		expect(r3.acquired).toBe(true);
	});

	it("lazy-purges expired leases on next acquire to the same bucket", async () => {
		const past = Date.now() - 1000;
		await backend.acquireSlot("wf", "expiring", 1, "dead", past);
		const fresh = await backend.acquireSlot("wf", "expiring", 1, "alive", Date.now() + 60_000);
		expect(fresh.acquired).toBe(true);
		expect(fresh.currentInFlight).toBe(1);
	});

	it("purgeExpired reports the count of purged leases across buckets", async () => {
		const past = Date.now() - 1000;
		const future = Date.now() + 60_000;
		await backend.acquireSlot("wf", "alive-purge", 5, "alive", future);
		await backend.acquireSlot("wf", "dead-purge", 5, "dead", past);
		const purged = await backend.purgeExpired(Date.now());
		expect(purged).toBeGreaterThanOrEqual(1);
	});

	it("encodes non-safe characters in workflow + key segments", async () => {
		// `:` is part of the prefix delimiter; the encoder must escape it
		// inside segments to keep the key parser unambiguous.
		const result = await backend.acquireSlot("wf:colon", "k:colon", 1, "run_1", Date.now() + 60_000);
		expect(result.acquired).toBe(true);
	});

	it("contended acquire from two instances against limit=1 grants exactly one", async () => {
		const key = `contention-${Math.random().toString(36).slice(2)}`;
		const expiry = Date.now() + 60_000;
		const [r1, r2] = await Promise.all([
			backend.acquireSlot("wf", key, 1, "p1-run", expiry),
			backend2.acquireSlot("wf", key, 1, "p2-run", expiry),
		]);
		const grants = [r1, r2].filter((r) => r.acquired);
		// Lua atomicity guarantees exactly one acquires; the other sees the
		// freshly-inserted lease and denies.
		expect(grants.length).toBe(1);
	});
});
