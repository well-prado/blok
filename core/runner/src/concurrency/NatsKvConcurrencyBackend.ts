/**
 * Tier 2 #6 follow-up · NATS KV-backed concurrency backend.
 *
 * Coordinates per-(workflow, concurrencyKey) lease state across processes
 * via a single NATS JetStream KV value per bucket using revision-based
 * compare-and-swap (OCC).
 *
 * Storage model: one KV key per `(workflowName, concurrencyKey)` pair.
 * Value is a JSON `{leases: [{runId, expiresAt}]}` document. Bounded
 * cardinality assumption — typical concurrency keys hold 1-50 active
 * leases (per-tenant rate limits). For higher cardinality, a per-lease
 * key model would scale better; revisit when needed.
 *
 * Atomicity: NATS KV's only guarantee is `kv.create(key, value)` (fails
 * on conflict) and `kv.update(key, value, expectedRevision)` (fails on
 * concurrent modification). The acquire loop reads → filters → checks
 * limit → CAS update. On CAS failure, retry up to 10 times then
 * fail-closed (deny the slot).
 *
 * Lease leak: each lease carries an `expiresAt`. Expired leases are
 * lazy-purged inside the same `acquireSlot` call that observes them;
 * an explicit `purgeExpired` sweep is also exposed for janitor use.
 */

import { ConcurrencyMetrics } from "../monitoring/ConcurrencyMetrics";
import type { ConcurrencySlotResult } from "../tracing/types";
import type { ConcurrencyBackend } from "./ConcurrencyBackend";

export interface NatsKvConcurrencyConfig {
	servers: string[];
	token?: string;
	user?: string;
	pass?: string;
	bucketName: string;
}

interface LeaseEntry {
	runId: string;
	expiresAt: number;
}

interface BucketState {
	leases: LeaseEntry[];
}

const DEFAULT_BUCKET_NAME = "blok-concurrency";
const MAX_CAS_RETRIES = 10;

/**
 * Loosely-typed NATS KV entry shape — the runtime objects are well-formed
 * but the `nats` package's exported types are awkward to import statically
 * (it's a peer dep loaded via dynamic `import("nats")`).
 */
interface NatsKvEntry {
	key: string;
	revision: number;
	string(): string;
	json<T>(): T;
}

interface NatsKv {
	get(key: string): Promise<NatsKvEntry | null>;
	create(key: string, value: Uint8Array | string): Promise<number>;
	update(key: string, value: Uint8Array | string, revision: number): Promise<number>;
	delete(key: string): Promise<void>;
	keys(): AsyncIterable<string>;
}

interface NatsConnection {
	jetstream(): unknown;
	jetstreamManager(): Promise<unknown>;
	drain(): Promise<void>;
}

interface NatsModule {
	connect(opts: Record<string, unknown>): Promise<NatsConnection & { kv(name: string): Promise<NatsKv> }>;
}

/**
 * Read configuration from environment variables. Used by
 * {@link createConcurrencyBackend} when the user opts into NATS KV.
 */
export function readNatsKvConfigFromEnv(): NatsKvConcurrencyConfig {
	const serversRaw = process.env.BLOK_CONCURRENCY_NATS_SERVERS ?? "nats://localhost:4222";
	const servers = serversRaw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return {
		servers,
		token: process.env.BLOK_CONCURRENCY_NATS_TOKEN,
		user: process.env.BLOK_CONCURRENCY_NATS_USER,
		pass: process.env.BLOK_CONCURRENCY_NATS_PASS,
		bucketName: process.env.BLOK_CONCURRENCY_NATS_KV_BUCKET ?? DEFAULT_BUCKET_NAME,
	};
}

export class NatsKvConcurrencyBackend implements ConcurrencyBackend {
	readonly name = "nats-kv";

	private nc: NatsConnection | null = null;
	private kv: NatsKv | null = null;
	private readonly config: NatsKvConcurrencyConfig;
	private connected = false;

	constructor(config?: Partial<NatsKvConcurrencyConfig>) {
		const env = readNatsKvConfigFromEnv();
		this.config = {
			servers: config?.servers ?? env.servers,
			token: config?.token ?? env.token,
			user: config?.user ?? env.user,
			pass: config?.pass ?? env.pass,
			bucketName: config?.bucketName ?? env.bucketName,
		};
	}

	async connect(): Promise<void> {
		if (this.connected) return;

		// Security review FW-5 — refuse to start in production with the
		// default bucket name. Two deployments sharing a NATS server with
		// the default would contend on the same `(workflow, key)` buckets,
		// silently corrupting concurrency state across tenants. The fix
		// is operator-mandatory: set BLOK_CONCURRENCY_NATS_KV_BUCKET
		// per-deployment.
		const blokEnv = process.env.BLOK_ENV;
		const nodeEnv = process.env.NODE_ENV;
		const isProd = blokEnv === "production" || nodeEnv === "production";
		if (isProd && this.config.bucketName === DEFAULT_BUCKET_NAME) {
			throw new Error(
				`[blok] NATS KV concurrency backend refuses to start in production with the default bucket name ('${DEFAULT_BUCKET_NAME}'). Set BLOK_CONCURRENCY_NATS_KV_BUCKET to a deployment-unique value (e.g. 'blok-concurrency-acme-prod') to prevent cross-deployment collision on a shared NATS server.`,
			);
		}

		let natsModule: NatsModule;
		try {
			natsModule = (await import("nats")) as unknown as NatsModule;
		} catch (err) {
			throw new Error(
				`NatsKvConcurrencyBackend requires the 'nats' package. Install it: \`bun add nats\` or \`npm install nats\`. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const connectOpts: Record<string, unknown> = { servers: this.config.servers };
		if (this.config.token) connectOpts.token = this.config.token;
		if (this.config.user) connectOpts.user = this.config.user;
		if (this.config.pass) connectOpts.pass = this.config.pass;

		this.nc = (await natsModule.connect(connectOpts)) as NatsConnection & {
			kv(name: string): Promise<NatsKv>;
		};
		// `kv()` auto-creates the bucket on first use (NATS JetStream KV semantics).
		this.kv = await (this.nc as NatsConnection & { kv(name: string): Promise<NatsKv> }).kv(this.config.bucketName);
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return;
		try {
			await this.nc?.drain();
		} finally {
			this.nc = null;
			this.kv = null;
			this.connected = false;
		}
	}

	private bucketKey(workflowName: string, concurrencyKey: string): string {
		// Use `__` (double underscore) — KV keys cannot contain `.` or
		// `>` per NATS subject grammar; `__` is unambiguous and allows
		// arbitrary workflow / key strings.
		return `${this.encodeSegment(workflowName)}__${this.encodeSegment(concurrencyKey)}`;
	}

	private encodeSegment(s: string): string {
		// NATS KV keys must match `[-/_=\.a-zA-Z0-9]+`. Replace anything
		// outside the safe set with hex escape `_HHHH_` to keep the
		// roundtrip lossless.
		return s.replace(/[^-_=.a-zA-Z0-9]/g, (ch) => `_${ch.codePointAt(0)?.toString(16)}_`);
	}

	private requireKv(): NatsKv {
		if (!this.kv) {
			throw new Error("NatsKvConcurrencyBackend not connected — call connect() first.");
		}
		return this.kv;
	}

	async acquireSlot(
		workflowName: string,
		concurrencyKey: string,
		concurrencyLimit: number,
		runId: string,
		leaseExpiresAt: number,
	): Promise<ConcurrencySlotResult> {
		const kv = this.requireKv();
		const bucketKey = this.bucketKey(workflowName, concurrencyKey);

		// PR 3 D2 — record OCC retry depth + outcome on every exit path.
		const metricAttrs = { workflow_name: workflowName, concurrency_key: concurrencyKey };

		for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
			const entry = await this.safeGet(kv, bucketKey);

			// PR 2 A6 — fetch failure (broker unreachable / non-NotFound
			// error). Spinning 10× CAS retries on a connection problem just
			// burns latency. Fail-fast so the trigger sees the issue and
			// can fall back / alert. Existing run continues with no slot;
			// the gate is conservative.
			if (entry === "fetch-failed") {
				console.warn(
					`[blok][concurrency][nats-kv] acquireSlot fetch-failed for ${workflowName}:${concurrencyKey} (attempt ${attempt + 1}); failing closed`,
				);
				ConcurrencyMetrics.getInstance().recordOccRetries({ ...metricAttrs, outcome: "fail-closed" }, attempt);
				return { acquired: false, currentInFlight: -1 };
			}

			if (!entry) {
				// Bucket doesn't exist — create with first lease.
				const initial: BucketState = { leases: [{ runId, expiresAt: leaseExpiresAt }] };
				try {
					await kv.create(bucketKey, JSON.stringify(initial));
					ConcurrencyMetrics.getInstance().recordOccRetries({ ...metricAttrs, outcome: "success" }, attempt);
					return { acquired: true, currentInFlight: 1 };
				} catch {
					// Race — another process created. Retry.
					continue;
				}
			}

			// Read current state, lazy-purge expired.
			const current = this.parseBucket(entry);
			const now = Date.now();
			const active = current.leases.filter((l) => l.expiresAt > now);

			// Idempotent re-acquire: refresh lease, don't grow count.
			const existingIdx = active.findIndex((l) => l.runId === runId);
			if (existingIdx >= 0) {
				active[existingIdx] = { runId, expiresAt: leaseExpiresAt };
				try {
					await kv.update(bucketKey, JSON.stringify({ leases: active }), entry.revision);
					ConcurrencyMetrics.getInstance().recordOccRetries({ ...metricAttrs, outcome: "success" }, attempt);
					return { acquired: true, currentInFlight: active.length };
				} catch {
					continue;
				}
			}

			// Limit check.
			if (active.length >= concurrencyLimit) {
				ConcurrencyMetrics.getInstance().recordOccRetries({ ...metricAttrs, outcome: "denied" }, attempt);
				return { acquired: false, currentInFlight: active.length };
			}

			// Insert + CAS.
			const updated: BucketState = { leases: [...active, { runId, expiresAt: leaseExpiresAt }] };
			try {
				await kv.update(bucketKey, JSON.stringify(updated), entry.revision);
				ConcurrencyMetrics.getInstance().recordOccRetries({ ...metricAttrs, outcome: "success" }, attempt);
				return { acquired: true, currentInFlight: updated.leases.length };
			} catch {}
		}

		// Retry exhausted — fail-closed.
		console.warn(
			`[blok][concurrency][nats-kv] acquireSlot exhausted ${MAX_CAS_RETRIES} CAS retries for ${workflowName}:${concurrencyKey}; denying slot to runId=${runId}`,
		);
		ConcurrencyMetrics.getInstance().recordOccRetries({ ...metricAttrs, outcome: "fail-closed" }, MAX_CAS_RETRIES);
		return { acquired: false, currentInFlight: -1 };
	}

	async releaseSlot(workflowName: string, concurrencyKey: string, runId: string): Promise<void> {
		const kv = this.requireKv();
		const bucketKey = this.bucketKey(workflowName, concurrencyKey);

		for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
			const entry = await this.safeGet(kv, bucketKey);
			// PR 2 A6 — fetch failure on release. Lease will expire via
			// TTL; safe to fail-fast.
			if (entry === "fetch-failed") {
				console.warn(
					`[blok][concurrency][nats-kv] releaseSlot fetch-failed for ${workflowName}:${concurrencyKey} (attempt ${attempt + 1}); lease for runId=${runId} will expire via TTL`,
				);
				return;
			}
			if (!entry) return; // Idempotent — bucket already gone.

			const current = this.parseBucket(entry);
			const next = current.leases.filter((l) => l.runId !== runId);

			// No-op when the runId wasn't holding a slot.
			if (next.length === current.leases.length) return;

			if (next.length === 0) {
				try {
					await kv.delete(bucketKey);
					return;
				} catch {
					// Another process beat us to delete — fine.
					return;
				}
			}

			try {
				await kv.update(bucketKey, JSON.stringify({ leases: next }), entry.revision);
				return;
			} catch {}
		}

		console.warn(
			`[blok][concurrency][nats-kv] releaseSlot exhausted ${MAX_CAS_RETRIES} CAS retries for ${workflowName}:${concurrencyKey}; lease for runId=${runId} will expire via TTL`,
		);
	}

	async purgeExpired(now: number): Promise<number> {
		const kv = this.requireKv();
		let purged = 0;

		// Iterate all bucket keys.
		for await (const key of kv.keys()) {
			const entry = await this.safeGet(kv, key);
			// Treat both legitimate misses and fetch failures as "skip
			// this bucket" — purge is a best-effort sweep.
			if (!entry || entry === "fetch-failed") continue;
			const current = this.parseBucket(entry);
			const active = current.leases.filter((l) => l.expiresAt > now);
			const expired = current.leases.length - active.length;
			if (expired === 0) continue;

			if (active.length === 0) {
				try {
					await kv.delete(key);
					purged += expired;
				} catch {
					// best-effort
				}
				continue;
			}

			try {
				await kv.update(key, JSON.stringify({ leases: active }), entry.revision);
				purged += expired;
			} catch {
				// CAS conflict — leave for next sweep.
			}
		}

		return purged;
	}

	/**
	 * PR 2 A6 — distinguishes legitimate "key not found" from "broker
	 * unreachable / non-NotFound error". Returns:
	 *   - `NatsKvEntry` on a successful fetch.
	 *   - `null` when the key doesn't exist (NotFound code or null entry).
	 *   - `"fetch-failed"` for any other error (transient broker outage,
	 *     auth failure, network blip, etc.) so the OCC loop can fail-fast
	 *     instead of spinning 10× before fail-closing.
	 */
	private async safeGet(kv: NatsKv, key: string): Promise<NatsKvEntry | null | "fetch-failed"> {
		try {
			const e = await kv.get(key);
			return e ?? null;
		} catch (err) {
			// NATS surfaces "not found" via a code. Different `nats`
			// package versions use different shapes; cover the common ones.
			const code = (err as { code?: string }).code;
			if (code === "NotFound" || code === "404") return null;
			return "fetch-failed";
		}
	}

	private parseBucket(entry: NatsKvEntry): BucketState {
		try {
			const parsed = JSON.parse(entry.string()) as BucketState;
			if (!parsed || !Array.isArray(parsed.leases)) return { leases: [] };
			return parsed;
		} catch {
			return { leases: [] };
		}
	}
}
