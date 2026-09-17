/**
 * `UserStore` (#1018) — the whole persistence surface of the auth kit.
 *
 * Six methods. No ORM, no migration runner, no entity classes: the kit needs to
 * find a user, make one, change a password and hand out single-use reset
 * tokens, and an interface that says exactly that is a thing an app can
 * implement over whatever it already has.
 *
 * Two implementations ship here — {@link MemoryUserStore} for tests and demos,
 * {@link SqliteUserStore} (the default) on the same driver `@blokjs/runner`
 * already uses for its run store. A Postgres implementation on `pg`, and the
 * same interface on Drizzle for apps that outgrow hand-written SQL, are in the
 * README; neither is a dependency of this package.
 *
 * ## Contract notes an implementation must honour
 *
 * - **Email is matched case-insensitively.** {@link normalizeEmail} is the one
 *   definition; both stores here run every lookup and every insert through it.
 *   Two accounts differing only in case are one account.
 * - **`create` rejects a duplicate email** — throw. The register flow checks
 *   first, so this only fires on a genuine race, and it must not silently
 *   overwrite a password.
 * - **Reset tokens are stored HASHED and consumed exactly once.**
 *   `consumeResetToken` must delete before returning, so two concurrent
 *   requests cannot both succeed.
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { type SqliteDatabase, ensureSqliteDir, openSqlite } from "@blokjs/session";

const esmRequire = createRequire(import.meta.url);

/** A stored user. `passwordHash` never leaves the server. */
export interface AuthUser {
	id: string;
	name: string;
	email: string;
	passwordHash: string;
	/** Epoch ms. */
	createdAt: number;
}

/** What `create()` is given. The id and timestamp are the store's to assign. */
export interface NewUser {
	name: string;
	email: string;
	passwordHash: string;
}

/** One issued password-reset token, stored by HASH. */
export interface ResetTokenRecord {
	userId: string;
	/** HMAC of the raw token — the raw value exists only in the user's email. */
	tokenHash: string;
	/** Epoch ms. */
	expiresAt: number;
}

/** The persistence contract. Implement it over whatever your app already uses. */
export interface UserStore {
	findByEmail(email: string): Promise<AuthUser | undefined>;
	findById(id: string): Promise<AuthUser | undefined>;
	/** @throws when `email` is already taken. */
	create(user: NewUser): Promise<AuthUser>;
	updatePassword(id: string, passwordHash: string): Promise<void>;
	createResetToken(record: ResetTokenRecord): Promise<void>;
	/** Delete the token and return its owner — or `undefined` when unknown or expired. */
	consumeResetToken(tokenHash: string): Promise<{ userId: string } | undefined>;
}

/** Minimal pg client surface accepted by {@link PostgresUserStore}. */
export interface AuthPgClient {
	query<Row = Record<string, unknown>>(
		text: string,
		values?: readonly unknown[],
	): Promise<{
		rows: Row[];
		rowCount?: number;
	}>;
}

export interface PostgresUserStoreOptions {
	connectionString: string;
	max?: number;
	ssl?: boolean | { rejectUnauthorized: boolean };
	connectionTimeoutMillis?: number;
	idleTimeoutMillis?: number;
	retries?: number;
}

/** The single definition of "the same email address". */
export function normalizeEmail(email: string): string {
	return String(email).trim().toLowerCase();
}

/** The error `create()` throws on a duplicate address, so callers can tell it apart. */
export class DuplicateEmailError extends Error {
	constructor(email: string) {
		super(`@blokjs/auth: an account already exists for ${email}.`);
		this.name = "DuplicateEmailError";
	}
}

// =============================================================================
// memory
// =============================================================================

/** Process-local users. Tests and demos — nothing survives a restart. */
export class MemoryUserStore implements UserStore {
	private readonly users = new Map<string, AuthUser>();
	private readonly resets = new Map<string, ResetTokenRecord>();

	async findByEmail(email: string): Promise<AuthUser | undefined> {
		const wanted = normalizeEmail(email);
		for (const user of this.users.values()) if (user.email === wanted) return { ...user };
		return undefined;
	}

	async findById(id: string): Promise<AuthUser | undefined> {
		const user = this.users.get(id);
		return user ? { ...user } : undefined;
	}

	async create(input: NewUser): Promise<AuthUser> {
		const email = normalizeEmail(input.email);
		if (await this.findByEmail(email)) throw new DuplicateEmailError(email);
		const user: AuthUser = {
			id: randomUUID(),
			name: input.name,
			email,
			passwordHash: input.passwordHash,
			createdAt: Date.now(),
		};
		this.users.set(user.id, user);
		return { ...user };
	}

	async updatePassword(id: string, passwordHash: string): Promise<void> {
		const user = this.users.get(id);
		if (user) this.users.set(id, { ...user, passwordHash });
	}

	async createResetToken(record: ResetTokenRecord): Promise<void> {
		this.resets.set(record.tokenHash, { ...record });
	}

	async consumeResetToken(tokenHash: string): Promise<{ userId: string } | undefined> {
		const record = this.resets.get(tokenHash);
		// Delete first: single-use has to hold even when the token turns out to
		// be expired, and two concurrent resets must not both win.
		this.resets.delete(tokenHash);
		if (!record || record.expiresAt <= Date.now()) return undefined;
		return { userId: record.userId };
	}

	/** Test helper — drop everything. */
	clear(): void {
		this.users.clear();
		this.resets.clear();
	}
}

// =============================================================================
// sqlite — the default
// =============================================================================

/**
 * The default store: two tables in one file, on `bun:sqlite` or
 * `better-sqlite3` (whichever the runtime has — {@link openSqlite} picks).
 *
 * ponytail: `CREATE TABLE IF NOT EXISTS` in the constructor, not a migration
 * runner. The schema is two tables that a starter kit is not going to reshape;
 * an app that outgrows it has already replaced this class with its own
 * `UserStore`. Upgrade path if the schema ever does change: the same
 * `user_version` pragma ladder `SqliteRunStore` uses.
 */
export class SqliteUserStore implements UserStore {
	private readonly db: SqliteDatabase;

	constructor(path = ".blok/auth.db", db?: SqliteDatabase) {
		if (db) {
			this.db = db;
		} else {
			ensureSqliteDir(path);
			this.db = openSqlite(path, "@blokjs/auth");
		}
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS blok_users (" +
				"id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, " +
				"password_hash TEXT NOT NULL, created_at INTEGER NOT NULL)",
		);
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS blok_password_resets (" +
				"token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)",
		);
	}

	async findByEmail(email: string): Promise<AuthUser | undefined> {
		return row(this.db.prepare(`${SELECT} WHERE email = ?`).get(normalizeEmail(email)));
	}

	async findById(id: string): Promise<AuthUser | undefined> {
		return row(this.db.prepare(`${SELECT} WHERE id = ?`).get(id));
	}

	async create(input: NewUser): Promise<AuthUser> {
		const user: AuthUser = {
			id: randomUUID(),
			name: input.name,
			email: normalizeEmail(input.email),
			passwordHash: input.passwordHash,
			createdAt: Date.now(),
		};
		try {
			this.db
				.prepare("INSERT INTO blok_users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
				.run(user.id, user.name, user.email, user.passwordHash, user.createdAt);
		} catch (error) {
			// The UNIQUE index is the real guard: the register flow's pre-check
			// loses to a concurrent signup for the same address.
			if (String(error).includes("UNIQUE")) throw new DuplicateEmailError(user.email);
			throw error;
		}
		return user;
	}

	async updatePassword(id: string, passwordHash: string): Promise<void> {
		this.db.prepare("UPDATE blok_users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
	}

	async createResetToken(record: ResetTokenRecord): Promise<void> {
		this.db
			.prepare(
				"INSERT INTO blok_password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?) " +
					"ON CONFLICT(token_hash) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at",
			)
			.run(record.tokenHash, record.userId, record.expiresAt);
	}

	async consumeResetToken(tokenHash: string): Promise<{ userId: string } | undefined> {
		// ONE statement, not SELECT-then-DELETE: `DELETE … RETURNING` (SQLite
		// 3.35+, which both `bun:sqlite` and `better-sqlite3` bundle) makes
		// single-use ATOMIC. A separate read would let two workers sharing the
		// file both see the row before either removed it, and both reset the
		// password. The expiry is checked after the delete on purpose — a token
		// that was presented is spent, valid or not.
		const found = this.db
			.prepare("DELETE FROM blok_password_resets WHERE token_hash = ? RETURNING user_id, expires_at")
			.get(tokenHash);
		if (!found || Number(found.expires_at) <= Date.now()) return undefined;
		return { userId: String(found.user_id) };
	}

	/** Delete every expired reset token. Optional housekeeping. */
	sweep(): void {
		this.db.prepare("DELETE FROM blok_password_resets WHERE expires_at <= ?").run(Date.now());
	}

	close(): void {
		this.db.close();
	}
}

// =============================================================================
// postgres / Neon
// =============================================================================

interface AuthPgPool extends AuthPgClient {
	end?(): Promise<void>;
}

/** Durable, cross-instance auth users and single-use reset tokens. */
export class PostgresUserStore implements UserStore {
	private readonly client: AuthPgClient;
	private readonly pool?: AuthPgPool;
	private readonly retries: number;
	private readonly readyPromise: Promise<void>;

	constructor(options: PostgresUserStoreOptions | AuthPgClient) {
		if ("connectionString" in options) {
			const config = options as PostgresUserStoreOptions;
			let Pool: new (options: Record<string, unknown>) => AuthPgPool;
			try {
				const mod = esmRequire("pg") as { Pool?: typeof Pool };
				if (!mod.Pool) throw new Error("no Pool export");
				Pool = mod.Pool;
			} catch (error) {
				throw new Error(
					`[blok] @blokjs/auth: the postgres backend needs the optional 'pg' peer. Fix: bun add pg. Underlying: ${error instanceof Error ? error.message : String(error)}`,
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

	ready(): Promise<void> {
		return this.readyPromise;
	}

	async migrate(): Promise<void> {
		await this.readyPromise;
	}

	private async migrateSchema(): Promise<void> {
		await this.withRetry(() =>
			this.client.query(`
				CREATE TABLE IF NOT EXISTS blok_users (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					email TEXT NOT NULL UNIQUE,
					password_hash TEXT NOT NULL,
					created_at BIGINT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS blok_password_resets (
					token_hash TEXT PRIMARY KEY,
					user_id TEXT NOT NULL REFERENCES blok_users(id) ON DELETE CASCADE,
					expires_at BIGINT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_blok_password_resets_expires ON blok_password_resets(expires_at);
			`),
		);
	}

	async findByEmail(email: string): Promise<AuthUser | undefined> {
		await this.readyPromise;
		const result = await this.withRetry(() =>
			this.client.query<AuthUserRow>(`${AUTH_SELECT} WHERE email = $1`, [normalizeEmail(email)]),
		);
		return authRow(result.rows[0]);
	}

	async findById(id: string): Promise<AuthUser | undefined> {
		await this.readyPromise;
		const result = await this.withRetry(() => this.client.query<AuthUserRow>(`${AUTH_SELECT} WHERE id = $1`, [id]));
		return authRow(result.rows[0]);
	}

	async create(input: NewUser): Promise<AuthUser> {
		await this.readyPromise;
		const user: AuthUser = {
			id: randomUUID(),
			name: input.name,
			email: normalizeEmail(input.email),
			passwordHash: input.passwordHash,
			createdAt: Date.now(),
		};
		try {
			await this.withRetry(() =>
				this.client.query(
					"INSERT INTO blok_users (id, name, email, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)",
					[user.id, user.name, user.email, user.passwordHash, user.createdAt],
				),
			);
		} catch (error) {
			if (isUniqueConstraintError(error)) throw new DuplicateEmailError(user.email);
			throw error;
		}
		return user;
	}

	async updatePassword(id: string, passwordHash: string): Promise<void> {
		await this.readyPromise;
		await this.withRetry(() =>
			this.client.query("UPDATE blok_users SET password_hash = $1 WHERE id = $2", [passwordHash, id]),
		);
	}

	async createResetToken(record: ResetTokenRecord): Promise<void> {
		await this.readyPromise;
		await this.withRetry(() =>
			this.client.query(
				"INSERT INTO blok_password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at",
				[record.tokenHash, record.userId, record.expiresAt],
			),
		);
	}

	async consumeResetToken(tokenHash: string): Promise<{ userId: string } | undefined> {
		await this.readyPromise;
		const result = await this.withRetry(() =>
			this.client.query<{ user_id: string; expires_at: number | string }>(
				"DELETE FROM blok_password_resets WHERE token_hash = $1 RETURNING user_id, expires_at",
				[tokenHash],
			),
		);
		const row = result.rows[0];
		return row && Number(row.expires_at) > Date.now() ? { userId: row.user_id } : undefined;
	}

	async sweep(now = Date.now()): Promise<number> {
		await this.readyPromise;
		const result = await this.withRetry(() =>
			this.client.query("DELETE FROM blok_password_resets WHERE expires_at <= $1", [now]),
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
				await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
				attempt += 1;
			}
		}
	}
}

interface AuthUserRow {
	id: string;
	name: string;
	email: string;
	password_hash: string;
	created_at: number | string;
}

const AUTH_SELECT = "SELECT id, name, email, password_hash, created_at FROM blok_users";

function authRow(row: AuthUserRow | undefined): AuthUser | undefined {
	return row
		? {
				id: row.id,
				name: row.name,
				email: row.email,
				passwordHash: row.password_hash,
				createdAt: Number(row.created_at),
			}
		: undefined;
}

function isUniqueConstraintError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505");
}

function isTransientPgError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = String((error as { code?: unknown }).code ?? "");
	return [
		"08000",
		"08003",
		"08006",
		"40001",
		"40P01",
		"57P01",
		"57P02",
		"57P03",
		"ECONNRESET",
		"ECONNREFUSED",
		"ETIMEDOUT",
		"EPIPE",
	].includes(code);
}

const SELECT = "SELECT id, name, email, password_hash, created_at FROM blok_users";

function row(record: Record<string, unknown> | undefined): AuthUser | undefined {
	if (!record) return undefined;
	return {
		id: String(record.id),
		name: String(record.name),
		email: String(record.email),
		passwordHash: String(record.password_hash),
		createdAt: Number(record.created_at),
	};
}
