/**
 * Tier C #4 follow-up · Redis-backed concurrency backend.
 *
 * Coordinates per-(workflow, concurrencyKey) lease state across processes
 * via a single Redis key per bucket. Atomicity comes from server-side Lua
 * scripts — `EVAL` runs single-threaded against the keyspace, so the
 * read → filter → check-limit → write sequence is a single round-trip
 * with no OCC retry loop (the headline win over the NATS KV backend's
 * `WATCH`/`MULTI`/`EXEC`-style optimistic concurrency).
 *
 * Storage model: one Redis string key per `(workflowName, concurrencyKey)`
 * bucket. Value is a JSON-encoded `{leases: [{runId, expiresAt}]}`
 * document. Bounded-cardinality assumption identical to NATS KV — typical
 * concurrency keys hold 1-50 active leases.
 *
 * Lease leak: each lease carries an `expiresAt`. Expired leases are
 * lazy-purged inside the Lua script that observes them; an explicit
 * `purgeExpired` SCAN sweep is also exposed for janitor use.
 *
 * Connection: ioredis is loaded via dynamic `import("ioredis")` so the
 * dependency stays optional. Matches the existing pattern used by
 * `triggers/worker`'s `RedisStreamsAdapter` and
 * `triggers/pubsub`'s `RedisStreamsPubSubAdapter`.
 */

import { ConcurrencyMetrics } from "../monitoring/ConcurrencyMetrics";
import type { ConcurrencySlotResult } from "../tracing/types";
import type { ConcurrencyBackend } from "./ConcurrencyBackend";

export interface RedisConcurrencyConfig {
	/** Full Redis connection URL (e.g. `redis://[user:pass@]host:port[/db]`). Takes precedence over host/port. */
	url?: string;
	host?: string;
	port?: number;
	password?: string;
	username?: string;
	db?: number;
	tls?: boolean;
	/** Namespace prefix for every Redis key the backend touches. */
	keyPrefix: string;
}

const DEFAULT_KEY_PREFIX = "blok-concurrency";

/**
 * Loosely-typed ioredis client shape — the runtime objects are well-formed
 * but `ioredis`'s exported types are awkward to import statically
 * (it's a runtime peer dep loaded via dynamic `import("ioredis")`).
 *
 * Only the methods this backend actually uses are declared. Boundary-cast
 * the dynamic import to this shape with `as unknown as RedisClient`.
 */
interface RedisClient {
	eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
	scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
	del(...keys: string[]): Promise<number>;
	ping(): Promise<string>;
	quit(): Promise<string>;
	on(event: string, listener: (err: Error) => void): void;
}

interface IoredisModule {
	default?: new (opts: Record<string, unknown> | string) => RedisClient;
	Redis?: new (opts: Record<string, unknown> | string) => RedisClient;
}

/**
 * Read configuration from environment variables. Used by
 * {@link createConcurrencyBackend} when the operator opts into Redis.
 */
export function readRedisConfigFromEnv(): RedisConcurrencyConfig {
	const url = process.env.BLOK_CONCURRENCY_REDIS_URL?.trim() || undefined;
	const host = process.env.BLOK_CONCURRENCY_REDIS_HOST?.trim() || undefined;
	const portRaw = process.env.BLOK_CONCURRENCY_REDIS_PORT?.trim();
	const port = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : undefined;
	const dbRaw = process.env.BLOK_CONCURRENCY_REDIS_DB?.trim();
	const db = dbRaw && /^\d+$/.test(dbRaw) ? Number(dbRaw) : undefined;
	const tls = process.env.BLOK_CONCURRENCY_REDIS_TLS === "1" || process.env.BLOK_CONCURRENCY_REDIS_TLS === "true";
	return {
		url,
		host,
		port,
		password: process.env.BLOK_CONCURRENCY_REDIS_PASSWORD,
		username: process.env.BLOK_CONCURRENCY_REDIS_USERNAME,
		db,
		tls,
		keyPrefix: process.env.BLOK_CONCURRENCY_REDIS_KEY_PREFIX?.trim() || DEFAULT_KEY_PREFIX,
	};
}

/**
 * Atomic acquire. Returns `{acquired, currentInFlight}` as a 2-element array.
 *
 * Storage shape: the bucket is either MISSING (no active leases) or a
 * JSON string `{"leases":[{"runId":"...","expiresAt":<ms>}, ...]}`.
 * When the leases array would become empty we DEL the key — we never
 * encode the empty array (sidesteps the cjson empty-table-as-object trap).
 *
 * KEYS[1] = bucket key
 * ARGV[1] = limit (int as string)
 * ARGV[2] = runId
 * ARGV[3] = leaseExpiresAt (ms as string)
 * ARGV[4] = now (ms as string)
 *
 * Returns: {acquired, currentInFlight}
 *  - acquired: 1 = granted, 0 = denied
 *  - currentInFlight: in-flight count INCLUDING the granted slot on success,
 *                     count at denial on rejection.
 */
const ACQUIRE_LUA = `
local raw = redis.call('GET', KEYS[1])
local leases = {}
if raw and raw ~= '' then
  local ok, parsed = pcall(cjson.decode, raw)
  if ok and type(parsed) == 'table' and type(parsed.leases) == 'table' then
    leases = parsed.leases
  end
end

local now = tonumber(ARGV[4])
local active = {}
for i = 1, #leases do
  local l = leases[i]
  if type(l) == 'table' and tonumber(l.expiresAt) and tonumber(l.expiresAt) > now then
    active[#active + 1] = { runId = tostring(l.runId), expiresAt = tonumber(l.expiresAt) }
  end
end

local runId = ARGV[2]
local newExpires = tonumber(ARGV[3])

-- Idempotent re-acquire: refresh lease, don't grow count.
for i = 1, #active do
  if active[i].runId == runId then
    active[i] = { runId = runId, expiresAt = newExpires }
    redis.call('SET', KEYS[1], cjson.encode({ leases = active }))
    return { 1, #active }
  end
end

local limit = tonumber(ARGV[1])
if #active >= limit then
  -- Persist the purge of expired entries (if any) so the bucket stays clean.
  if #active < #leases then
    if #active == 0 then
      redis.call('DEL', KEYS[1])
    else
      redis.call('SET', KEYS[1], cjson.encode({ leases = active }))
    end
  end
  return { 0, #active }
end

active[#active + 1] = { runId = runId, expiresAt = newExpires }
redis.call('SET', KEYS[1], cjson.encode({ leases = active }))
return { 1, #active }
`;

/**
 * Atomic release. Removes a lease by runId. DELs the bucket when empty.
 *
 * KEYS[1] = bucket key
 * ARGV[1] = runId
 *
 * Returns: 1 if a lease was removed, 0 if no-op (bucket missing or runId not present).
 */
const RELEASE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw or raw == '' then return 0 end

local ok, parsed = pcall(cjson.decode, raw)
if not ok or type(parsed) ~= 'table' or type(parsed.leases) ~= 'table' then return 0 end

local target = ARGV[1]
local next_leases = {}
local removed = 0
for i = 1, #parsed.leases do
  local l = parsed.leases[i]
  if type(l) == 'table' and tostring(l.runId) == target then
    removed = 1
  else
    next_leases[#next_leases + 1] = { runId = tostring(l.runId), expiresAt = tonumber(l.expiresAt) }
  end
end

if removed == 0 then return 0 end

if #next_leases == 0 then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], cjson.encode({ leases = next_leases }))
end
return 1
`;

/**
 * Purge expired leases from a single bucket. Atomic.
 *
 * KEYS[1] = bucket key
 * ARGV[1] = now (ms as string)
 *
 * Returns: number of leases purged.
 */
const PURGE_BUCKET_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw or raw == '' then return 0 end

local ok, parsed = pcall(cjson.decode, raw)
if not ok or type(parsed) ~= 'table' or type(parsed.leases) ~= 'table' then return 0 end

local now = tonumber(ARGV[1])
local active = {}
for i = 1, #parsed.leases do
  local l = parsed.leases[i]
  if type(l) == 'table' and tonumber(l.expiresAt) and tonumber(l.expiresAt) > now then
    active[#active + 1] = { runId = tostring(l.runId), expiresAt = tonumber(l.expiresAt) }
  end
end

local purged = #parsed.leases - #active
if purged == 0 then return 0 end

if #active == 0 then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], cjson.encode({ leases = active }))
end
return purged
`;

export class RedisConcurrencyBackend implements ConcurrencyBackend {
	readonly name = "redis";

	private client: RedisClient | null = null;
	private readonly config: RedisConcurrencyConfig;
	private connected = false;

	constructor(config?: Partial<RedisConcurrencyConfig>) {
		const env = readRedisConfigFromEnv();
		this.config = {
			url: config?.url ?? env.url,
			host: config?.host ?? env.host,
			port: config?.port ?? env.port,
			password: config?.password ?? env.password,
			username: config?.username ?? env.username,
			db: config?.db ?? env.db,
			tls: config?.tls ?? env.tls,
			keyPrefix: config?.keyPrefix ?? env.keyPrefix,
		};
	}

	async connect(): Promise<void> {
		if (this.connected) return;

		// Security review FW-5 parity — refuse to start in production with
		// the default key prefix. Two deployments sharing a Redis instance
		// would silently contend on the same `(workflow, key)` buckets,
		// corrupting concurrency state across tenants.
		const blokEnv = process.env.BLOK_ENV;
		const nodeEnv = process.env.NODE_ENV;
		const isProd = blokEnv === "production" || nodeEnv === "production";
		if (isProd && this.config.keyPrefix === DEFAULT_KEY_PREFIX) {
			throw new Error(
				`[blok] Redis concurrency backend refuses to start in production with the default key prefix ('${DEFAULT_KEY_PREFIX}'). Set BLOK_CONCURRENCY_REDIS_KEY_PREFIX to a deployment-unique value (e.g. 'blok-concurrency-acme-prod') to prevent cross-deployment collision on a shared Redis instance.`,
			);
		}

		let ioredisModule: IoredisModule;
		try {
			ioredisModule = (await import("ioredis")) as unknown as IoredisModule;
		} catch (err) {
			throw new Error(
				`RedisConcurrencyBackend requires the 'ioredis' package. Install it: \`bun add ioredis\` or \`npm install ioredis\`. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const IORedisCtor = ioredisModule.default ?? ioredisModule.Redis;
		if (!IORedisCtor) {
			throw new Error(
				"RedisConcurrencyBackend could not locate the ioredis constructor on the imported module. Reinstall ioredis or report this issue.",
			);
		}

		// Production-friendly defaults: fail fast on connection trouble
		// rather than hanging triggers on broker outage. Operators who
		// want different semantics can layer a wrapper or fork the
		// backend — these are intentional opinions matching the "trigger
		// startup should not block indefinitely on broker reachability"
		// posture of the rest of the runner.
		const failFastDefaults: Record<string, unknown> = {
			connectTimeout: 5_000,
			maxRetriesPerRequest: 0,
			enableOfflineQueue: false,
			lazyConnect: true,
		};

		if (this.config.url) {
			this.client = new IORedisCtor(this.config.url);
		} else {
			const opts: Record<string, unknown> = { ...failFastDefaults };
			if (this.config.host) opts.host = this.config.host;
			if (this.config.port) opts.port = this.config.port;
			if (this.config.username) opts.username = this.config.username;
			if (this.config.password) opts.password = this.config.password;
			if (typeof this.config.db === "number") opts.db = this.config.db;
			if (this.config.tls) opts.tls = {};
			this.client = new IORedisCtor(opts);
		}

		// Surface async errors instead of crashing the process.
		this.client.on("error", (err: Error) => {
			console.warn(`[blok][concurrency][redis] client error: ${err.message}`);
		});

		await this.client.ping();
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return;
		try {
			await this.client?.quit();
		} catch {
			// quit() can reject if the connection is already torn down; ignore.
		} finally {
			this.client = null;
			this.connected = false;
		}
	}

	private bucketKey(workflowName: string, concurrencyKey: string): string {
		// Mirror NATS KV's hex-escape scheme so workflow/key strings with
		// special characters (`:`, `>`, etc.) round-trip without collision.
		// Cross-backend portability matters when operators migrate between
		// backends: the same `(workflow, key)` pair maps to the same bucket
		// identity modulo the prefix.
		return `${this.config.keyPrefix}:${this.encodeSegment(workflowName)}__${this.encodeSegment(concurrencyKey)}`;
	}

	private encodeSegment(s: string): string {
		// Same regex as NATS KV — replace anything outside the safe set
		// with hex escape `_HHHH_` so the encoding is lossless and matches
		// the NATS backend byte-for-byte modulo prefix.
		return s.replace(/[^-_=.a-zA-Z0-9]/g, (ch) => `_${ch.codePointAt(0)?.toString(16)}_`);
	}

	private requireClient(): RedisClient {
		if (!this.client) {
			throw new Error("RedisConcurrencyBackend not connected — call connect() first.");
		}
		return this.client;
	}

	async acquireSlot(
		workflowName: string,
		concurrencyKey: string,
		concurrencyLimit: number,
		runId: string,
		leaseExpiresAt: number,
	): Promise<ConcurrencySlotResult> {
		const client = this.requireClient();
		const key = this.bucketKey(workflowName, concurrencyKey);
		const metricAttrs = { workflow_name: workflowName, concurrency_key: concurrencyKey };

		try {
			const raw = await client.eval(
				ACQUIRE_LUA,
				1,
				key,
				String(concurrencyLimit),
				runId,
				String(leaseExpiresAt),
				String(Date.now()),
			);
			const [acquiredFlag, currentInFlight] = this.parsePair(raw);
			const outcome = acquiredFlag === 1 ? "success" : "denied";
			// Lua is single-shot — attempt depth is always 0.
			ConcurrencyMetrics.getInstance().recordOccRetries({ ...metricAttrs, outcome }, 0);
			return { acquired: acquiredFlag === 1, currentInFlight };
		} catch (err) {
			console.warn(
				`[blok][concurrency][redis] acquireSlot eval failed for ${workflowName}:${concurrencyKey}: ${err instanceof Error ? err.message : String(err)}; failing closed`,
			);
			ConcurrencyMetrics.getInstance().recordOccRetries({ ...metricAttrs, outcome: "fail-closed" }, 0);
			return { acquired: false, currentInFlight: -1 };
		}
	}

	async releaseSlot(workflowName: string, concurrencyKey: string, runId: string): Promise<void> {
		const client = this.requireClient();
		const key = this.bucketKey(workflowName, concurrencyKey);
		try {
			await client.eval(RELEASE_LUA, 1, key, runId);
		} catch (err) {
			// Lease will expire via TTL — release is best-effort. Surface
			// the error so operators can see broker outages.
			console.warn(
				`[blok][concurrency][redis] releaseSlot eval failed for ${workflowName}:${concurrencyKey} runId=${runId}: ${err instanceof Error ? err.message : String(err)}; lease will expire via TTL`,
			);
		}
	}

	async purgeExpired(now: number): Promise<number> {
		const client = this.requireClient();
		const pattern = `${this.config.keyPrefix}:*`;
		let cursor = "0";
		let purged = 0;

		do {
			let res: [string, string[]];
			try {
				res = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
			} catch (err) {
				console.warn(
					`[blok][concurrency][redis] purgeExpired SCAN failed: ${err instanceof Error ? err.message : String(err)}; aborting sweep`,
				);
				return purged;
			}
			const [nextCursor, keys] = res;
			cursor = nextCursor;
			for (const key of keys) {
				try {
					const raw = await client.eval(PURGE_BUCKET_LUA, 1, key, String(now));
					const count = typeof raw === "number" ? raw : Number(raw);
					if (!Number.isNaN(count)) purged += count;
				} catch {
					// Best-effort — skip this bucket; janitor will retry on next sweep.
				}
			}
		} while (cursor !== "0");

		return purged;
	}

	/**
	 * Decode the `{acquired, currentInFlight}` pair from a Lua eval result.
	 * ioredis returns Redis arrays as plain JS arrays of (string | number)
	 * — the script returns integers, so both elements should be numbers.
	 */
	private parsePair(raw: unknown): [number, number] {
		if (!Array.isArray(raw) || raw.length < 2) return [0, -1];
		const acquired = typeof raw[0] === "number" ? raw[0] : Number(raw[0]);
		const current = typeof raw[1] === "number" ? raw[1] : Number(raw[1]);
		return [Number.isFinite(acquired) ? acquired : 0, Number.isFinite(current) ? current : -1];
	}
}
