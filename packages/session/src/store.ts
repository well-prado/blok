/**
 * Session storage (#1018) — three backends behind one three-method interface.
 *
 * - `memory` — a `Map`. Dev and tests; nothing survives a restart, and two
 *   replicas do not share sessions.
 * - `sqlite` — the DEFAULT. Same driver selection the runner's own stores use
 *   (`bun:sqlite` under Bun, `better-sqlite3` under Node), so a Blok project
 *   that already persists runs needs no new dependency.
 * - `redis` — `ioredis`, selected automatically when `REDIS_URL` is set. The
 *   only backend that is correct for more than one process.
 *
 * Expiry is enforced on READ in every backend (and by Redis's own TTL), so a
 * stale row can never authenticate anyone even if the sweep has not run.
 */

import { createRequire } from "node:module";

const esmRequire = createRequire(import.meta.url);

/** One stored session. `data` is whatever the app put there; `expiresAt` is epoch ms. */
export interface SessionRecord {
	id: string;
	data: Record<string, unknown>;
	expiresAt: number;
}

/** The storage contract. Three methods — everything else is cookie plumbing. */
export interface SessionStore {
	/** The live record at `id`, or `undefined` when absent or expired. */
	read(id: string): Promise<SessionRecord | undefined>;
	/** Create or replace a record. */
	write(record: SessionRecord): Promise<void>;
	/** Remove a record. Missing ids are not an error. */
	destroy(id: string): Promise<void>;
}

/** Minimal pg client surface accepted by {@link PostgresSessionStore}. */
export interface SessionPgClient {
	query<Row = Record<string, unknown>>(
		text: string,
		values?: readonly unknown[],
	): Promise<{
		rows: Row[];
		rowCount?: number;
	}>;
}

export interface PostgresSessionStoreOptions {
	connectionString: string;
	max?: number;
	ssl?: boolean | { rejectUnauthorized: boolean };
	connectionTimeoutMillis?: number;
	idleTimeoutMillis?: number;
	retries?: number;
}

// =============================================================================
// memory
// =============================================================================

/** Process-local sessions. Dev and tests only — not durable, not shared. */
export class MemorySessionStore implements SessionStore {
	private readonly records = new Map<string, SessionRecord>();

	async read(id: string): Promise<SessionRecord | undefined> {
		const record = this.records.get(id);
		if (!record) return undefined;
		if (record.expiresAt <= Date.now()) {
			this.records.delete(id);
			return undefined;
		}
		return { ...record, data: { ...record.data } };
	}

	async write(record: SessionRecord): Promise<void> {
		this.records.set(record.id, { ...record, data: { ...record.data } });
	}

	async destroy(id: string): Promise<void> {
		this.records.delete(id);
	}

	/** Test helper — drop everything. */
	clear(): void {
		this.records.clear();
	}
}

// =============================================================================
// sqlite
// =============================================================================

/** The subset of `bun:sqlite` / `better-sqlite3` these stores use. */
export interface SqliteDatabase {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): unknown;
	close(): void;
}

export interface SqliteStatement {
	run(...params: unknown[]): unknown;
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all(...params: unknown[]): Record<string, unknown>[];
}

/**
 * Open a SQLite database on whichever driver this runtime has — Bun's built-in
 * `bun:sqlite`, else the `better-sqlite3` optional peer that `@blokjs/runner`
 * already declares for its run store.
 *
 * Exported because `@blokjs/auth`'s `SqliteUserStore` needs the exact same
 * selection; one copy of it keeps "which driver am I on?" a single answer.
 */
export function openSqlite(path: string, who: string): SqliteDatabase {
	let db: SqliteDatabase;
	if ("Bun" in globalThis) {
		const { Database } = esmRequire("bun:sqlite") as { Database: new (file: string) => SqliteDatabase };
		db = new Database(path);
	} else {
		let Database: new (file: string) => SqliteDatabase;
		try {
			Database = esmRequire("better-sqlite3") as new (file: string) => SqliteDatabase;
		} catch (error) {
			throw new Error(
				`[blok] ${who}: the sqlite backend needs a SQLite driver and none is installed.\nFix: \`bun add better-sqlite3\` (or run on Bun, which has bun:sqlite built in), or select another backend — set BLOK_SESSION_STORE=memory for dev, or REDIS_URL for a shared store. Underlying: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		db = new Database(path);
	}
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA journal_mode = WAL");
	return db;
}

/** Make sure the directory holding a SQLite file exists (`.blok/` on a fresh checkout). */
export function ensureSqliteDir(file: string): void {
	if (file === ":memory:") return;
	const { dirname } = esmRequire("node:path") as typeof import("node:path");
	const { mkdirSync } = esmRequire("node:fs") as typeof import("node:fs");
	mkdirSync(dirname(file), { recursive: true });
}

/** The default backend: one table, one file, no server. */
export class SqliteSessionStore implements SessionStore {
	private readonly db: SqliteDatabase;

	constructor(path = ".blok/sessions.db", db?: SqliteDatabase) {
		if (db) {
			this.db = db;
		} else {
			ensureSqliteDir(path);
			this.db = openSqlite(path, "@blokjs/session");
		}
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS blok_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)",
		);
	}

	async read(id: string): Promise<SessionRecord | undefined> {
		const row = this.db.prepare("SELECT id, data, expires_at FROM blok_sessions WHERE id = ?").get(id);
		if (!row) return undefined;
		const expiresAt = Number(row.expires_at);
		if (expiresAt <= Date.now()) {
			await this.destroy(id);
			return undefined;
		}
		return { id, data: parseData(row.data), expiresAt };
	}

	async write(record: SessionRecord): Promise<void> {
		this.db
			.prepare(
				"INSERT INTO blok_sessions (id, data, expires_at) VALUES (?, ?, ?) " +
					"ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at",
			)
			.run(record.id, JSON.stringify(record.data), record.expiresAt);
	}

	async destroy(id: string): Promise<void> {
		this.db.prepare("DELETE FROM blok_sessions WHERE id = ?").run(id);
	}

	/** Delete every expired row. Call it from a cron workflow if you want the file to shrink. */
	sweep(): void {
		this.db.prepare("DELETE FROM blok_sessions WHERE expires_at <= ?").run(Date.now());
	}

	close(): void {
		this.db.close();
	}
}

/** A stored `data` column back into an object; anything unparseable is an empty session. */
function parseData(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

// =============================================================================
// redis
// =============================================================================

/** The `ioredis` surface this store uses — kept structural so the import stays dynamic. */
interface RedisClient {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, mode: "PX", ttl: number): Promise<unknown>;
	del(key: string): Promise<unknown>;
	quit(): Promise<unknown>;
}

/**
 * Shared sessions for a fleet. `ioredis` is loaded dynamically and is an
 * OPTIONAL peer: a project that never sets `REDIS_URL` never needs it
 * installed — the same arrangement `@blokjs/redis-kv` uses.
 */
export class RedisSessionStore implements SessionStore {
	private client: RedisClient | null = null;

	constructor(
		private readonly url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
		private readonly prefix = "blok:session:",
	) {}

	private async redis(): Promise<RedisClient> {
		if (this.client) return this.client;
		type Ctor = new (url: string) => RedisClient;
		let mod: { default?: Ctor; Redis?: Ctor };
		try {
			mod = (await import("ioredis")) as { default?: Ctor; Redis?: Ctor };
		} catch (error) {
			throw new Error(
				`[blok] @blokjs/session: the redis backend needs 'ioredis' and it is not installed.\nFix: \`bun add ioredis\`, or unset REDIS_URL to fall back to the sqlite store. Underlying: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		const Ctor = mod.default ?? mod.Redis;
		if (typeof Ctor !== "function") throw new Error("[blok] @blokjs/session: 'ioredis' exposed no Redis constructor.");
		this.client = new Ctor(this.url);
		return this.client;
	}

	async read(id: string): Promise<SessionRecord | undefined> {
		const raw = await (await this.redis()).get(this.prefix + id);
		if (raw === null) return undefined;
		try {
			const parsed = JSON.parse(raw) as SessionRecord;
			// Redis expires the key itself; this only covers a clock skew window.
			if (parsed.expiresAt <= Date.now()) return undefined;
			return { id, data: parsed.data ?? {}, expiresAt: parsed.expiresAt };
		} catch {
			return undefined;
		}
	}

	async write(record: SessionRecord): Promise<void> {
		const ttl = Math.max(1, record.expiresAt - Date.now());
		await (await this.redis()).set(this.prefix + record.id, JSON.stringify(record), "PX", ttl);
	}

	async destroy(id: string): Promise<void> {
		await (await this.redis()).del(this.prefix + id);
	}

	async close(): Promise<void> {
		if (!this.client) return;
		await this.client.quit();
		this.client = null;
	}
}

// =============================================================================
// postgres / Neon
// =============================================================================

interface SessionPgPool extends SessionPgClient {
	end?(): Promise<void>;
}

/**
 * Postgres-backed cookie sessions for serverless deployments.
 *
 * The pool is deliberately created lazily and kept module-local by the
 * caller's configured store, which lets warm Function invocations reuse a
 * connection while `max=1` remains a safe Neon default. Every operation waits
 * for the schema migration, so a cold request cannot race table creation.
 */
export class PostgresSessionStore implements SessionStore {
	private readonly client: SessionPgClient;
	private readonly pool?: SessionPgPool;
	private readonly retries: number;
	private readonly readyPromise: Promise<void>;

	constructor(options: PostgresSessionStoreOptions | SessionPgClient) {
		if ("connectionString" in options) {
			const config = options as PostgresSessionStoreOptions;
			let Pool: new (options: Record<string, unknown>) => SessionPgPool;
			try {
				const mod = esmRequire("pg") as { Pool?: typeof Pool };
				if (!mod.Pool) throw new Error("no Pool export");
				Pool = mod.Pool;
			} catch (error) {
				throw new Error(
					`[blok] @blokjs/session: the postgres backend needs the optional 'pg' peer. Fix: bun add pg. Underlying: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			this.pool = new Pool({
				connectionString: config.connectionString,
				max: config.max ?? 1,
				ssl: config.ssl,
				connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
				idleTimeoutMillis: config.idleTimeoutMillis ?? 10_000,
			});
			this.client = this.pool;
			this.retries = config.retries ?? 2;
		} else {
			this.client = options;
			this.retries = 0;
		}
		this.readyPromise = this.migrateSchema();
	}

	/** Resolve only after the schema exists; required before serving traffic. */
	ready(): Promise<void> {
		return this.readyPromise;
	}

	async migrate(): Promise<void> {
		await this.readyPromise;
	}

	private async migrateSchema(): Promise<void> {
		await this.withRetry(() =>
			this.client.query(`
				CREATE TABLE IF NOT EXISTS blok_sessions (
					id TEXT PRIMARY KEY,
					data JSONB NOT NULL,
					expires_at BIGINT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_blok_sessions_expires ON blok_sessions(expires_at);
			`),
		);
	}

	async read(id: string): Promise<SessionRecord | undefined> {
		await this.readyPromise;
		const result = await this.withRetry(() =>
			this.client.query<{ id: string; data: unknown; expires_at: number | string }>(
				"SELECT id, data, expires_at FROM blok_sessions WHERE id = $1",
				[id],
			),
		);
		const row = result.rows[0];
		if (!row) return undefined;
		const expiresAt = Number(row.expires_at);
		if (expiresAt <= Date.now()) {
			await this.destroy(id);
			return undefined;
		}
		return { id: row.id, data: parsePgData(row.data), expiresAt };
	}

	async write(record: SessionRecord): Promise<void> {
		await this.readyPromise;
		await this.withRetry(() =>
			this.client.query(
				"INSERT INTO blok_sessions (id, data, expires_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at",
				[record.id, JSON.stringify(record.data), record.expiresAt],
			),
		);
	}

	async destroy(id: string): Promise<void> {
		await this.readyPromise;
		await this.withRetry(() => this.client.query("DELETE FROM blok_sessions WHERE id = $1", [id]));
	}

	/** Delete expired rows; call from an external cron rather than a Function loop. */
	async sweep(now = Date.now()): Promise<number> {
		await this.readyPromise;
		const result = await this.withRetry(() =>
			this.client.query("DELETE FROM blok_sessions WHERE expires_at <= $1", [now]),
		);
		return result.rowCount ?? 0;
	}

	async close(): Promise<void> {
		await this.pool?.end?.();
	}

	private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
		let attempt = 0;
		while (true) {
			try {
				return await operation();
			} catch (error) {
				if (attempt >= this.retries || !isTransientPgError(error)) throw error;
				const delay = 25 * 2 ** attempt;
				await new Promise((resolve) => setTimeout(resolve, delay));
				attempt += 1;
			}
		}
	}
}

function parsePgData(raw: unknown): Record<string, unknown> {
	if (typeof raw === "string") {
		try {
			const parsed: unknown = JSON.parse(raw);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	}
	return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function isTransientPgError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = String((error as { code?: unknown }).code ?? "");
	return (
		["08000", "08003", "08006", "40001", "40P01", "57P01", "57P02", "57P03"].includes(code) ||
		["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"].includes(code)
	);
}

// =============================================================================
// selection
// =============================================================================

export type SessionStoreType = "memory" | "sqlite" | "redis" | "postgres";

/**
 * The backend this process should use, from the environment:
 *
 * - `BLOK_SESSION_STORE` wins when set (`memory` | `sqlite` | `redis` | `postgres`).
 * - otherwise `redis` when `REDIS_URL` is set,
 * - otherwise `memory` under `NODE_ENV=test` (so suites need no fixture — the
 *   same rule `createStore()` applies to the run store),
 * - otherwise `sqlite` at `BLOK_SESSION_SQLITE_PATH` (default `.blok/sessions.db`).
 */
export function createSessionStore(): SessionStore {
	const explicit = process.env.BLOK_SESSION_STORE as SessionStoreType | undefined;
	const databaseUrl =
		process.env.BLOK_SESSION_DATABASE_URL || process.env.BLOK_DATABASE_URL || process.env.DATABASE_URL;
	const type: SessionStoreType =
		explicit ??
		(process.env.BLOK_SERVERLESS === "1" && databaseUrl
			? "postgres"
			: process.env.REDIS_URL
				? "redis"
				: process.env.NODE_ENV === "test"
					? "memory"
					: "sqlite");
	switch (type) {
		case "memory":
			return new MemorySessionStore();
		case "redis":
			return new RedisSessionStore();
		case "sqlite":
			return new SqliteSessionStore(process.env.BLOK_SESSION_SQLITE_PATH || ".blok/sessions.db");
		case "postgres": {
			if (!databaseUrl) {
				throw new Error(
					"[blok] @blokjs/session: postgres backend requires BLOK_SESSION_DATABASE_URL, BLOK_DATABASE_URL, or DATABASE_URL.",
				);
			}
			const poolSize = parsePositiveInt(process.env.BLOK_SESSION_PG_POOL_SIZE || process.env.BLOK_PG_POOL_SIZE, 1);
			const ssl = parseSsl(process.env.BLOK_SESSION_PG_SSL || process.env.BLOK_PG_SSL);
			return new PostgresSessionStore({
				connectionString: databaseUrl,
				max: poolSize,
				ssl,
				retries: parsePositiveInt(process.env.BLOK_PG_RETRIES, 2),
			});
		}
		default:
			throw new Error(
				`[blok] @blokjs/session: BLOK_SESSION_STORE="${String(type)}" is not a known backend.\nFix: use one of memory | sqlite | redis | postgres, or pass your own store to configureSession({ store }).`,
			);
	}
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (!raw || !/^\d+$/.test(raw)) return fallback;
	const value = Number(raw);
	return value > 0 ? value : fallback;
}

function parseSsl(raw: string | undefined): boolean | { rejectUnauthorized: boolean } | undefined {
	if (!raw || raw === "false" || raw === "0") return undefined;
	return raw === "no-verify" ? { rejectUnauthorized: false } : true;
}
