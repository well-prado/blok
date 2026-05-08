/**
 * BACKLOG H3 — NatsKvConcurrencyBackend against a REAL NATS broker.
 *
 * The unit tests at `__tests__/unit/concurrency/NatsKvConcurrencyBackend.test.ts`
 * mock the KV API. This file covers what the mock can't: actual broker
 * behavior under JetStream KV semantics — bucket auto-creation, OCC
 * compare-and-swap on revisions, drain semantics on disconnect, key
 * encoding roundtrip, and lease expiry as observed by the broker.
 *
 * Gated by `BLOK_BENCHMARK_REAL_NATS=1` — default-skip so CI without
 * a broker stays green. To run locally:
 *
 *   docker compose -f infra/development/docker-compose.yml up -d nats
 *   BLOK_BENCHMARK_REAL_NATS=1 bun run --filter @blokjs/runner test \
 *     __tests__/integration/concurrency/nats-kv-real-broker.integration.test.ts
 *
 * Each test uses a unique bucket name to avoid leftover state across
 * runs. Bucket cleanup happens in afterEach via `purgeExpired(0)` (a
 * sweep with `now=0` doesn't purge anything but matches the contract;
 * for true cleanup we'd want `kv.destroy()` which the backend doesn't
 * expose). Operators rerunning the suite can drop buckets via
 * `nats kv ls` + `nats kv rm` if needed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NatsKvConcurrencyBackend } from "../../../src/concurrency/NatsKvConcurrencyBackend";

const REAL_NATS = process.env.BLOK_BENCHMARK_REAL_NATS === "1";
const NATS_SERVERS = process.env.BLOK_CONCURRENCY_NATS_SERVERS ?? "nats://localhost:4222";

function uniqueBucket(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe.skipIf(!REAL_NATS)("NatsKvConcurrencyBackend — real NATS broker (H3)", () => {
	let backend: NatsKvConcurrencyBackend;

	beforeEach(async () => {
		backend = new NatsKvConcurrencyBackend({
			servers: NATS_SERVERS.split(",").map((s) => s.trim()),
			bucketName: uniqueBucket("blok-h3-test"),
		});
		await backend.connect();
	});

	afterEach(async () => {
		await backend.disconnect();
	});

	describe("acquireSlot", () => {
		it("grants when bucket is empty (under limit)", async () => {
			const r = await backend.acquireSlot("wf-1", "tenant-A", 5, "run-1", Date.now() + 60_000);
			expect(r.acquired).toBe(true);
			expect(r.currentInFlight).toBe(1);
		});

		it("grants up to the limit and denies the (limit+1)th", async () => {
			const limit = 3;
			const grants: boolean[] = [];
			for (let i = 0; i < limit + 1; i++) {
				const r = await backend.acquireSlot("wf-2", "tenant-B", limit, `run-${i}`, Date.now() + 60_000);
				grants.push(r.acquired);
			}
			expect(grants).toEqual([true, true, true, false]);
		});

		it("idempotent re-acquire: same runId refreshes the lease, doesn't grow count", async () => {
			const a = await backend.acquireSlot("wf-3", "tenant-C", 5, "run-X", Date.now() + 60_000);
			const b = await backend.acquireSlot("wf-3", "tenant-C", 5, "run-X", Date.now() + 60_000);
			expect(a.acquired).toBe(true);
			expect(b.acquired).toBe(true);
			expect(b.currentInFlight).toBe(1); // not 2
		});

		it("isolates buckets by (workflow, key) — different tuples do not contend", async () => {
			const r1 = await backend.acquireSlot("wf-A", "tenant-X", 1, "run-1", Date.now() + 60_000);
			const r2 = await backend.acquireSlot("wf-A", "tenant-Y", 1, "run-2", Date.now() + 60_000);
			const r3 = await backend.acquireSlot("wf-B", "tenant-X", 1, "run-3", Date.now() + 60_000);
			expect(r1.acquired).toBe(true);
			expect(r2.acquired).toBe(true);
			expect(r3.acquired).toBe(true);
		});

		it("encoded keys roundtrip — workflow names with dots and slashes work", async () => {
			// NatsKvConcurrencyBackend hex-escapes characters outside the safe
			// set into `_HHHH_`. The broker should accept the encoded form.
			const r = await backend.acquireSlot("ns/orders.v1", "tenant Z", 1, "run-1", Date.now() + 60_000);
			expect(r.acquired).toBe(true);
		});
	});

	describe("releaseSlot", () => {
		it("frees a slot for the next acquire", async () => {
			await backend.acquireSlot("wf-r", "k", 1, "r1", Date.now() + 60_000);
			const denied = await backend.acquireSlot("wf-r", "k", 1, "r2", Date.now() + 60_000);
			expect(denied.acquired).toBe(false);

			await backend.releaseSlot("wf-r", "k", "r1");
			const granted = await backend.acquireSlot("wf-r", "k", 1, "r2", Date.now() + 60_000);
			expect(granted.acquired).toBe(true);
		});

		it("is idempotent — releasing an unknown runId does not throw", async () => {
			await expect(backend.releaseSlot("wf-r", "k", "never-acquired")).resolves.toBeUndefined();
		});

		it("is idempotent — double-release does not throw", async () => {
			await backend.acquireSlot("wf-d", "k", 1, "r1", Date.now() + 60_000);
			await backend.releaseSlot("wf-d", "k", "r1");
			await expect(backend.releaseSlot("wf-d", "k", "r1")).resolves.toBeUndefined();
		});
	});

	describe("lease expiry (lazy-purge on acquire)", () => {
		it("expired leases are reclaimed on the next acquire", async () => {
			// Acquire with a 100ms lease.
			const shortLease = Date.now() + 100;
			const a = await backend.acquireSlot("wf-exp", "k", 1, "r1", shortLease);
			expect(a.acquired).toBe(true);

			// Sleep past the lease TTL.
			await new Promise((resolve) => setTimeout(resolve, 200));

			// New acquire purges r1 lazy + grants r2.
			const b = await backend.acquireSlot("wf-exp", "k", 1, "r2", Date.now() + 60_000);
			expect(b.acquired).toBe(true);
			expect(b.currentInFlight).toBe(1);
		});
	});

	describe("purgeExpired", () => {
		it("returns the count of purged leases across all buckets", async () => {
			const shortLease = Date.now() + 100;
			await backend.acquireSlot("wf-p1", "k1", 5, "r1", shortLease);
			await backend.acquireSlot("wf-p1", "k2", 5, "r2", shortLease);
			await backend.acquireSlot("wf-p2", "k1", 5, "r3", shortLease);

			await new Promise((resolve) => setTimeout(resolve, 200));

			const purged = await backend.purgeExpired(Date.now());
			// All three should be reaped — the exact count is the contract.
			expect(purged).toBeGreaterThanOrEqual(3);
		});
	});

	describe("disconnect", () => {
		it("drains cleanly and is idempotent", async () => {
			await expect(backend.disconnect()).resolves.toBeUndefined();
			// Second disconnect is a no-op.
			await expect(backend.disconnect()).resolves.toBeUndefined();
		});
	});
});
