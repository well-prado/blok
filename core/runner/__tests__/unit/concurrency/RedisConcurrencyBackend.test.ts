import { afterEach, describe, expect, it } from "vitest";
import { RedisConcurrencyBackend } from "../../../src/concurrency/RedisConcurrencyBackend";

/**
 * Mock ioredis — small in-memory implementation that mirrors the Lua
 * scripts the backend ships. The fake's `eval` dispatches by stable
 * marker substrings in each script and applies the same TS-encoded
 * semantics. This drives the backend end-to-end without a real Redis.
 *
 * Real-Redis integration tests are deferred to a docker-compose CI
 * follow-up (tracked in BACKLOG.md). The unit suite below covers the
 * complete acquire/release/purge contract + FW-5 production refusal +
 * fetch-failure fail-fast invariants.
 */
interface FakeLease {
	runId: string;
	expiresAt: number;
}

interface FakeBucket {
	leases: FakeLease[];
}

interface FakeRedisClient {
	_data: Map<string, string>;
	_errorMode: "off" | "throw-all";
	eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
	scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
	del(...keys: string[]): Promise<number>;
	ping(): Promise<string>;
	quit(): Promise<string>;
	on(event: string, listener: (err: Error) => void): void;
}

function makeFakeRedis(): FakeRedisClient {
	const data = new Map<string, string>();
	const client: FakeRedisClient = {
		_data: data,
		_errorMode: "off",
		async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
			if (client._errorMode === "throw-all") {
				throw new Error("connection refused");
			}
			const key = String(args[0]);

			if (script.includes("-- Idempotent re-acquire")) {
				// ACQUIRE: KEYS[1] limit runId leaseExpiresAt now
				const limit = Number(args[1]);
				const runId = String(args[2]);
				const newExpires = Number(args[3]);
				const now = Number(args[4]);
				const leases = readBucket(data, key);
				const active = leases
					.filter((l) => Number(l.expiresAt) > now)
					.map<FakeLease>((l) => ({ runId: String(l.runId), expiresAt: Number(l.expiresAt) }));
				const idx = active.findIndex((l) => l.runId === runId);
				if (idx >= 0) {
					active[idx] = { runId, expiresAt: newExpires };
					data.set(key, JSON.stringify({ leases: active }));
					return [1, active.length];
				}
				if (active.length >= limit) {
					if (active.length < leases.length) {
						if (active.length === 0) data.delete(key);
						else data.set(key, JSON.stringify({ leases: active }));
					}
					return [0, active.length];
				}
				active.push({ runId, expiresAt: newExpires });
				data.set(key, JSON.stringify({ leases: active }));
				return [1, active.length];
			}

			if (script.includes("if removed == 0 then return 0 end")) {
				// RELEASE: KEYS[1] runId
				const target = String(args[1]);
				const leases = readBucket(data, key);
				if (leases.length === 0) return 0;
				const next: FakeLease[] = [];
				let removed = 0;
				for (const l of leases) {
					if (String(l.runId) === target) removed = 1;
					else next.push({ runId: String(l.runId), expiresAt: Number(l.expiresAt) });
				}
				if (removed === 0) return 0;
				if (next.length === 0) data.delete(key);
				else data.set(key, JSON.stringify({ leases: next }));
				return 1;
			}

			if (script.includes("local purged")) {
				// PURGE_BUCKET: KEYS[1] now
				const now = Number(args[1]);
				const leases = readBucket(data, key);
				if (leases.length === 0) return 0;
				const active = leases
					.filter((l) => Number(l.expiresAt) > now)
					.map<FakeLease>((l) => ({ runId: String(l.runId), expiresAt: Number(l.expiresAt) }));
				const purged = leases.length - active.length;
				if (purged === 0) return 0;
				if (active.length === 0) data.delete(key);
				else data.set(key, JSON.stringify({ leases: active }));
				return purged;
			}

			throw new Error(`fake redis eval: unrecognized script\n${script.slice(0, 120)}…`);
		},
		async scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]> {
			if (client._errorMode === "throw-all") {
				throw new Error("connection refused");
			}
			// Call shape: scan(cursor, "MATCH", pattern, "COUNT", count)
			let pattern = "*";
			for (let i = 0; i < args.length - 1; i++) {
				if (String(args[i]).toUpperCase() === "MATCH") {
					pattern = String(args[i + 1]);
					break;
				}
			}
			// Convert glob `*` to regex.
			const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
			const matches: string[] = [];
			for (const k of data.keys()) {
				if (re.test(k)) matches.push(k);
			}
			// Single-pass scan — return next cursor as "0" to terminate the loop.
			void cursor;
			return ["0", matches];
		},
		async del(...keys: string[]): Promise<number> {
			let n = 0;
			for (const k of keys) {
				if (data.delete(k)) n++;
			}
			return n;
		},
		async ping(): Promise<string> {
			return "PONG";
		},
		async quit(): Promise<string> {
			return "OK";
		},
		on(_event: string, _listener: (err: Error) => void): void {
			/* no-op for tests */
		},
	};
	return client;
}

function readBucket(data: Map<string, string>, key: string): FakeLease[] {
	const raw = data.get(key);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as Partial<FakeBucket>;
		if (!parsed || !Array.isArray(parsed.leases)) return [];
		return parsed.leases.map<FakeLease>((l) => ({ runId: String(l.runId), expiresAt: Number(l.expiresAt) }));
	} catch {
		return [];
	}
}

function installBackend(): { backend: RedisConcurrencyBackend; client: FakeRedisClient } {
	const backend = new RedisConcurrencyBackend({ keyPrefix: "test-prefix" });
	const client = makeFakeRedis();
	(backend as unknown as { client: FakeRedisClient }).client = client;
	(backend as unknown as { connected: boolean }).connected = true;
	return { backend, client };
}

describe("RedisConcurrencyBackend (Tier C #4)", () => {
	it("acquireSlot grants the first slot in a fresh bucket", async () => {
		const { backend, client } = installBackend();
		const result = await backend.acquireSlot("wf", "k", 5, "run_1", Date.now() + 60_000);
		expect(result.acquired).toBe(true);
		expect(result.currentInFlight).toBe(1);
		expect(client._data.size).toBe(1);
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
		const { backend, client } = installBackend();
		await backend.acquireSlot("wf", "k", 1, "run_1", Date.now() + 60_000);
		expect(client._data.size).toBe(1);
		await backend.releaseSlot("wf", "k", "run_1");
		expect(client._data.size).toBe(0);
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

	it("denial path persists the purge of expired leases (bucket stays clean)", async () => {
		const { backend, client } = installBackend();
		const past = Date.now() - 1000;
		const future = Date.now() + 60_000;
		// Seed two expired leases.
		await backend.acquireSlot("wf", "k", 5, "run_dead_1", past);
		await backend.acquireSlot("wf", "k", 5, "run_dead_2", past);
		// Fill the bucket with one live lease, then deny a second under limit=1.
		await backend.acquireSlot("wf", "k", 1, "run_alive", future);
		const denied = await backend.acquireSlot("wf", "k", 1, "run_x", future);
		expect(denied.acquired).toBe(false);
		expect(denied.currentInFlight).toBe(1);
		// Stored bucket should now hold only the live lease.
		const stored = client._data.get("test-prefix:wf__k");
		expect(stored).toBeDefined();
		if (!stored) return;
		const parsed = JSON.parse(stored) as { leases: { runId: string }[] };
		expect(parsed.leases).toHaveLength(1);
		expect(parsed.leases[0].runId).toBe("run_alive");
	});

	it("purgeExpired sweeps every bucket and reports the count", async () => {
		const { backend } = installBackend();
		const past = Date.now() - 1000;
		const future = Date.now() + 60_000;
		await backend.acquireSlot("wf", "alive", 5, "run_alive", future);
		await backend.acquireSlot("wf", "dead", 5, "run_dead", past);

		const purged = await backend.purgeExpired(Date.now());
		expect(purged).toBe(1);
	});

	it("purgeExpired deletes a bucket whose leases all expired", async () => {
		const { backend, client } = installBackend();
		const past = Date.now() - 1000;
		// Seed two expired leases DIRECTLY in the fake — using acquireSlot
		// twice would lazy-purge the first on the second call, leaving
		// only one lease to count.
		client._data.set(
			"test-prefix:wf__dead",
			JSON.stringify({
				leases: [
					{ runId: "run_a", expiresAt: past },
					{ runId: "run_b", expiresAt: past },
				],
			}),
		);
		expect(client._data.size).toBe(1);
		const purged = await backend.purgeExpired(Date.now());
		expect(purged).toBe(2);
		expect(client._data.size).toBe(0);
	});

	it("encodes non-safe characters in workflow + key segments without losing data", async () => {
		// `:` is in the NATS-unsafe set; backend escapes it to keep the
		// encoding lossless and the bucket-key parser unambiguous.
		const { backend, client } = installBackend();
		const result = await backend.acquireSlot("wf:colon", "k:colon", 1, "run_1", Date.now() + 60_000);
		expect(result.acquired).toBe(true);
		// The stored key must contain the escape sequence (`_3a_` for ':').
		const storedKeys = [...client._data.keys()];
		expect(storedKeys).toHaveLength(1);
		expect(storedKeys[0]).toContain("_3a_");
	});

	it("prefixes every key with the configured keyPrefix", async () => {
		const backend = new RedisConcurrencyBackend({ keyPrefix: "blok-acme-prod" });
		const client = makeFakeRedis();
		(backend as unknown as { client: FakeRedisClient }).client = client;
		(backend as unknown as { connected: boolean }).connected = true;
		await backend.acquireSlot("wf", "k", 1, "run_1", Date.now() + 60_000);
		const stored = [...client._data.keys()];
		expect(stored[0].startsWith("blok-acme-prod:")).toBe(true);
	});
});

/**
 * Fetch-failure fail-fast invariants — when the Redis broker is
 * unreachable, eval calls throw. The backend translates that into a
 * conservative fail-closed deny (acquire) or a logged warning (release).
 * Mirrors NatsKv's PR 2 A6 contract.
 */
describe("RedisConcurrencyBackend — broker fetch-failure", () => {
	it("acquireSlot fails closed on eval error", async () => {
		const { backend, client } = installBackend();
		client._errorMode = "throw-all";
		const start = Date.now();
		const result = await backend.acquireSlot("wf", "k", 1, "run_1", Date.now() + 60_000);
		const elapsed = Date.now() - start;
		expect(result.acquired).toBe(false);
		expect(result.currentInFlight).toBe(-1);
		// Single-shot Lua — must be near-instant, no retry loop.
		expect(elapsed).toBeLessThan(100);
	});

	it("releaseSlot logs + returns on eval error (lease falls back to TTL)", async () => {
		const { backend, client } = installBackend();
		client._errorMode = "throw-all";
		await expect(backend.releaseSlot("wf", "k", "run_1")).resolves.toBeUndefined();
	});

	it("purgeExpired aborts the sweep gracefully when SCAN throws", async () => {
		const { backend, client } = installBackend();
		await backend.acquireSlot("wf", "k", 1, "run_1", Date.now() - 1000);
		client._errorMode = "throw-all";
		const purged = await backend.purgeExpired(Date.now());
		expect(purged).toBe(0);
	});
});

/**
 * Security review FW-5 parity — production refusal for the default key
 * prefix. Two deployments sharing a Redis instance with the default
 * prefix would silently contend on the same `(workflow, key)` buckets,
 * corrupting concurrency state across tenants. Operators must set
 * `BLOK_CONCURRENCY_REDIS_KEY_PREFIX` to a deployment-unique value.
 */
describe("RedisConcurrencyBackend — FW-5 production-default-deny", () => {
	const originalEnv = { ...process.env };

	function setEnv(updates: Record<string, string | undefined>) {
		const next = { ...originalEnv } as NodeJS.ProcessEnv;
		for (const [k, v] of Object.entries(updates)) {
			if (v === undefined) {
				next[k] = undefined as unknown as string;
			} else {
				next[k] = v;
			}
		}
		process.env = next;
	}

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("connect() refuses to start in BLOK_ENV=production with the default key prefix", async () => {
		setEnv({ BLOK_ENV: "production", BLOK_CONCURRENCY_REDIS_KEY_PREFIX: undefined });
		const backend = new RedisConcurrencyBackend();
		await expect(backend.connect()).rejects.toThrow(/refuses to start in production with the default key prefix/);
	});

	it("connect() refuses to start in NODE_ENV=production with the default key prefix", async () => {
		setEnv({
			BLOK_ENV: undefined,
			NODE_ENV: "production",
			BLOK_CONCURRENCY_REDIS_KEY_PREFIX: undefined,
		});
		const backend = new RedisConcurrencyBackend();
		await expect(backend.connect()).rejects.toThrow(/refuses to start in production with the default key prefix/);
	});

	it("connect() permits production with an explicit key prefix", async () => {
		setEnv({
			BLOK_ENV: "production",
			BLOK_CONCURRENCY_REDIS_KEY_PREFIX: "blok-concurrency-acme-prod",
		});
		const backend = new RedisConcurrencyBackend();
		// Production guard passes; connect proceeds and fails on missing
		// `ioredis` module OR on the ping() call. Either way, the failure
		// is NOT the FW-5 refusal.
		await expect(backend.connect()).rejects.not.toThrow(/refuses to start in production/);
	});

	it("connect() permits the default key prefix in non-production", async () => {
		setEnv({ BLOK_ENV: "development", BLOK_CONCURRENCY_REDIS_KEY_PREFIX: undefined });
		const backend = new RedisConcurrencyBackend();
		await expect(backend.connect()).rejects.not.toThrow(/refuses to start in production/);
	});
});
