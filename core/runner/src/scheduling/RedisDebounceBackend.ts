/**
 * Tier C #1 · Redis-backed debounce backend.
 *
 * Coordinates per-(workflow, debounceKey) window state across processes
 * via a single Redis string key per bucket. Atomicity comes from
 * server-side **Lua scripts** — `registerPing` / `finalize` /
 * `cancel` / `purgeExpired` each run as a single `EVAL` with no OCC
 * retry loop (Lua runs single-threaded against the keyspace).
 *
 * Storage shape: one JSON document per `(workflowName, debounceKey)`
 * bucket. Owner identity is encoded in the doc itself as
 * `(activeRunId, ownerProcessId, ownerLeaseExpiresAt)`; lease handoff
 * happens atomically when a ping arrives after the lease expired.
 *
 * **Owner-local payload**: this backend tracks `pingCount`,
 * `lastPingAt`, and `scheduledAt` only — payloads do NOT travel across
 * processes. The owning process's local `onFire` closure fires when
 * its timer elapses.
 */

import type {
	DebounceBackend,
	DebounceFinalizeResult,
	DebounceRegisterBackendOpts,
	DebounceRegisterBackendResult,
} from "./DebounceBackend";

export interface RedisDebounceConfig {
	url?: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	db?: number;
	tls?: boolean;
	keyPrefix: string;
}

const DEFAULT_KEY_PREFIX = "blok-debounce";

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
 * Atomic registerPing. Reads the current doc (if any), decides
 * ownership, writes back the next state, and returns
 * `{outcome, activeRunId, scheduledAt, pingCount}`.
 *
 * KEYS[1] = bucket key
 * ARGV[1] = mode ("leading" | "trailing")
 * ARGV[2] = delayMs
 * ARGV[3] = maxDelayMs ("-1" when unset)
 * ARGV[4] = runId
 * ARGV[5] = processId
 * ARGV[6] = ownerLeaseMs
 * ARGV[7] = now
 *
 * Returns: { outcome ("owner-new" | "owner-extend" | "coalesce"),
 *            activeRunId, scheduledAt, pingCount }
 */
const REGISTER_PING_LUA = `
local raw = redis.call('GET', KEYS[1])
local existing = nil
if raw and raw ~= '' then
  local ok, parsed = pcall(cjson.decode, raw)
  if ok and type(parsed) == 'table' then
    existing = parsed
  end
end

local mode = ARGV[1]
local delayMs = tonumber(ARGV[2])
local maxDelayMsRaw = tonumber(ARGV[3])
local maxDelayMs
if maxDelayMsRaw and maxDelayMsRaw >= 0 then maxDelayMs = maxDelayMsRaw end
local runId = ARGV[4]
local processId = ARGV[5]
local ownerLeaseMs = tonumber(ARGV[6])
local now = tonumber(ARGV[7])

local function compute_scheduled_at(existing_doc, now_)
  local naive = now_ + delayMs
  local deadline
  if existing_doc and existing_doc.maxDelayDeadline then
    deadline = tonumber(existing_doc.maxDelayDeadline)
  elseif maxDelayMs then
    deadline = now_ + maxDelayMs
  end
  if deadline and deadline < naive then return deadline end
  return naive
end

local ownerActive = existing ~= nil and tonumber(existing.ownerLeaseExpiresAt) and tonumber(existing.ownerLeaseExpiresAt) > now

if not existing or not ownerActive then
  local first_ping_at = (existing and existing.firstPingAt) and tonumber(existing.firstPingAt) or now
  local max_delay_deadline
  if existing and existing.maxDelayDeadline then
    max_delay_deadline = tonumber(existing.maxDelayDeadline)
  elseif maxDelayMs then
    max_delay_deadline = now + maxDelayMs
  end
  local prev_count = (existing and existing.pingCount) and tonumber(existing.pingCount) or 0
  local doc = {
    mode = mode,
    delayMs = delayMs,
    maxDelayMs = maxDelayMs,
    maxDelayDeadline = max_delay_deadline,
    firstPingAt = first_ping_at,
    lastPingAt = now,
    pingCount = prev_count + 1,
    activeRunId = runId,
    ownerProcessId = processId,
    ownerLeaseExpiresAt = now + ownerLeaseMs,
    scheduledAt = compute_scheduled_at(existing, now),
  }
  redis.call('SET', KEYS[1], cjson.encode(doc))
  return { "owner-new", doc.activeRunId, tostring(doc.scheduledAt), tostring(doc.pingCount) }
end

if tostring(existing.ownerProcessId) == processId then
  -- We still own — extend window.
  existing.lastPingAt = now
  existing.pingCount = (tonumber(existing.pingCount) or 0) + 1
  existing.ownerLeaseExpiresAt = now + ownerLeaseMs
  existing.scheduledAt = compute_scheduled_at(existing, now)
  redis.call('SET', KEYS[1], cjson.encode(existing))
  return { "owner-extend", tostring(existing.activeRunId), tostring(existing.scheduledAt), tostring(existing.pingCount) }
end

-- Different process owns — coalesce.
existing.lastPingAt = now
existing.pingCount = (tonumber(existing.pingCount) or 0) + 1
existing.scheduledAt = compute_scheduled_at(existing, now)
redis.call('SET', KEYS[1], cjson.encode(existing))
return { "coalesce", tostring(existing.activeRunId), tostring(existing.scheduledAt), tostring(existing.pingCount) }
`;

/**
 * Atomic finalize. The owning process calls this on local timer fire.
 *
 * KEYS[1] = bucket key
 * ARGV[1] = runId (the OWNING runId from the caller's perspective)
 * ARGV[2] = now
 *
 * Returns:
 *   { "fire" }                          — caller still owns AND silence elapsed; DELETE done.
 *   { "reschedule", "<scheduledAt>" }   — coalesce pings pushed scheduledAt forward.
 *   { "abandoned" }                     — caller no longer owns OR bucket gone.
 */
const FINALIZE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw or raw == '' then return { "abandoned" } end

local ok, doc = pcall(cjson.decode, raw)
if not ok or type(doc) ~= 'table' then return { "abandoned" } end

if tostring(doc.activeRunId) ~= ARGV[1] then return { "abandoned" } end

local now = tonumber(ARGV[2])
local scheduled = tonumber(doc.scheduledAt) or 0
if now < scheduled then
  return { "reschedule", tostring(scheduled) }
end

redis.call('DEL', KEYS[1])
return { "fire" }
`;

export function readRedisDebounceConfigFromEnv(): RedisDebounceConfig {
	const url = process.env.BLOK_DEBOUNCE_REDIS_URL?.trim() || undefined;
	const host = process.env.BLOK_DEBOUNCE_REDIS_HOST?.trim() || undefined;
	const portRaw = process.env.BLOK_DEBOUNCE_REDIS_PORT?.trim();
	const port = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : undefined;
	const dbRaw = process.env.BLOK_DEBOUNCE_REDIS_DB?.trim();
	const db = dbRaw && /^\d+$/.test(dbRaw) ? Number(dbRaw) : undefined;
	const tls = process.env.BLOK_DEBOUNCE_REDIS_TLS === "1" || process.env.BLOK_DEBOUNCE_REDIS_TLS === "true";
	return {
		url,
		host,
		port,
		password: process.env.BLOK_DEBOUNCE_REDIS_PASSWORD,
		username: process.env.BLOK_DEBOUNCE_REDIS_USERNAME,
		db,
		tls,
		keyPrefix: process.env.BLOK_DEBOUNCE_REDIS_KEY_PREFIX?.trim() || DEFAULT_KEY_PREFIX,
	};
}

export class RedisDebounceBackend implements DebounceBackend {
	readonly name = "redis";

	private client: RedisClient | null = null;
	private readonly config: RedisDebounceConfig;
	private connected = false;

	constructor(config?: Partial<RedisDebounceConfig>) {
		const env = readRedisDebounceConfigFromEnv();
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

		const blokEnv = process.env.BLOK_ENV;
		const nodeEnv = process.env.NODE_ENV;
		const isProd = blokEnv === "production" || nodeEnv === "production";
		if (isProd && this.config.keyPrefix === DEFAULT_KEY_PREFIX) {
			throw new Error(
				`[blok] Redis debounce backend refuses to start in production with the default key prefix ('${DEFAULT_KEY_PREFIX}'). Set BLOK_DEBOUNCE_REDIS_KEY_PREFIX to a deployment-unique value (e.g. 'blok-debounce-acme-prod') to prevent cross-deployment collision on a shared Redis instance.`,
			);
		}

		let ioredisModule: IoredisModule;
		try {
			ioredisModule = (await import("ioredis")) as unknown as IoredisModule;
		} catch (err) {
			throw new Error(
				`RedisDebounceBackend requires the 'ioredis' package. Install it: \`bun add ioredis\` or \`npm install ioredis\`. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const IORedisCtor = ioredisModule.default ?? ioredisModule.Redis;
		if (!IORedisCtor) {
			throw new Error(
				"RedisDebounceBackend could not locate the ioredis constructor on the imported module. Reinstall ioredis or report this issue.",
			);
		}

		// Same fail-fast posture as RedisConcurrencyBackend.
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

		this.client.on("error", (err: Error) => {
			console.warn(`[blok][debounce][redis] client error: ${err.message}`);
		});

		await this.client.ping();
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return;
		try {
			await this.client?.quit();
		} catch {
			// best-effort
		} finally {
			this.client = null;
			this.connected = false;
		}
	}

	private bucketKey(workflowName: string, debounceKey: string): string {
		return `${this.config.keyPrefix}:${this.encodeSegment(workflowName)}__${this.encodeSegment(debounceKey)}`;
	}

	private encodeSegment(s: string): string {
		return s.replace(/[^-_=.a-zA-Z0-9]/g, (ch) => `_${ch.codePointAt(0)?.toString(16)}_`);
	}

	private requireClient(): RedisClient {
		if (!this.client) {
			throw new Error("RedisDebounceBackend not connected — call connect() first.");
		}
		return this.client;
	}

	async registerPing(opts: DebounceRegisterBackendOpts): Promise<DebounceRegisterBackendResult> {
		const client = this.requireClient();
		const key = this.bucketKey(opts.workflowName, opts.debounceKey);

		const raw = await client.eval(
			REGISTER_PING_LUA,
			1,
			key,
			opts.mode,
			String(opts.delayMs),
			opts.maxDelayMs !== undefined ? String(opts.maxDelayMs) : "-1",
			opts.runId,
			opts.processId,
			String(opts.ownerLeaseMs),
			String(opts.now),
		);
		return this.parseRegisterResult(raw);
	}

	async finalize(
		workflowName: string,
		debounceKey: string,
		runId: string,
		now: number,
	): Promise<DebounceFinalizeResult> {
		const client = this.requireClient();
		const key = this.bucketKey(workflowName, debounceKey);
		const raw = await client.eval(FINALIZE_LUA, 1, key, runId, String(now));
		return this.parseFinalizeResult(raw);
	}

	async cancel(workflowName: string, debounceKey: string): Promise<boolean> {
		const client = this.requireClient();
		const key = this.bucketKey(workflowName, debounceKey);
		const deleted = await client.del(key);
		return deleted > 0;
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
			} catch {
				return purged;
			}
			const [nextCursor, keys] = res;
			cursor = nextCursor;
			for (const key of keys) {
				try {
					const raw = await client.eval(PURGE_EXPIRED_BUCKET_LUA, 1, key, String(now));
					const count = typeof raw === "number" ? raw : Number(raw);
					if (!Number.isNaN(count)) purged += count;
				} catch {
					// best-effort
				}
			}
		} while (cursor !== "0");

		return purged;
	}

	private parseRegisterResult(raw: unknown): DebounceRegisterBackendResult {
		if (!Array.isArray(raw) || raw.length < 4) {
			throw new Error(`Unexpected Lua result shape for registerPing: ${JSON.stringify(raw)}`);
		}
		const outcome = String(raw[0]);
		if (outcome !== "owner-new" && outcome !== "owner-extend" && outcome !== "coalesce") {
			throw new Error(`Unexpected outcome in Lua result: ${outcome}`);
		}
		return {
			outcome,
			activeRunId: String(raw[1]),
			scheduledAt: Number(raw[2]),
			pingCount: Number(raw[3]),
		};
	}

	private parseFinalizeResult(raw: unknown): DebounceFinalizeResult {
		if (!Array.isArray(raw) || raw.length < 1) return { finalize: "abandoned" };
		const tag = String(raw[0]);
		if (tag === "fire") return { finalize: "fire" };
		if (tag === "reschedule") return { finalize: "reschedule", scheduledAt: Number(raw[1]) };
		return { finalize: "abandoned" };
	}
}

/**
 * Per-bucket purge. Deletes the bucket iff the owner-lease has expired
 * AND scheduledAt has elapsed (no active owner with a pending fire).
 *
 * KEYS[1] = bucket key
 * ARGV[1] = now
 *
 * Returns: 1 if deleted, 0 otherwise.
 */
const PURGE_EXPIRED_BUCKET_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw or raw == '' then return 0 end
local ok, doc = pcall(cjson.decode, raw)
if not ok or type(doc) ~= 'table' then return 0 end
local now = tonumber(ARGV[1])
local lease = tonumber(doc.ownerLeaseExpiresAt) or 0
local sched = tonumber(doc.scheduledAt) or 0
if lease <= now and sched <= now then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;
