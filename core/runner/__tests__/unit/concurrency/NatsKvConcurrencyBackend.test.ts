import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NatsKvConcurrencyBackend } from "../../../src/concurrency/NatsKvConcurrencyBackend";

/**
 * Mock NATS KV — small in-memory implementation that mirrors enough of
 * the NATS KV semantics (revision-based CAS, create-vs-update) to drive
 * the backend's CAS loop end-to-end.
 */
function makeFakeKv() {
	const data = new Map<string, { value: string; revision: number }>();
	let revisionCounter = 1;

	return {
		_data: data,
		async get(key: string) {
			const entry = data.get(key);
			if (!entry) return null;
			return {
				key,
				revision: entry.revision,
				string: () => entry.value,
				json<T>(): T {
					return JSON.parse(entry.value) as T;
				},
			};
		},
		async create(key: string, value: string) {
			if (data.has(key)) throw new Error("key exists");
			revisionCounter++;
			data.set(key, { value, revision: revisionCounter });
			return revisionCounter;
		},
		async update(key: string, value: string, expectedRevision: number) {
			const entry = data.get(key);
			if (!entry) throw new Error("key not found");
			if (entry.revision !== expectedRevision) throw new Error("revision mismatch");
			revisionCounter++;
			data.set(key, { value, revision: revisionCounter });
			return revisionCounter;
		},
		async delete(key: string) {
			data.delete(key);
		},
		async *keys() {
			for (const k of data.keys()) yield k;
		},
	};
}

interface FakeKv {
	_data: Map<string, { value: string; revision: number }>;
}

/**
 * Helper to install a connected backend with a fake KV (skipping the real
 * `nats` import).
 */
function installBackend(): { backend: NatsKvConcurrencyBackend; kv: FakeKv } {
	const backend = new NatsKvConcurrencyBackend({ servers: ["nats://test"] });
	const kv = makeFakeKv();
	(backend as unknown as { kv: ReturnType<typeof makeFakeKv> }).kv = kv;
	(backend as unknown as { connected: boolean }).connected = true;
	return { backend, kv: kv as unknown as FakeKv };
}

describe("NatsKvConcurrencyBackend (Tier 2 #6 follow-up)", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("acquireSlot grants the first slot in a fresh bucket", async () => {
		const { backend, kv } = installBackend();
		const result = await backend.acquireSlot("wf", "k", 5, "run_1", Date.now() + 60_000);
		expect(result.acquired).toBe(true);
		expect(result.currentInFlight).toBe(1);
		expect(kv._data.size).toBe(1);
	});

	it("acquireSlot grants up to the limit then denies further", async () => {
		const { backend } = installBackend();
		const expiry = Date.now() + 60_000;

		expect((await backend.acquireSlot("wf", "k", 2, "run_1", expiry)).acquired).toBe(true);
		expect((await backend.acquireSlot("wf", "k", 2, "run_2", expiry)).acquired).toBe(true);
		const denied = await backend.acquireSlot("wf", "k", 2, "run_3", expiry);
		expect(denied.acquired).toBe(false);
		expect(denied.currentInFlight).toBe(2);
	});

	it("re-acquiring with the same runId refreshes the lease without growing the count", async () => {
		const { backend } = installBackend();
		const first = await backend.acquireSlot("wf", "k", 5, "run_1", Date.now() + 60_000);
		const refresh = await backend.acquireSlot("wf", "k", 5, "run_1", Date.now() + 120_000);
		expect(first.currentInFlight).toBe(1);
		expect(refresh.currentInFlight).toBe(1);
		expect(refresh.acquired).toBe(true);
	});

	it("releaseSlot frees a slot so the next acquire succeeds", async () => {
		const { backend } = installBackend();
		await backend.acquireSlot("wf", "k", 1, "run_1", Date.now() + 60_000);
		await backend.releaseSlot("wf", "k", "run_1");
		const next = await backend.acquireSlot("wf", "k", 1, "run_2", Date.now() + 60_000);
		expect(next.acquired).toBe(true);
		expect(next.currentInFlight).toBe(1);
	});

	it("releaseSlot is idempotent — releasing an unknown runId is a no-op", async () => {
		const { backend } = installBackend();
		await expect(backend.releaseSlot("wf", "k", "ghost")).resolves.toBeUndefined();
	});

	it("releaseSlot of last lease deletes the bucket key", async () => {
		const { backend, kv } = installBackend();
		await backend.acquireSlot("wf", "k", 1, "run_1", Date.now() + 60_000);
		expect(kv._data.size).toBe(1);
		await backend.releaseSlot("wf", "k", "run_1");
		expect(kv._data.size).toBe(0);
	});

	it("isolates buckets across workflows + keys", async () => {
		const { backend } = installBackend();
		const expiry = Date.now() + 60_000;
		const a = await backend.acquireSlot("wf-A", "k", 1, "run_a", expiry);
		const b = await backend.acquireSlot("wf-B", "k", 1, "run_b", expiry);
		const c = await backend.acquireSlot("wf-A", "k2", 1, "run_c", expiry);
		expect(a.acquired).toBe(true);
		expect(b.acquired).toBe(true);
		expect(c.acquired).toBe(true);
	});

	it("lazy-purges expired leases on the next acquire to the same bucket", async () => {
		const { backend } = installBackend();
		const past = Date.now() - 1000;
		await backend.acquireSlot("wf", "k", 1, "run_dead", past);
		const fresh = await backend.acquireSlot("wf", "k", 1, "run_alive", Date.now() + 60_000);
		expect(fresh.acquired).toBe(true);
		expect(fresh.currentInFlight).toBe(1);
	});

	it("purgeExpired sweeps every bucket and reports the count", async () => {
		const { backend } = installBackend();
		const past = Date.now() - 1000;
		const future = Date.now() + 60_000;
		await backend.acquireSlot("wf", "alive", 5, "run_alive", future);
		await backend.acquireSlot("wf", "dead", 5, "run_dead", past);

		const purged = await backend.purgeExpired(Date.now());
		// 1 expired lease in the "dead" bucket.
		expect(purged).toBe(1);
	});

	it("encodes non-safe characters in workflow + key segments without losing data", async () => {
		// `:` is not in the NATS-safe set; backend must escape.
		const { backend } = installBackend();
		const result = await backend.acquireSlot("wf:colon", "k:colon", 1, "run_1", Date.now() + 60_000);
		expect(result.acquired).toBe(true);
	});
});
