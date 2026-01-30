import { InMemoryRunStore } from "./InMemoryRunStore";
import type { RunStore } from "./RunStore";

export type StoreType = "memory" | "sqlite" | "postgres";

export interface CreateStoreOptions {
	/** Storage backend: "memory" (default), "sqlite", or "postgres". */
	type?: StoreType;
	/** SQLite database file path. Default: ".blok/trace.db" */
	sqlitePath?: string;
	/** PostgreSQL connection string. Default: BLOK_TRACE_DATABASE_URL env var. */
	postgresUrl?: string;
	/** PostgreSQL pool size. Default: 5 */
	postgresPoolSize?: number;
	/** PostgreSQL SSL mode. Default: false */
	postgresSsl?: boolean | { rejectUnauthorized: boolean };
	/** Data retention in days. Runs older than this are auto-deleted. 0 = no retention. */
	retentionDays?: number;
}

/**
 * Create a RunStore based on configuration.
 *
 * Reads from environment variables when options are not provided:
 * - `BLOK_TRACE_STORE` → "memory" | "sqlite" | "postgres" (default: "memory")
 * - `BLOK_TRACE_SQLITE_PATH` → SQLite file path (default: ".blok/trace.db")
 * - `BLOK_TRACE_DATABASE_URL` → PostgreSQL connection string
 * - `BLOK_TRACE_PG_POOL_SIZE` → PostgreSQL pool size (default: 5)
 * - `BLOK_TRACE_PG_SSL` → Enable PostgreSQL SSL (default: false)
 * - `BLOK_TRACE_RETENTION_DAYS` → Auto-delete after N days (default: 7, 0 = disabled)
 */
export function createStore(opts?: CreateStoreOptions): RunStore {
	const type = opts?.type || (process.env.BLOK_TRACE_STORE as StoreType) || "memory";
	const sqlitePath = opts?.sqlitePath || process.env.BLOK_TRACE_SQLITE_PATH || ".blok/trace.db";

	const retentionDays =
		opts?.retentionDays ??
		(process.env.BLOK_TRACE_RETENTION_DAYS ? Number.parseInt(process.env.BLOK_TRACE_RETENTION_DAYS, 10) : 7);

	let store: RunStore;

	switch (type) {
		case "postgres": {
			const connectionString = opts?.postgresUrl || process.env.BLOK_TRACE_DATABASE_URL;
			if (!connectionString) {
				throw new Error(
					"PostgresRunStore requires a connection string.\n" +
						"Set BLOK_TRACE_DATABASE_URL environment variable or pass postgresUrl option.\n" +
						"Example: BLOK_TRACE_DATABASE_URL=postgres://user:pass@localhost:5432/blok",
				);
			}

			const poolSize =
				opts?.postgresPoolSize ??
				(process.env.BLOK_TRACE_PG_POOL_SIZE ? Number.parseInt(process.env.BLOK_TRACE_PG_POOL_SIZE, 10) : 5);

			const ssl =
				opts?.postgresSsl ?? (process.env.BLOK_TRACE_PG_SSL === "true" ? { rejectUnauthorized: false } : false);

			// Dynamic import to avoid hard dependency
			const { PostgresRunStore } = require("./PostgresRunStore") as typeof import("./PostgresRunStore");
			store = new PostgresRunStore({
				connectionString,
				max: poolSize,
				ssl: ssl || undefined,
			});

			// Apply retention policy after initialization completes
			if (retentionDays > 0) {
				(store as import("./PostgresRunStore").PostgresRunStore)
					.ready()
					.then(() => {
						const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
						store.deleteRunsBefore(cutoff);
					})
					.catch(() => {});
			}

			return store;
		}
		case "sqlite": {
			// Ensure directory exists for SQLite file
			const path = require("node:path") as typeof import("node:path");
			const fs = require("node:fs") as typeof import("node:fs");
			const dir = path.dirname(sqlitePath);
			if (dir && dir !== "." && !fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			// Dynamic import to avoid hard dependency
			const { SqliteRunStore } = require("./SqliteRunStore") as typeof import("./SqliteRunStore");
			store = new SqliteRunStore(sqlitePath);
			break;
		}
		default:
			store = new InMemoryRunStore();
			break;
	}

	// Apply retention policy on startup (for persistent stores)
	if (retentionDays > 0 && type !== "memory") {
		const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
		store.deleteRunsBefore(cutoff);
	}

	return store;
}
