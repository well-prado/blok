import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { InMemoryRunStore } from "./InMemoryRunStore";
import type { RunStore } from "./RunStore";

const esmRequire = createRequire(import.meta.url);

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

			// Dynamic require to avoid hard dependency on pg
			const { PostgresRunStore } = esmRequire("./PostgresRunStore") as typeof import("./PostgresRunStore");
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
			const dir = path.dirname(sqlitePath);
			if (dir && dir !== "." && !fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			// Dynamic require to avoid hard dependency on better-sqlite3.
			// Cast via the typeof-import type so we get autocomplete +
			// type-checking even though `esmRequire` is `unknown` at the
			// type level. One-liner to keep biome's formatter from
			// breaking the dynamic-import-type expression across lines.
			// biome-ignore format: typeof import(...) must stay on one line for tsc to parse
			const sqliteMod = esmRequire("./SqliteRunStore") as typeof import("./SqliteRunStore");
			const { SqliteRunStore, readIndexedMetadataKeysFromEnv } = sqliteMod;
			// F1 (v0.5) — opt-in indexed metadata keys via
			// `BLOK_INDEXED_METADATA_KEYS=tier,region`. The store
			// promotes each declared key to a generated column + index
			// so SQLite's planner uses the index when a `RunQuery`
			// filter references it.
			store = new SqliteRunStore(sqlitePath, { indexedMetadataKeys: readIndexedMetadataKeysFromEnv() });
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
