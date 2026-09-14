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
import { type SqliteDatabase, ensureSqliteDir, openSqlite } from "@blokjs/session";

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
		const found = this.db
			.prepare("SELECT user_id, expires_at FROM blok_password_resets WHERE token_hash = ?")
			.get(tokenHash);
		// Delete unconditionally, before the expiry check — a token that was
		// presented is spent, valid or not.
		this.db.prepare("DELETE FROM blok_password_resets WHERE token_hash = ?").run(tokenHash);
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
