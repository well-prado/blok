import { afterEach, describe, expect, it } from "vitest";
import { RedisDebounceBackend } from "../../../src/scheduling/RedisDebounceBackend";

/**
 * Fake ioredis whose `eval` re-implements the Lua scripts in TS so the
 * backend's contract can be tested hermetically. Dispatch is by stable
 * marker substring in each Lua source — same pattern as the
 * RedisConcurrencyBackend test file.
 */
interface FakeBucketDoc {
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

interface FakeRedis {
	_data: Map<string, string>;
	eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
	scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
	del(...keys: string[]): Promise<number>;
	ping(): Promise<string>;
	quit(): Promise<string>;
	on(event: string, listener: (err: Error) => void): void;
}

function readDoc(data: Map<string, string>, key: string): FakeBucketDoc | null {
	const raw = data.get(key);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as FakeBucketDoc;
	} catch {
		return null;
	}
}

function computeScheduledAt(
	existing: FakeBucketDoc | null,
	opts: { now: number; delayMs: number; maxDelayMs?: number },
): number {
	const naive = opts.now + opts.delayMs;
	let deadline: number | undefined;
	if (existing?.maxDelayDeadline !== undefined) deadline = existing.maxDelayDeadline;
	else if (opts.maxDelayMs !== undefined) deadline = opts.now + opts.maxDelayMs;
	return deadline !== undefined ? Math.min(naive, deadline) : naive;
}

function makeFakeRedis(): FakeRedis {
	const data = new Map<string, string>();
	return {
		_data: data,
		async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
			const key = String(args[0]);

			if (script.includes("-- We still own — extend window.")) {
				// REGISTER_PING
				const mode = String(args[1]) as "leading" | "trailing";
				const delayMs = Number(args[2]);
				const maxDelayMsRaw = Number(args[3]);
				const maxDelayMs = maxDelayMsRaw >= 0 ? maxDelayMsRaw : undefined;
				const runId = String(args[4]);
				const processId = String(args[5]);
				const ownerLeaseMs = Number(args[6]);
				const now = Number(args[7]);

				const existing = readDoc(data, key);
				const ownerActive = existing !== null && existing.ownerLeaseExpiresAt > now;

				if (!existing || !ownerActive) {
					const doc: FakeBucketDoc = {
						mode,
						delayMs,
						maxDelayMs,
						maxDelayDeadline: existing?.maxDelayDeadline ?? (maxDelayMs !== undefined ? now + maxDelayMs : undefined),
						firstPingAt: existing?.firstPingAt ?? now,
						lastPingAt: now,
						pingCount: (existing?.pingCount ?? 0) + 1,
						activeRunId: runId,
						ownerProcessId: processId,
						ownerLeaseExpiresAt: now + ownerLeaseMs,
						scheduledAt: computeScheduledAt(existing, { now, delayMs, maxDelayMs }),
					};
					data.set(key, JSON.stringify(doc));
					return ["owner-new", doc.activeRunId, String(doc.scheduledAt), String(doc.pingCount)];
				}

				if (existing.ownerProcessId === processId) {
					existing.lastPingAt = now;
					existing.pingCount += 1;
					existing.ownerLeaseExpiresAt = now + ownerLeaseMs;
					existing.scheduledAt = computeScheduledAt(existing, { now, delayMs, maxDelayMs });
					data.set(key, JSON.stringify(existing));
					return ["owner-extend", existing.activeRunId, String(existing.scheduledAt), String(existing.pingCount)];
				}

				existing.lastPingAt = now;
				existing.pingCount += 1;
				existing.scheduledAt = computeScheduledAt(existing, { now, delayMs, maxDelayMs });
				data.set(key, JSON.stringify(existing));
				return ["coalesce", existing.activeRunId, String(existing.scheduledAt), String(existing.pingCount)];
			}

			if (script.includes('if tostring(doc.activeRunId) ~= ARGV[1] then return { "abandoned" } end')) {
				// FINALIZE
				const targetRunId = String(args[1]);
				const now = Number(args[2]);
				const doc = readDoc(data, key);
				if (!doc) return ["abandoned"];
				if (doc.activeRunId !== targetRunId) return ["abandoned"];
				if (now < doc.scheduledAt) return ["reschedule", String(doc.scheduledAt)];
				data.delete(key);
				return ["fire"];
			}

			if (script.includes("local lease = tonumber(doc.ownerLeaseExpiresAt) or 0")) {
				// PURGE_EXPIRED_BUCKET
				const now = Number(args[1]);
				const doc = readDoc(data, key);
				if (!doc) return 0;
				if (doc.ownerLeaseExpiresAt <= now && doc.scheduledAt <= now) {
					data.delete(key);
					return 1;
				}
				return 0;
			}

			throw new Error(`fake redis eval: unrecognized script\n${script.slice(0, 120)}…`);
		},
		async scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]> {
			let pattern = "*";
			for (let i = 0; i < args.length - 1; i++) {
				if (String(args[i]).toUpperCase() === "MATCH") {
					pattern = String(args[i + 1]);
					break;
				}
			}
			const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
			const matches: string[] = [];
			for (const k of data.keys()) if (re.test(k)) matches.push(k);
			void cursor;
			return ["0", matches];
		},
		async del(...keys: string[]): Promise<number> {
			let n = 0;
			for (const k of keys) if (data.delete(k)) n++;
			return n;
		},
		async ping(): Promise<string> {
			return "PONG";
		},
		async quit(): Promise<string> {
			return "OK";
		},
		on(_event: string, _listener: (err: Error) => void): void {
			/* no-op */
		},
	};
}

function installBackend(): { backend: RedisDebounceBackend; client: FakeRedis } {
	const backend = new RedisDebounceBackend({ keyPrefix: "test-debounce" });
	const client = makeFakeRedis();
	(backend as unknown as { client: FakeRedis }).client = client;
	(backend as unknown as { connected: boolean }).connected = true;
	return { backend, client };
}

const baseOpts = (overrides?: Partial<Parameters<RedisDebounceBackend["registerPing"]>[0]>) => ({
	workflowName: "wf",
	debounceKey: "k",
	mode: "trailing" as const,
	delayMs: 500,
	maxDelayMs: undefined,
	runId: "run_1",
	processId: "proc_A",
	ownerLeaseMs: 60_000,
	now: 1_000_000,
	...overrides,
});

describe("RedisDebounceBackend (Tier C #1) — registerPing outcomes", () => {
	it("first ping in fresh bucket returns owner-new", async () => {
		const { backend, client } = installBackend();
		const res = await backend.registerPing(baseOpts());
		expect(res.outcome).toBe("owner-new");
		expect(res.activeRunId).toBe("run_1");
		expect(res.scheduledAt).toBe(1_000_500);
		expect(res.pingCount).toBe(1);
		expect(client._data.size).toBe(1);
	});

	it("same process pinging again returns owner-extend with bumped scheduledAt", async () => {
		const { backend } = installBackend();
		await backend.registerPing(baseOpts());
		const second = await backend.registerPing(baseOpts({ runId: "run_2", now: 1_000_200 }));
		expect(second.outcome).toBe("owner-extend");
		expect(second.activeRunId).toBe("run_1");
		expect(second.scheduledAt).toBe(1_000_700);
		expect(second.pingCount).toBe(2);
	});

	it("different process pinging returns coalesce", async () => {
		const { backend } = installBackend();
		await backend.registerPing(baseOpts());
		const second = await backend.registerPing(baseOpts({ processId: "proc_B", runId: "r2", now: 1_000_200 }));
		expect(second.outcome).toBe("coalesce");
		expect(second.activeRunId).toBe("run_1");
		expect(second.scheduledAt).toBe(1_000_700);
		expect(second.pingCount).toBe(2);
	});

	it("owner lease expired → next process takes over via owner-new", async () => {
		const { backend } = installBackend();
		await backend.registerPing(baseOpts({ ownerLeaseMs: 1_000 }));
		const takeover = await backend.registerPing(
			baseOpts({ processId: "proc_B", runId: "run_takeover", now: 1_000_000 + 5_000 }),
		);
		expect(takeover.outcome).toBe("owner-new");
		expect(takeover.activeRunId).toBe("run_takeover");
	});

	it("maxDelayMs caps the scheduledAt extension", async () => {
		const { backend } = installBackend();
		await backend.registerPing(baseOpts({ maxDelayMs: 1_500 }));
		await backend.registerPing(baseOpts({ runId: "r", now: 1_000_400, maxDelayMs: 1_500 }));
		await backend.registerPing(baseOpts({ runId: "r", now: 1_000_800, maxDelayMs: 1_500 }));
		const last = await backend.registerPing(baseOpts({ runId: "r", now: 1_001_200, maxDelayMs: 1_500 }));
		expect(last.scheduledAt).toBe(1_001_500);
	});

	it("isolates buckets across workflows + keys", async () => {
		const { backend } = installBackend();
		const a = await backend.registerPing(baseOpts({ workflowName: "wfA", debounceKey: "k" }));
		const b = await backend.registerPing(baseOpts({ workflowName: "wfB", debounceKey: "k" }));
		const c = await backend.registerPing(baseOpts({ workflowName: "wfA", debounceKey: "k2" }));
		expect(a.outcome).toBe("owner-new");
		expect(b.outcome).toBe("owner-new");
		expect(c.outcome).toBe("owner-new");
	});
});

describe("RedisDebounceBackend (Tier C #1) — finalize outcomes", () => {
	it("owner with elapsed scheduledAt fires + DELETEs bucket", async () => {
		const { backend, client } = installBackend();
		const reg = await backend.registerPing(baseOpts());
		expect(client._data.size).toBe(1);
		const res = await backend.finalize("wf", "k", reg.activeRunId, 1_000_600);
		expect(res.finalize).toBe("fire");
		expect(client._data.size).toBe(0);
	});

	it("coalesce-pushed scheduledAt forces reschedule", async () => {
		const { backend } = installBackend();
		const reg = await backend.registerPing(baseOpts());
		await backend.registerPing(baseOpts({ processId: "proc_B", runId: "r2", now: 1_000_300 }));
		const res = await backend.finalize("wf", "k", reg.activeRunId, 1_000_500);
		expect(res.finalize).toBe("reschedule");
		if (res.finalize !== "reschedule") return;
		expect(res.scheduledAt).toBe(1_000_800);
	});

	it("different runId now owns → abandoned", async () => {
		const { backend } = installBackend();
		await backend.registerPing(baseOpts({ ownerLeaseMs: 1_000 }));
		await backend.registerPing(baseOpts({ processId: "proc_B", runId: "run_new_owner", now: 1_005_000 }));
		const res = await backend.finalize("wf", "k", "run_1", 1_005_600);
		expect(res.finalize).toBe("abandoned");
	});

	it("missing bucket → abandoned", async () => {
		const { backend } = installBackend();
		const res = await backend.finalize("wf", "k", "ghost", 1_000_000);
		expect(res.finalize).toBe("abandoned");
	});
});

describe("RedisDebounceBackend (Tier C #1) — cancel + purgeExpired + encoding + prefix", () => {
	it("cancel deletes an active bucket", async () => {
		const { backend, client } = installBackend();
		await backend.registerPing(baseOpts());
		expect(client._data.size).toBe(1);
		const cancelled = await backend.cancel("wf", "k");
		expect(cancelled).toBe(true);
		expect(client._data.size).toBe(0);
	});

	it("cancel returns false on unknown bucket", async () => {
		const { backend } = installBackend();
		const cancelled = await backend.cancel("nope", "nope");
		expect(cancelled).toBe(false);
	});

	it("purgeExpired removes buckets with expired lease + elapsed scheduledAt", async () => {
		const { backend, client } = installBackend();
		await backend.registerPing(baseOpts({ debounceKey: "live", ownerLeaseMs: 60_000 }));
		await backend.registerPing(baseOpts({ debounceKey: "stale", ownerLeaseMs: 1 }));
		const purged = await backend.purgeExpired(1_005_000);
		expect(purged).toBe(1);
		expect(client._data.size).toBe(1);
	});

	it("encodes non-safe characters in workflow + key segments", async () => {
		const { backend, client } = installBackend();
		const res = await backend.registerPing(baseOpts({ workflowName: "wf:colon", debounceKey: "k:colon" }));
		expect(res.outcome).toBe("owner-new");
		const keys = [...client._data.keys()];
		expect(keys[0]).toContain("_3a_");
	});

	it("prefixes every key with the configured keyPrefix", async () => {
		const backend = new RedisDebounceBackend({ keyPrefix: "blok-debounce-acme" });
		const client = makeFakeRedis();
		(backend as unknown as { client: FakeRedis }).client = client;
		(backend as unknown as { connected: boolean }).connected = true;
		await backend.registerPing(baseOpts());
		const stored = [...client._data.keys()];
		expect(stored[0].startsWith("blok-debounce-acme:")).toBe(true);
	});
});

/**
 * FW-5 parity — production refusal for the default key prefix.
 */
describe("RedisDebounceBackend — FW-5 production-default-deny", () => {
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
		setEnv({ BLOK_ENV: "production", BLOK_DEBOUNCE_REDIS_KEY_PREFIX: undefined });
		const backend = new RedisDebounceBackend();
		await expect(backend.connect()).rejects.toThrow(/refuses to start in production with the default key prefix/);
	});

	it("connect() refuses to start in NODE_ENV=production with the default key prefix", async () => {
		setEnv({
			BLOK_ENV: undefined,
			NODE_ENV: "production",
			BLOK_DEBOUNCE_REDIS_KEY_PREFIX: undefined,
		});
		const backend = new RedisDebounceBackend();
		await expect(backend.connect()).rejects.toThrow(/refuses to start in production with the default key prefix/);
	});

	it("connect() permits production with an explicit key prefix", async () => {
		setEnv({
			BLOK_ENV: "production",
			BLOK_DEBOUNCE_REDIS_KEY_PREFIX: "blok-debounce-acme-prod",
		});
		const backend = new RedisDebounceBackend();
		await expect(backend.connect()).rejects.not.toThrow(/refuses to start in production/);
	});

	it("connect() permits the default key prefix in non-production", async () => {
		setEnv({ BLOK_ENV: "development", BLOK_DEBOUNCE_REDIS_KEY_PREFIX: undefined });
		const backend = new RedisDebounceBackend();
		await expect(backend.connect()).rejects.not.toThrow(/refuses to start in production/);
	});
});
