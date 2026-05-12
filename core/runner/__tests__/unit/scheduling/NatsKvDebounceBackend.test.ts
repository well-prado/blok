import { afterEach, describe, expect, it } from "vitest";
import { NatsKvDebounceBackend } from "../../../src/scheduling/NatsKvDebounceBackend";

/**
 * Fake NATS KV — in-memory implementation mirroring revision-based CAS.
 * Same pattern as the NatsKvConcurrencyBackend test file.
 */
interface FakeKvEntry {
	key: string;
	revision: number;
	string(): string;
	json<T>(): T;
}

function makeFakeKv() {
	const data = new Map<string, { value: string; revision: number }>();
	let revisionCounter = 1;
	return {
		_data: data,
		async get(key: string): Promise<FakeKvEntry | null> {
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

type FakeKv = ReturnType<typeof makeFakeKv>;

function installBackend(): { backend: NatsKvDebounceBackend; kv: FakeKv } {
	const backend = new NatsKvDebounceBackend({ servers: ["nats://test"], bucketName: "test-bucket" });
	const kv = makeFakeKv();
	(backend as unknown as { kv: FakeKv }).kv = kv;
	(backend as unknown as { connected: boolean }).connected = true;
	return { backend, kv };
}

const baseOpts = (overrides?: Partial<Parameters<NatsKvDebounceBackend["registerPing"]>[0]>) => ({
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

describe("NatsKvDebounceBackend (Tier C #1) — registerPing outcomes", () => {
	it("first ping in fresh bucket returns owner-new", async () => {
		const { backend, kv } = installBackend();
		const res = await backend.registerPing(baseOpts());
		expect(res.outcome).toBe("owner-new");
		expect(res.activeRunId).toBe("run_1");
		expect(res.scheduledAt).toBe(1_000_000 + 500);
		expect(res.pingCount).toBe(1);
		expect(kv._data.size).toBe(1);
	});

	it("same process pinging again returns owner-extend with bumped scheduledAt", async () => {
		const { backend } = installBackend();
		await backend.registerPing(baseOpts());
		const second = await backend.registerPing(baseOpts({ runId: "run_2", now: 1_000_200 }));
		expect(second.outcome).toBe("owner-extend");
		expect(second.activeRunId).toBe("run_1"); // owner's runId is sticky
		expect(second.scheduledAt).toBe(1_000_200 + 500);
		expect(second.pingCount).toBe(2);
	});

	it("different process pinging returns coalesce", async () => {
		const { backend } = installBackend();
		await backend.registerPing(baseOpts());
		const second = await backend.registerPing(baseOpts({ processId: "proc_B", runId: "run_2", now: 1_000_200 }));
		expect(second.outcome).toBe("coalesce");
		expect(second.activeRunId).toBe("run_1"); // points at proc_A's runId
		expect(second.scheduledAt).toBe(1_000_200 + 500);
		expect(second.pingCount).toBe(2);
	});

	it("owner lease expired → next process takes over via owner-new", async () => {
		const { backend } = installBackend();
		await backend.registerPing(baseOpts({ ownerLeaseMs: 1_000 }));
		// Wait past the lease.
		const takeover = await backend.registerPing(
			baseOpts({ processId: "proc_B", runId: "run_takeover", now: 1_000_000 + 5_000 }),
		);
		expect(takeover.outcome).toBe("owner-new");
		expect(takeover.activeRunId).toBe("run_takeover");
	});

	it("maxDelayMs caps the scheduledAt extension", async () => {
		const { backend } = installBackend();
		await backend.registerPing(baseOpts({ maxDelayMs: 1_500 }));
		// 3 consecutive same-process pings 400ms apart.
		await backend.registerPing(baseOpts({ runId: "r", now: 1_000_400, maxDelayMs: 1_500 }));
		await backend.registerPing(baseOpts({ runId: "r", now: 1_000_800, maxDelayMs: 1_500 }));
		const last = await backend.registerPing(baseOpts({ runId: "r", now: 1_001_200, maxDelayMs: 1_500 }));
		// maxDelayDeadline = 1_000_000 + 1_500 = 1_001_500. Naive = 1_001_200+500 = 1_001_700. Capped to 1_001_500.
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

describe("NatsKvDebounceBackend (Tier C #1) — finalize outcomes", () => {
	it("owner with elapsed scheduledAt fires + DELETEs bucket", async () => {
		const { backend, kv } = installBackend();
		const reg = await backend.registerPing(baseOpts());
		expect(kv._data.size).toBe(1);
		const res = await backend.finalize("wf", "k", reg.activeRunId, 1_000_000 + 600);
		expect(res.finalize).toBe("fire");
		expect(kv._data.size).toBe(0);
	});

	it("coalesce-pushed scheduledAt forces reschedule", async () => {
		const { backend } = installBackend();
		const reg = await backend.registerPing(baseOpts());
		// Coalesce ping pushes scheduledAt forward.
		await backend.registerPing(baseOpts({ processId: "proc_B", runId: "r2", now: 1_000_300 }));
		// Owner's timer fires at the original scheduledAt (1_000_500). But shared
		// scheduledAt was pushed to 1_000_300+500 = 1_000_800.
		const res = await backend.finalize("wf", "k", reg.activeRunId, 1_000_500);
		expect(res.finalize).toBe("reschedule");
		if (res.finalize !== "reschedule") return;
		expect(res.scheduledAt).toBe(1_000_800);
	});

	it("different runId now owns → abandoned", async () => {
		const { backend } = installBackend();
		await backend.registerPing(baseOpts({ ownerLeaseMs: 1_000 }));
		await backend.registerPing(baseOpts({ processId: "proc_B", runId: "run_new_owner", now: 1_000_000 + 5_000 }));
		// Original owner tries to finalize — runId mismatch.
		const res = await backend.finalize("wf", "k", "run_1", 1_000_000 + 5_000 + 600);
		expect(res.finalize).toBe("abandoned");
	});

	it("missing bucket → abandoned", async () => {
		const { backend } = installBackend();
		const res = await backend.finalize("wf", "k", "ghost", 1_000_000);
		expect(res.finalize).toBe("abandoned");
	});
});

describe("NatsKvDebounceBackend (Tier C #1) — cancel + purgeExpired", () => {
	it("cancel deletes an active bucket", async () => {
		const { backend, kv } = installBackend();
		await backend.registerPing(baseOpts());
		expect(kv._data.size).toBe(1);
		const cancelled = await backend.cancel("wf", "k");
		expect(cancelled).toBe(true);
		expect(kv._data.size).toBe(0);
	});

	it("cancel returns false on unknown bucket", async () => {
		const { backend } = installBackend();
		const cancelled = await backend.cancel("nope", "nope");
		expect(cancelled).toBe(false);
	});

	it("purgeExpired removes buckets with expired lease + elapsed scheduledAt", async () => {
		const { backend, kv } = installBackend();
		// Active bucket — lease still valid.
		await backend.registerPing(baseOpts({ debounceKey: "live", ownerLeaseMs: 60_000 }));
		// Stale bucket — lease expired AND scheduledAt elapsed.
		await backend.registerPing(baseOpts({ debounceKey: "stale", ownerLeaseMs: 1 }));
		const purged = await backend.purgeExpired(1_000_000 + 5_000);
		expect(purged).toBe(1);
		expect(kv._data.size).toBe(1);
	});

	it("encodes non-safe characters in workflow + key segments", async () => {
		const { backend } = installBackend();
		const res = await backend.registerPing(baseOpts({ workflowName: "wf:colon", debounceKey: "k:colon" }));
		expect(res.outcome).toBe("owner-new");
	});
});

/**
 * Security review FW-5 parity — production refusal for the default
 * bucket name. Same risk model as the concurrency NATS KV bucket.
 */
describe("NatsKvDebounceBackend — FW-5 production-default-deny", () => {
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

	it("connect() refuses to start in BLOK_ENV=production with the default bucket", async () => {
		setEnv({ BLOK_ENV: "production", BLOK_DEBOUNCE_NATS_KV_BUCKET: undefined });
		const backend = new NatsKvDebounceBackend();
		await expect(backend.connect()).rejects.toThrow(/refuses to start in production with the default bucket name/);
	});

	it("connect() refuses to start in NODE_ENV=production with the default bucket", async () => {
		setEnv({
			BLOK_ENV: undefined,
			NODE_ENV: "production",
			BLOK_DEBOUNCE_NATS_KV_BUCKET: undefined,
		});
		const backend = new NatsKvDebounceBackend();
		await expect(backend.connect()).rejects.toThrow(/refuses to start in production with the default bucket name/);
	});

	it("connect() permits production with an explicit bucket name", async () => {
		setEnv({
			BLOK_ENV: "production",
			BLOK_DEBOUNCE_NATS_KV_BUCKET: "blok-debounce-acme-prod",
		});
		const backend = new NatsKvDebounceBackend();
		await expect(backend.connect()).rejects.not.toThrow(/refuses to start in production/);
	});

	it("connect() permits the default bucket in non-production", async () => {
		setEnv({ BLOK_ENV: "development", BLOK_DEBOUNCE_NATS_KV_BUCKET: undefined });
		const backend = new NatsKvDebounceBackend();
		await expect(backend.connect()).rejects.not.toThrow(/refuses to start in production/);
	});
});
