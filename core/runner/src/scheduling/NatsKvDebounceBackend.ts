/**
 * Tier C #1 · NATS KV-backed debounce backend.
 *
 * Coordinates per-(workflow, debounceKey) window state across processes
 * via a single NATS JetStream KV value per bucket with revision-based
 * compare-and-swap (OCC). Mirrors the storage model of
 * `NatsKvConcurrencyBackend` but with a different document shape (one
 * window per bucket, not a leases array).
 *
 * Acquire / extend / coalesce: a bounded CAS loop (10 retries) that
 * reads → decides ownership → atomically writes. On retry exhaustion,
 * fall back to admitting the ping as a `coalesce` against the current
 * owner — debounce is not a safety gate, so we'd rather over-coalesce
 * than drop pings on a contention spike.
 *
 * Finalize: same OCC pattern. The owning process atomically reads the
 * doc, confirms it still owns AND `now >= scheduledAt`, and atomically
 * deletes. On lease handoff, the owner discovers it no longer owns and
 * abandons silently.
 *
 * **Owner-local payload**: this backend tracks `pingCount`,
 * `lastPingAt`, and `scheduledAt` only — not the payload. Cross-process
 * latest-payload-wins is a deferred follow-up.
 */

import type {
	DebounceBackend,
	DebounceFinalizeResult,
	DebounceRegisterBackendOpts,
	DebounceRegisterBackendResult,
} from "./DebounceBackend";

export interface NatsKvDebounceConfig {
	servers: string[];
	token?: string;
	user?: string;
	pass?: string;
	bucketName: string;
}

interface BucketDoc {
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

const DEFAULT_BUCKET_NAME = "blok-debounce";
const MAX_CAS_RETRIES = 10;

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
	// nats.js v2.x — `keys()` returns Promise<AsyncIterable>; mock-KV
	// fakes return the AsyncIterable directly. Awaiting a non-thenable
	// resolves to itself so the consumer call site `for await (const x of
	// await kv.keys())` works in both modes.
	keys(): Promise<AsyncIterable<string>> | AsyncIterable<string>;
}

interface NatsJetStreamViews {
	kv(name: string): Promise<NatsKv>;
}

interface NatsJetStream {
	views: NatsJetStreamViews;
}

interface NatsConnection {
	jetstream(): NatsJetStream;
	jetstreamManager(): Promise<unknown>;
	drain(): Promise<void>;
}

interface NatsModule {
	connect(opts: Record<string, unknown>): Promise<NatsConnection>;
}

export function readNatsKvDebounceConfigFromEnv(): NatsKvDebounceConfig {
	const serversRaw = process.env.BLOK_DEBOUNCE_NATS_SERVERS ?? "nats://localhost:4222";
	const servers = serversRaw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return {
		servers,
		token: process.env.BLOK_DEBOUNCE_NATS_TOKEN,
		user: process.env.BLOK_DEBOUNCE_NATS_USER,
		pass: process.env.BLOK_DEBOUNCE_NATS_PASS,
		bucketName: process.env.BLOK_DEBOUNCE_NATS_KV_BUCKET ?? DEFAULT_BUCKET_NAME,
	};
}

export class NatsKvDebounceBackend implements DebounceBackend {
	readonly name = "nats-kv";

	private nc: NatsConnection | null = null;
	private kv: NatsKv | null = null;
	private readonly config: NatsKvDebounceConfig;
	private connected = false;

	constructor(config?: Partial<NatsKvDebounceConfig>) {
		const env = readNatsKvDebounceConfigFromEnv();
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

		// Security review FW-5 parity — refuse to start in production with
		// the default bucket name (same risk as the concurrency NATS KV
		// bucket).
		const blokEnv = process.env.BLOK_ENV;
		const nodeEnv = process.env.NODE_ENV;
		const isProd = blokEnv === "production" || nodeEnv === "production";
		if (isProd && this.config.bucketName === DEFAULT_BUCKET_NAME) {
			throw new Error(
				`[blok] NATS KV debounce backend refuses to start in production with the default bucket name ('${DEFAULT_BUCKET_NAME}'). Set BLOK_DEBOUNCE_NATS_KV_BUCKET to a deployment-unique value (e.g. 'blok-debounce-acme-prod') to prevent cross-deployment collision on a shared NATS server.`,
			);
		}

		let natsModule: NatsModule;
		try {
			natsModule = (await import("nats")) as unknown as NatsModule;
		} catch (err) {
			throw new Error(
				`NatsKvDebounceBackend requires the 'nats' package. Install it: \`bun add nats\` or \`npm install nats\`. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const connectOpts: Record<string, unknown> = { servers: this.config.servers };
		if (this.config.token) connectOpts.token = this.config.token;
		if (this.config.user) connectOpts.user = this.config.user;
		if (this.config.pass) connectOpts.pass = this.config.pass;

		this.nc = await natsModule.connect(connectOpts);
		// nats.js v2.x — KV lives at `nc.jetstream().views.kv(name)`.
		const js = this.nc.jetstream();
		this.kv = await js.views.kv(this.config.bucketName);
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

	private bucketKey(workflowName: string, debounceKey: string): string {
		return `${this.encodeSegment(workflowName)}__${this.encodeSegment(debounceKey)}`;
	}

	private encodeSegment(s: string): string {
		return s.replace(/[^-_=.a-zA-Z0-9]/g, (ch) => `_${ch.codePointAt(0)?.toString(16)}_`);
	}

	private requireKv(): NatsKv {
		if (!this.kv) {
			throw new Error("NatsKvDebounceBackend not connected — call connect() first.");
		}
		return this.kv;
	}

	private computeScheduledAt(opts: DebounceRegisterBackendOpts, existing: BucketDoc | null): number {
		const naive = opts.now + opts.delayMs;
		const deadline =
			existing?.maxDelayDeadline ?? (opts.maxDelayMs !== undefined ? opts.now + opts.maxDelayMs : undefined);
		return deadline !== undefined ? Math.min(naive, deadline) : naive;
	}

	async registerPing(opts: DebounceRegisterBackendOpts): Promise<DebounceRegisterBackendResult> {
		const kv = this.requireKv();
		const key = this.bucketKey(opts.workflowName, opts.debounceKey);

		for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
			const entry = await this.safeGet(kv, key);

			if (entry === "fetch-failed") {
				// Surface but don't retry on broker outage — debounce is
				// fail-open per the coordinator wrapper.
				throw new Error(`registerPing fetch-failed for ${key} (attempt ${attempt + 1})`);
			}

			const existing = entry ? this.parseDoc(entry) : null;

			// Owner-lease expired → treat as no existing window.
			const ownerActive = existing !== null && existing.ownerLeaseExpiresAt > opts.now;

			if (!existing || !ownerActive) {
				// Take ownership — new doc or owner-lease handoff.
				const doc: BucketDoc = {
					mode: opts.mode,
					delayMs: opts.delayMs,
					maxDelayMs: opts.maxDelayMs,
					maxDelayDeadline:
						existing?.maxDelayDeadline ?? (opts.maxDelayMs !== undefined ? opts.now + opts.maxDelayMs : undefined),
					firstPingAt: existing?.firstPingAt ?? opts.now,
					lastPingAt: opts.now,
					pingCount: (existing?.pingCount ?? 0) + 1,
					activeRunId: opts.runId,
					ownerProcessId: opts.processId,
					ownerLeaseExpiresAt: opts.now + opts.ownerLeaseMs,
					scheduledAt: this.computeScheduledAt(opts, existing),
				};
				try {
					if (entry) {
						await kv.update(key, JSON.stringify(doc), entry.revision);
					} else {
						await kv.create(key, JSON.stringify(doc));
					}
					return {
						outcome: "owner-new",
						activeRunId: doc.activeRunId,
						scheduledAt: doc.scheduledAt,
						pingCount: doc.pingCount,
					};
				} catch {
					continue; // CAS conflict — retry.
				}
			}

			// existing && ownerActive
			if (existing.ownerProcessId === opts.processId) {
				// We still own — extend the window.
				const next: BucketDoc = {
					...existing,
					lastPingAt: opts.now,
					pingCount: existing.pingCount + 1,
					ownerLeaseExpiresAt: opts.now + opts.ownerLeaseMs,
					scheduledAt: this.computeScheduledAt(opts, existing),
					// activeRunId stays — owner's run id from owner-new is the source of truth.
				};
				try {
					await kv.update(key, JSON.stringify(next), entry?.revision ?? 0);
					return {
						outcome: "owner-extend",
						activeRunId: existing.activeRunId,
						scheduledAt: next.scheduledAt,
						pingCount: next.pingCount,
					};
				} catch {
					continue;
				}
			}

			// Different process owns. Coalesce — bump pingCount + push scheduledAt only.
			const next: BucketDoc = {
				...existing,
				lastPingAt: opts.now,
				pingCount: existing.pingCount + 1,
				scheduledAt: this.computeScheduledAt(opts, existing),
			};
			try {
				await kv.update(key, JSON.stringify(next), entry?.revision ?? 0);
				return {
					outcome: "coalesce",
					activeRunId: existing.activeRunId,
					scheduledAt: next.scheduledAt,
					pingCount: next.pingCount,
				};
			} catch {
				// CAS conflict — fall through to the next loop iteration.
			}
		}

		// CAS retries exhausted — over-coalesce: read the current owner and
		// return coalesce. Last-resort fallback that prefers admitting a
		// ping (with attribution to whoever currently owns) over dropping it.
		const entry = await this.safeGet(kv, key);
		if (entry && entry !== "fetch-failed") {
			const existing = this.parseDoc(entry);
			if (existing) {
				return {
					outcome: "coalesce",
					activeRunId: existing.activeRunId,
					scheduledAt: existing.scheduledAt,
					pingCount: existing.pingCount,
				};
			}
		}
		// No doc readable — best-effort owner-new with caller's runId so
		// the coordinator drives a local timer; the next ping will resolve
		// the race.
		return {
			outcome: "owner-new",
			activeRunId: opts.runId,
			scheduledAt: opts.now + opts.delayMs,
			pingCount: 1,
		};
	}

	async finalize(
		workflowName: string,
		debounceKey: string,
		runId: string,
		now: number,
	): Promise<DebounceFinalizeResult> {
		const kv = this.requireKv();
		const key = this.bucketKey(workflowName, debounceKey);

		for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
			const entry = await this.safeGet(kv, key);
			if (entry === "fetch-failed") {
				return { finalize: "abandoned" };
			}
			if (!entry) return { finalize: "abandoned" };

			const doc = this.parseDoc(entry);
			if (!doc) return { finalize: "abandoned" };

			// Different runId now owns → abandoned (owner lease handed off).
			if (doc.activeRunId !== runId) return { finalize: "abandoned" };

			// Coalesce pings pushed scheduledAt forward → reschedule.
			if (now < doc.scheduledAt) {
				return { finalize: "reschedule", scheduledAt: doc.scheduledAt };
			}

			// Same owner + scheduledAt elapsed → try to fire (DELETE).
			try {
				await kv.delete(key);
				return { finalize: "fire" };
			} catch {
				// Race — another op modified the bucket; fall through to retry.
			}
		}

		return { finalize: "abandoned" };
	}

	async cancel(workflowName: string, debounceKey: string): Promise<boolean> {
		const kv = this.requireKv();
		const key = this.bucketKey(workflowName, debounceKey);
		const entry = await this.safeGet(kv, key);
		if (!entry || entry === "fetch-failed") return false;
		try {
			await kv.delete(key);
			return true;
		} catch {
			return false;
		}
	}

	async purgeExpired(now: number): Promise<number> {
		const kv = this.requireKv();
		let purged = 0;

		// Drain `kv.keys()` to an array BEFORE doing per-key reads.
		// nats.js v2.x's `QueuedIterator` silently drops yields when
		// `kv.get()` is interleaved with the iteration (the watch's
		// internal consumer gets confused). Collect first, then operate.
		const allKeys: string[] = [];
		for await (const key of await kv.keys()) {
			allKeys.push(key);
		}

		for (const key of allKeys) {
			const entry = await this.safeGet(kv, key);
			if (!entry || entry === "fetch-failed") continue;
			const doc = this.parseDoc(entry);
			if (!doc) continue;
			// Bucket is purgeable when both: owner-lease expired AND
			// scheduledAt elapsed (no active owner with a pending fire).
			if (doc.ownerLeaseExpiresAt <= now && doc.scheduledAt <= now) {
				try {
					await kv.delete(key);
					purged += 1;
				} catch {
					// CAS conflict — leave for next sweep.
				}
			}
		}
		return purged;
	}

	private async safeGet(kv: NatsKv, key: string): Promise<NatsKvEntry | null | "fetch-failed"> {
		try {
			const e = await kv.get(key);
			return e ?? null;
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code === "NotFound" || code === "404") return null;
			return "fetch-failed";
		}
	}

	private parseDoc(entry: NatsKvEntry): BucketDoc | null {
		try {
			const parsed = JSON.parse(entry.string()) as BucketDoc;
			if (!parsed || typeof parsed.activeRunId !== "string") return null;
			return parsed;
		} catch {
			return null;
		}
	}
}
