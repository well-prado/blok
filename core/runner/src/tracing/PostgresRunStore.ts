import { createRequire } from "node:module";
import { InMemoryRunStore } from "./InMemoryRunStore";

const esmRequire = createRequire(import.meta.url);
import type { RunStore } from "./RunStore";
import type {
	Dashboard,
	MetricsResult,
	NodeRun,
	RunEvent,
	RunQuery,
	SavedFilter,
	ScheduledDispatchRow,
	TraceLogEntry,
	WorkflowRun,
	WorkflowSample,
	WorkflowSummary,
} from "./types";

/**
 * PostgreSQL connection configuration.
 */
export interface PostgresConfig {
	/** PostgreSQL connection string (e.g. "postgres://user:pass@host:5432/blok") */
	connectionString: string;
	/** Maximum pool size (default: 5) */
	max?: number;
	/** SSL configuration */
	ssl?: boolean | { rejectUnauthorized: boolean };
}

type PgPool = import("pg").Pool;

/**
 * PostgreSQL-backed RunStore using the `pg` driver.
 *
 * Uses a hybrid approach for performance:
 * - All reads and writes go through an in-memory store (sync, fast)
 * - Writes are also queued for async persistence to PostgreSQL
 * - On startup, recent data is loaded from PostgreSQL into memory
 *
 * This preserves the synchronous RunStore interface while providing
 * durable storage that survives process restarts.
 */
export class PostgresRunStore implements RunStore {
	private memory: InMemoryRunStore;
	private pool: PgPool;
	private writeQueue: Array<() => Promise<void>> = [];
	private flushing = false;
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private initPromise: Promise<void>;
	private closed = false;

	constructor(config: PostgresConfig) {
		this.memory = new InMemoryRunStore();

		let Pool: typeof import("pg").Pool;
		try {
			const mod = "pg";
			Pool = esmRequire(mod).Pool;
		} catch {
			throw new Error(
				"PostgresRunStore requires 'pg'. Install it:\n" + "  npm install pg\n" + "  # or\n" + "  pnpm add pg",
			);
		}

		this.pool = new Pool({
			connectionString: config.connectionString,
			max: config.max ?? 5,
			ssl: config.ssl,
		});

		// Start async initialization in background
		this.initPromise = this.initialize().catch((err) => {
			console.error("[PostgresRunStore] Initialization failed:", err.message);
		});
	}

	/**
	 * Returns a promise that resolves when the store is fully initialized
	 * (migrations run and data loaded from PostgreSQL).
	 * The store is usable before this resolves — it just won't have historical data.
	 */
	ready(): Promise<void> {
		return this.initPromise;
	}

	// === Initialization ===

	private async initialize(): Promise<void> {
		await this.migrate();
		await this.loadRecent();
		this.startFlushLoop();
	}

	private async migrate(): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query(`
				CREATE TABLE IF NOT EXISTS _trace_migrations (
					version INTEGER PRIMARY KEY,
					applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
				)
			`);

			const { rows } = await client.query("SELECT version FROM _trace_migrations");
			const applied = new Set(rows.map((r: { version: number }) => r.version));

			const migrations: Array<{ version: number; up: () => Promise<void> }> = [
				{
					version: 1,
					up: async () => {
						await client.query(`
							CREATE TABLE IF NOT EXISTS workflow_runs (
								id TEXT PRIMARY KEY,
								workflow_name TEXT NOT NULL,
								workflow_path TEXT NOT NULL,
								trigger_type TEXT NOT NULL,
								trigger_summary TEXT NOT NULL,
								status TEXT NOT NULL DEFAULT 'running',
								started_at BIGINT NOT NULL,
								finished_at BIGINT,
								duration_ms BIGINT,
								error_json JSONB,
								tags_json JSONB DEFAULT '[]'::jsonb,
								metadata_json JSONB,
								node_count INTEGER NOT NULL DEFAULT 0,
								completed_nodes INTEGER NOT NULL DEFAULT 0
							)
						`);
						await client.query("CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs(workflow_name)");
						await client.query("CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status)");
						await client.query("CREATE INDEX IF NOT EXISTS idx_runs_started_at ON workflow_runs(started_at)");

						await client.query(`
							CREATE TABLE IF NOT EXISTS node_runs (
								id TEXT PRIMARY KEY,
								run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
								node_name TEXT NOT NULL,
								node_type TEXT NOT NULL,
								runtime_kind TEXT,
								status TEXT NOT NULL DEFAULT 'running',
								started_at BIGINT NOT NULL,
								finished_at BIGINT,
								duration_ms BIGINT,
								inputs_json JSONB,
								outputs_json JSONB,
								error_json JSONB,
								parent_node_id TEXT,
								depth INTEGER NOT NULL DEFAULT 0,
								step_index INTEGER NOT NULL DEFAULT 0,
								metrics_json JSONB
							)
						`);
						await client.query("CREATE INDEX IF NOT EXISTS idx_nodes_run ON node_runs(run_id)");

						await client.query(`
							CREATE TABLE IF NOT EXISTS run_events (
								id TEXT PRIMARY KEY,
								type TEXT NOT NULL,
								run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
								workflow_name TEXT NOT NULL,
								timestamp BIGINT NOT NULL,
								node_name TEXT,
								node_id TEXT,
								payload_json JSONB
							)
						`);
						await client.query("CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id)");
						await client.query("CREATE INDEX IF NOT EXISTS idx_events_timestamp ON run_events(timestamp)");

						await client.query(`
							CREATE TABLE IF NOT EXISTS log_entries (
								id TEXT PRIMARY KEY,
								run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
								node_id TEXT,
								node_name TEXT,
								level TEXT NOT NULL,
								message TEXT NOT NULL,
								timestamp BIGINT NOT NULL,
								data_json JSONB
							)
						`);
						await client.query("CREATE INDEX IF NOT EXISTS idx_logs_run ON log_entries(run_id)");
					},
				},
				{
					version: 2,
					up: async () => {
						await client.query(`
							CREATE TABLE IF NOT EXISTS dashboards (
								id TEXT PRIMARY KEY,
								name TEXT NOT NULL,
								description TEXT,
								is_default BOOLEAN NOT NULL DEFAULT FALSE,
								created_at BIGINT NOT NULL,
								updated_at BIGINT NOT NULL,
								widgets_json JSONB NOT NULL DEFAULT '[]'::jsonb
							)
						`);
					},
				},
				{
					// Tier 2 follow-up · durable schema for Tier 1 idempotency
					// cache, Tier 2 #6 concurrency locks, and Tier 2 #5+#7
					// scheduled dispatches. Previously these all delegated to
					// the in-memory mirror only, so a process restart lost the
					// state. The hybrid pattern (sync memory + async PG mirror)
					// matches the existing workflow_runs/node_runs flow.
					version: 3,
					up: async () => {
						await client.query(`
							CREATE TABLE IF NOT EXISTS idempotency_cache (
								workflow_name TEXT NOT NULL,
								step_id TEXT NOT NULL,
								idempotency_key TEXT NOT NULL,
								data_json JSONB NOT NULL,
								cached_at BIGINT NOT NULL,
								expires_at BIGINT,
								source_run_id TEXT NOT NULL,
								source_node_run_id TEXT NOT NULL,
								PRIMARY KEY (workflow_name, step_id, idempotency_key)
							)
						`);
						await client.query("CREATE INDEX IF NOT EXISTS idx_idem_cache_expires ON idempotency_cache(expires_at)");

						await client.query(`
							CREATE TABLE IF NOT EXISTS concurrency_locks (
								workflow_name TEXT NOT NULL,
								concurrency_key TEXT NOT NULL,
								run_id TEXT NOT NULL,
								acquired_at BIGINT NOT NULL,
								expires_at BIGINT NOT NULL,
								PRIMARY KEY (workflow_name, concurrency_key, run_id)
							)
						`);
						await client.query("CREATE INDEX IF NOT EXISTS idx_locks_expires ON concurrency_locks(expires_at)");
						await client.query(
							"CREATE INDEX IF NOT EXISTS idx_locks_workflow_key ON concurrency_locks(workflow_name, concurrency_key)",
						);

						await client.query(`
							CREATE TABLE IF NOT EXISTS scheduled_dispatches (
								run_id TEXT PRIMARY KEY,
								workflow_name TEXT NOT NULL,
								trigger_type TEXT NOT NULL,
								scheduled_at BIGINT NOT NULL,
								expires_at BIGINT,
								dispatch_status TEXT NOT NULL,
								payload_json JSONB NOT NULL,
								created_at BIGINT NOT NULL
							)
						`);
						await client.query(
							"CREATE INDEX IF NOT EXISTS idx_scheduled_dispatches_at ON scheduled_dispatches(scheduled_at)",
						);
						await client.query(
							"CREATE INDEX IF NOT EXISTS idx_scheduled_dispatches_trigger ON scheduled_dispatches(trigger_type, workflow_name)",
						);
					},
				},
				{
					// PR 4 — wait.for / wait.until step primitive needs a
					// resume cursor so dispatchDeferred re-entry skips
					// already-completed pre-wait steps. Mirror sqlite v10.
					version: 4,
					up: async () => {
						await client.query("ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS last_completed_step_index INTEGER");
					},
				},
				{
					// PR 1-5 polish · catch up to sqlite's workflow_runs columns.
					// PG migrations historically lagged: v3 added the cache /
					// locks / dispatches tables and v4 added
					// `last_completed_step_index`, but the columns sqlite added
					// across migrations 3 / 5 / 6 / 8 (`environment`,
					// `replay_of`, `parent_run_id`, `parent_node_run_id`,
					// `scheduled_at`, `expires_at`, `debounce_key`,
					// `debounce_mode`, `ping_count`) were never mirrored.
					// `saveRun`/`updateRun`/`rowToRun` silently dropped them
					// across restarts, so PG-backed deployments lost replay
					// lineage, sub-workflow lineage, and ALL Tier 2 #5+#7
					// scheduling state on every restart. This migration adds
					// the columns + indexes so PG matches sqlite. Pre-existing
					// rows get NULL on every new column (backward-compat;
					// `rowToRun` reads NULL `environment` as "production" to
					// match sqlite's legacy default).
					version: 5,
					up: async () => {
						await client.query("ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS environment TEXT");
						await client.query("ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS replay_of TEXT");
						await client.query("ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS parent_run_id TEXT");
						await client.query("ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS parent_node_run_id TEXT");
						await client.query("ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS scheduled_at BIGINT");
						await client.query("ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS expires_at BIGINT");
						await client.query("ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS debounce_key TEXT");
						await client.query("ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS debounce_mode TEXT");
						await client.query("ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS ping_count INTEGER");
						await client.query("CREATE INDEX IF NOT EXISTS idx_runs_environment ON workflow_runs(environment)");
						await client.query("CREATE INDEX IF NOT EXISTS idx_runs_replay_of ON workflow_runs(replay_of)");
						await client.query("CREATE INDEX IF NOT EXISTS idx_runs_parent_run ON workflow_runs(parent_run_id)");
						await client.query("CREATE INDEX IF NOT EXISTS idx_runs_scheduled_at ON workflow_runs(scheduled_at)");
						await client.query(
							"CREATE INDEX IF NOT EXISTS idx_runs_debounce_key ON workflow_runs(workflow_name, debounce_key)",
						);
					},
				},
				{
					// Tier C #2 — cross-process scheduler coordination.
					//
					// Multi-process PG deployments risk double-firing the same
					// dispatch when both processes' `recoverDispatches()`
					// register timers against the same row. The claim columns
					// let processes atomically take ownership; the
					// `DeferredRunScheduler` heartbeats `claimed_at` while a
					// timer is registered; a dead process's claim expires
					// after `BLOK_SCHEDULER_CLAIM_LEASE_MS` and a surviving
					// process can take over on its next recovery.
					version: 6,
					up: async () => {
						await client.query("ALTER TABLE scheduled_dispatches ADD COLUMN IF NOT EXISTS claimed_by TEXT");
						await client.query("ALTER TABLE scheduled_dispatches ADD COLUMN IF NOT EXISTS claimed_at BIGINT");
						await client.query(
							"CREATE INDEX IF NOT EXISTS idx_scheduled_dispatches_claim ON scheduled_dispatches(claimed_by, claimed_at)",
						);
					},
				},
				{
					// E2 · server-side saved filters for the runs list.
					// Matches the sqlite store's v14 schema. Hybrid pattern:
					// rehydrated into the in-memory mirror on boot via
					// `loadRecent`, mutated through the same `enqueueWrite`
					// fan-out used by dashboards.
					version: 7,
					up: async () => {
						await client.query(`
							CREATE TABLE IF NOT EXISTS trace_saved_filters (
								id TEXT PRIMARY KEY,
								name TEXT NOT NULL UNIQUE,
								status TEXT NOT NULL DEFAULT '',
								tags_input TEXT NOT NULL DEFAULT '',
								metadata_input TEXT NOT NULL DEFAULT '',
								created_at BIGINT NOT NULL,
								updated_at BIGINT NOT NULL
							)
						`);
						await client.query(
							"CREATE INDEX IF NOT EXISTS idx_saved_filters_updated_at ON trace_saved_filters(updated_at)",
						);
					},
				},
				{
					// v0.6 follow-up to #100 — recorded sample bodies for the
					// Studio empty-state curl. Matches the sqlite store's v15
					// schema. One row per workflow (PK on workflow_name);
					// the trigger only writes the FIRST successful run's body
					// so the operator-visible curl stays stable.
					version: 8,
					up: async () => {
						await client.query(`
							CREATE TABLE IF NOT EXISTS trace_workflow_samples (
								workflow_name TEXT PRIMARY KEY,
								body_json JSONB NOT NULL,
								source_run_id TEXT NOT NULL,
								recorded_at BIGINT NOT NULL
							)
						`);
					},
				},
				{
					// v0.6 follow-up — bag column for Studio-visible step flags
					// (`wait`, `dispatch`, `subworkflowDepth`, `middleware`,
					// `iterationIndex`). Mirrors sqlite v16. Previously these
					// fields lived only on the in-memory NodeRun and vanished
					// on round-trip — rail badges disappeared after process
					// restart. JSONB so future flag additions don't need new
					// migrations.
					version: 9,
					up: async () => {
						await client.query("ALTER TABLE node_runs ADD COLUMN IF NOT EXISTS flags_json JSONB");
					},
				},
			];

			for (const m of migrations) {
				if (!applied.has(m.version)) {
					await client.query("BEGIN");
					try {
						await m.up();
						await client.query("INSERT INTO _trace_migrations (version) VALUES ($1)", [m.version]);
						await client.query("COMMIT");
					} catch (err) {
						await client.query("ROLLBACK");
						throw err;
					}
				}
			}
		} finally {
			client.release();
		}
	}

	/**
	 * Review fix-up · CONCERN-2. Per-table cap on `loadRecent`'s rehydration
	 * queries. Without it, a deployment with 1M+ idempotency cache entries
	 * spends seconds + memory on every boot loading rows it'll never read
	 * before the Janitor sweeps them. Default 100K rows per table — well
	 * above any reasonable hot-set size yet bounded for boot latency.
	 */
	private getLoadRecentLimit(): number {
		const raw = process.env.BLOK_PG_LOADRECENT_LIMIT;
		if (!raw || !/^\d+$/.test(raw)) return 100_000;
		const n = Number(raw);
		return n > 0 ? n : 100_000;
	}

	private async loadRecent(): Promise<void> {
		const client = await this.pool.connect();
		try {
			// Load recent runs (last 1000)
			const { rows: runRows } = await client.query("SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT 1000");
			for (const row of runRows) {
				this.memory.saveRun(this.rowToRun(row));
			}

			if (runRows.length > 0) {
				const runIds = runRows.map((r: { id: string }) => r.id);

				// Load node runs for loaded runs
				const { rows: nodeRows } = await client.query(
					"SELECT * FROM node_runs WHERE run_id = ANY($1) ORDER BY step_index",
					[runIds],
				);
				for (const row of nodeRows) {
					this.memory.saveNodeRun(this.rowToNodeRun(row));
				}

				// Load events
				const { rows: eventRows } = await client.query(
					"SELECT * FROM run_events WHERE run_id = ANY($1) ORDER BY timestamp",
					[runIds],
				);
				for (const row of eventRows) {
					this.memory.saveEvent(this.rowToEvent(row));
				}

				// Load logs
				const { rows: logRows } = await client.query(
					"SELECT * FROM log_entries WHERE run_id = ANY($1) ORDER BY timestamp",
					[runIds],
				);
				for (const row of logRows) {
					this.memory.saveLog(this.rowToLog(row));
				}
			}

			// Load dashboards
			const { rows: dashRows } = await client.query("SELECT * FROM dashboards ORDER BY updated_at DESC");
			for (const row of dashRows) {
				this.memory.saveDashboard(this.rowToDashboard(row));
			}

			// E2 · rehydrate saved filters. Unbounded (operator-curated
			// set, not a per-run table — typical fleet has < 100 entries).
			try {
				const { rows: filterRows } = await client.query("SELECT * FROM trace_saved_filters ORDER BY updated_at DESC");
				for (const row of filterRows) {
					this.memory.upsertSavedFilter({
						id: row.id,
						name: row.name,
						status: row.status,
						tagsInput: row.tags_input,
						metadataInput: row.metadata_input,
						createdAt: Number(row.created_at),
						updatedAt: Number(row.updated_at),
					});
				}
			} catch (err) {
				// First-time deployments may not have run the v7 migration
				// when this loadRecent fires (the migration is at boot;
				// this should follow). Log + continue.
				console.warn("[blok][pg] failed to load saved filters:", (err as Error).message);
			}

			// v0.6 · rehydrate recorded sample bodies. Cardinality
			// bounded by the number of workflows in the deployment, not
			// the run volume — unbounded SELECT is fine.
			try {
				const { rows: sampleRows } = await client.query("SELECT * FROM trace_workflow_samples");
				for (const row of sampleRows) {
					this.memory.recordWorkflowSample({
						workflowName: row.workflow_name,
						body: typeof row.body_json === "string" ? JSON.parse(row.body_json) : row.body_json,
						sourceRunId: row.source_run_id,
						recordedAt: Number(row.recorded_at),
					});
				}
			} catch (err) {
				console.warn("[blok][pg] failed to load workflow samples:", (err as Error).message);
			}

			// Tier 2 follow-up · rehydrate idempotency cache (un-expired entries only).
			//
			// Review fix-up · CONCERN-2. Add `ORDER BY cached_at DESC LIMIT N`.
			// Newest cache entries are most likely to be re-hit by the next
			// idempotent step; older ones the Janitor will sweep on its next
			// pass. Without this LIMIT, deployments with 1M+ rows OOM at boot.
			const now = Date.now();
			const loadRecentLimit = this.getLoadRecentLimit();
			try {
				const { rows: idemRows } = await client.query(
					`SELECT * FROM idempotency_cache
					 WHERE expires_at IS NULL OR expires_at > $1
					 ORDER BY cached_at DESC
					 LIMIT $2`,
					[now, loadRecentLimit],
				);
				for (const row of idemRows) {
					this.memory.setIdempotencyCache(row.workflow_name, row.step_id, row.idempotency_key, {
						data: typeof row.data_json === "string" ? JSON.parse(row.data_json) : row.data_json,
						cachedAt: Number(row.cached_at),
						expiresAt: row.expires_at !== null ? Number(row.expires_at) : null,
						sourceRunId: row.source_run_id,
						sourceNodeRunId: row.source_node_run_id,
					});
				}
			} catch (err) {
				// Pre-v3 PG schema may not have the table yet — fall through quietly.
				if (!String((err as Error).message).match(/relation .* does not exist/i)) {
					console.error("[PostgresRunStore] idempotency_cache load failed:", (err as Error).message);
				}
			}

			// Tier 2 follow-up · rehydrate concurrency leases (un-expired only).
			//
			// Review fix-up · CONCERN-2. Add `ORDER BY expires_at DESC LIMIT N`.
			// Locks with the longest remaining lease are most likely still
			// active and worth restoring; expired ones are filtered already.
			try {
				const { rows: lockRows } = await client.query(
					`SELECT * FROM concurrency_locks
					 WHERE expires_at > $1
					 ORDER BY expires_at DESC
					 LIMIT $2`,
					[now, loadRecentLimit],
				);
				for (const row of lockRows) {
					this.memory.acquireConcurrencySlot(
						row.workflow_name,
						row.concurrency_key,
						Number.MAX_SAFE_INTEGER, // skip the limit check — we're restoring, not granting
						row.run_id,
						Number(row.expires_at),
					);
				}
			} catch (err) {
				if (!String((err as Error).message).match(/relation .* does not exist/i)) {
					console.error("[PostgresRunStore] concurrency_locks load failed:", (err as Error).message);
				}
			}

			// Tier 2 follow-up · rehydrate scheduled dispatches.
			// PR 2 A5 — ORDER BY scheduled_at ASC so past-due dispatches
			// hydrate first. recoverDispatches's past-due → fire-immediately
			// path benefits from the ordering.
			//
			// Review fix-up · CONCERN-2. Add LIMIT for defense-in-depth.
			// Even with the 1MB payload cap (PR 2 A4), 100K dispatches × 1MB
			// = 100GB of JSON-decode work at boot. Past-due first means the
			// LIMIT caps how many recover per boot; the rest surface on the
			// Janitor's next sweep or a subsequent boot.
			try {
				const { rows: dispatchRows } = await client.query(
					"SELECT * FROM scheduled_dispatches ORDER BY scheduled_at ASC LIMIT $1",
					[loadRecentLimit],
				);
				for (const row of dispatchRows) {
					this.memory.upsertScheduledDispatch({
						runId: row.run_id,
						workflowName: row.workflow_name,
						triggerType: row.trigger_type,
						scheduledAt: Number(row.scheduled_at),
						expiresAt: row.expires_at !== null ? Number(row.expires_at) : undefined,
						dispatchStatus: row.dispatch_status,
						payload: typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json,
						createdAt: Number(row.created_at),
						// Tier C #2 — surface claim state across restart so
						// the trigger doesn't re-claim a row another process
						// already owns. PG columns may not exist on pre-v6
						// databases — guard with `?? undefined`.
						claimedBy: row.claimed_by !== null && row.claimed_by !== undefined ? row.claimed_by : undefined,
						claimedAt: row.claimed_at !== null && row.claimed_at !== undefined ? Number(row.claimed_at) : undefined,
					});
				}
			} catch (err) {
				if (!String((err as Error).message).match(/relation .* does not exist/i)) {
					console.error("[PostgresRunStore] scheduled_dispatches load failed:", (err as Error).message);
				}
			}
		} finally {
			client.release();
		}
	}

	// === Writes (sync via memory + async queue to PG) ===

	saveRun(run: WorkflowRun): void {
		this.memory.saveRun(run);
		// PR 1-5 polish · column set mirrors sqlite saveRun (24 columns).
		// PG migration v5 added the trailing 9 (environment / replay_of /
		// parent_run_id / parent_node_run_id / scheduled_at / expires_at /
		// debounce_key / debounce_mode / ping_count); PG migration v4 added
		// last_completed_step_index. Without these the PG mirror silently
		// dropped scheduling + lineage + resume-cursor state across restart.
		this.enqueueWrite(() =>
			this.pool
				.query(
					`INSERT INTO workflow_runs
				(id, workflow_name, workflow_path, trigger_type, trigger_summary,
				 status, started_at, finished_at, duration_ms, error_json,
				 tags_json, metadata_json, node_count, completed_nodes,
				 environment, replay_of, parent_run_id, parent_node_run_id,
				 scheduled_at, expires_at, debounce_key, debounce_mode,
				 ping_count, last_completed_step_index)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
				        $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
				ON CONFLICT (id) DO UPDATE SET
				 status = EXCLUDED.status,
				 finished_at = EXCLUDED.finished_at,
				 duration_ms = EXCLUDED.duration_ms,
				 error_json = EXCLUDED.error_json,
				 tags_json = EXCLUDED.tags_json,
				 metadata_json = EXCLUDED.metadata_json,
				 completed_nodes = EXCLUDED.completed_nodes,
				 environment = EXCLUDED.environment,
				 replay_of = EXCLUDED.replay_of,
				 parent_run_id = EXCLUDED.parent_run_id,
				 parent_node_run_id = EXCLUDED.parent_node_run_id,
				 scheduled_at = EXCLUDED.scheduled_at,
				 expires_at = EXCLUDED.expires_at,
				 debounce_key = EXCLUDED.debounce_key,
				 debounce_mode = EXCLUDED.debounce_mode,
				 ping_count = EXCLUDED.ping_count,
				 last_completed_step_index = EXCLUDED.last_completed_step_index`,
					[
						run.id,
						run.workflowName,
						run.workflowPath,
						run.triggerType,
						run.triggerSummary,
						run.status,
						run.startedAt,
						run.finishedAt ?? null,
						run.durationMs ?? null,
						run.error ? JSON.stringify(run.error) : null,
						JSON.stringify(run.tags || []),
						run.metadata ? JSON.stringify(run.metadata) : null,
						run.nodeCount,
						run.completedNodes,
						run.environment ?? null,
						run.replayOf ?? null,
						run.parentRunId ?? null,
						run.parentNodeRunId ?? null,
						run.scheduledAt ?? null,
						run.expiresAt ?? null,
						run.debounceKey ?? null,
						run.debounceMode ?? null,
						run.pingCount ?? null,
						run.lastCompletedStepIndex ?? null,
					],
				)
				.then(() => {}),
		);
	}

	updateRun(runId: string, updates: Partial<WorkflowRun>): void {
		this.memory.updateRun(runId, updates);

		const setClauses: string[] = [];
		const values: unknown[] = [];
		let paramIdx = 1;

		if (updates.status !== undefined) {
			setClauses.push(`status = $${paramIdx++}`);
			values.push(updates.status);
		}
		if (updates.finishedAt !== undefined) {
			setClauses.push(`finished_at = $${paramIdx++}`);
			values.push(updates.finishedAt);
		}
		if (updates.durationMs !== undefined) {
			setClauses.push(`duration_ms = $${paramIdx++}`);
			values.push(updates.durationMs);
		}
		if (updates.error !== undefined) {
			setClauses.push(`error_json = $${paramIdx++}`);
			values.push(JSON.stringify(updates.error));
		}
		if (updates.tags !== undefined) {
			setClauses.push(`tags_json = $${paramIdx++}`);
			values.push(JSON.stringify(updates.tags));
		}
		if (updates.completedNodes !== undefined) {
			setClauses.push(`completed_nodes = $${paramIdx++}`);
			values.push(updates.completedNodes);
		}
		if (updates.metadata !== undefined) {
			setClauses.push(`metadata_json = $${paramIdx++}`);
			values.push(JSON.stringify(updates.metadata));
		}
		// PR 1-5 polish · scheduling, lineage, and resume-cursor fields
		// updateRun must mirror sqlite. Each marker tracker method
		// (markRunDelayed / markRunQueued / markRunDebounced / markRunExpired
		// / recordDebouncePing / transitionRunToRunning / RunnerSteps wait
		// branch) updates one or more of these. Without these clauses the
		// in-memory mirror has the value but PG keeps the original (or
		// NULL).
		if (updates.replayOf !== undefined) {
			setClauses.push(`replay_of = $${paramIdx++}`);
			values.push(updates.replayOf);
		}
		if (updates.parentRunId !== undefined) {
			setClauses.push(`parent_run_id = $${paramIdx++}`);
			values.push(updates.parentRunId);
		}
		if (updates.parentNodeRunId !== undefined) {
			setClauses.push(`parent_node_run_id = $${paramIdx++}`);
			values.push(updates.parentNodeRunId);
		}
		if (updates.scheduledAt !== undefined) {
			setClauses.push(`scheduled_at = $${paramIdx++}`);
			values.push(updates.scheduledAt);
		}
		if (updates.expiresAt !== undefined) {
			setClauses.push(`expires_at = $${paramIdx++}`);
			values.push(updates.expiresAt);
		}
		if (updates.debounceKey !== undefined) {
			setClauses.push(`debounce_key = $${paramIdx++}`);
			values.push(updates.debounceKey);
		}
		if (updates.debounceMode !== undefined) {
			setClauses.push(`debounce_mode = $${paramIdx++}`);
			values.push(updates.debounceMode);
		}
		if (updates.pingCount !== undefined) {
			setClauses.push(`ping_count = $${paramIdx++}`);
			values.push(updates.pingCount);
		}
		if (updates.lastCompletedStepIndex !== undefined) {
			setClauses.push(`last_completed_step_index = $${paramIdx++}`);
			values.push(updates.lastCompletedStepIndex);
		}
		// `transitionRunToRunning` (Tier 2 #5+#7) preserves the original
		// startedAt by updating it. Mirror sqlite, which also accepts it.
		if (updates.startedAt !== undefined) {
			setClauses.push(`started_at = $${paramIdx++}`);
			values.push(updates.startedAt);
		}

		if (setClauses.length === 0) return;

		values.push(runId);
		this.enqueueWrite(() =>
			this.pool
				.query(`UPDATE workflow_runs SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`, values)
				.then(() => {}),
		);
	}

	saveNodeRun(nodeRun: NodeRun): void {
		this.memory.saveNodeRun(nodeRun);
		const flagsJson = encodeNodeRunFlagsForPg(nodeRun);
		this.enqueueWrite(() =>
			this.pool
				.query(
					`INSERT INTO node_runs
				(id, run_id, node_name, node_type, runtime_kind,
				 status, started_at, finished_at, duration_ms,
				 inputs_json, outputs_json, error_json,
				 parent_node_id, depth, step_index, metrics_json, flags_json)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
				ON CONFLICT (id) DO UPDATE SET
				 status = EXCLUDED.status,
				 finished_at = EXCLUDED.finished_at,
				 duration_ms = EXCLUDED.duration_ms,
				 outputs_json = EXCLUDED.outputs_json,
				 error_json = EXCLUDED.error_json,
				 metrics_json = EXCLUDED.metrics_json,
				 flags_json = EXCLUDED.flags_json`,
					[
						nodeRun.id,
						nodeRun.runId,
						nodeRun.nodeName,
						nodeRun.nodeType,
						nodeRun.runtimeKind ?? null,
						nodeRun.status,
						nodeRun.startedAt,
						nodeRun.finishedAt ?? null,
						nodeRun.durationMs ?? null,
						nodeRun.inputs !== undefined ? JSON.stringify(nodeRun.inputs) : null,
						nodeRun.outputs !== undefined ? JSON.stringify(nodeRun.outputs) : null,
						nodeRun.error ? JSON.stringify(nodeRun.error) : null,
						nodeRun.parentNodeId ?? null,
						nodeRun.depth,
						nodeRun.stepIndex,
						nodeRun.metrics ? JSON.stringify(nodeRun.metrics) : null,
						flagsJson,
					],
				)
				.then(() => {}),
		);
	}

	updateNodeRun(nodeRunId: string, updates: Partial<NodeRun>): void {
		this.memory.updateNodeRun(nodeRunId, updates);

		const setClauses: string[] = [];
		const values: unknown[] = [];
		let paramIdx = 1;

		if (updates.status !== undefined) {
			setClauses.push(`status = $${paramIdx++}`);
			values.push(updates.status);
		}
		if (updates.finishedAt !== undefined) {
			setClauses.push(`finished_at = $${paramIdx++}`);
			values.push(updates.finishedAt);
		}
		if (updates.durationMs !== undefined) {
			setClauses.push(`duration_ms = $${paramIdx++}`);
			values.push(updates.durationMs);
		}
		if (updates.outputs !== undefined) {
			setClauses.push(`outputs_json = $${paramIdx++}`);
			values.push(JSON.stringify(updates.outputs));
		}
		if (updates.error !== undefined) {
			setClauses.push(`error_json = $${paramIdx++}`);
			values.push(JSON.stringify(updates.error));
		}
		if (updates.metrics !== undefined) {
			setClauses.push(`metrics_json = $${paramIdx++}`);
			values.push(JSON.stringify(updates.metrics));
		}

		if (setClauses.length === 0) return;

		values.push(nodeRunId);
		this.enqueueWrite(() =>
			this.pool.query(`UPDATE node_runs SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`, values).then(() => {}),
		);
	}

	saveEvent(event: RunEvent): void {
		this.memory.saveEvent(event);
		this.enqueueWrite(() =>
			this.pool
				.query(
					`INSERT INTO run_events (id, type, run_id, workflow_name, timestamp, node_name, node_id, payload_json)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				ON CONFLICT (id) DO NOTHING`,
					[
						event.id,
						event.type,
						event.runId,
						event.workflowName,
						event.timestamp,
						event.nodeName ?? null,
						event.nodeId ?? null,
						event.payload !== undefined ? JSON.stringify(event.payload) : null,
					],
				)
				.then(() => {}),
		);
	}

	saveLog(entry: TraceLogEntry): void {
		this.memory.saveLog(entry);
		this.enqueueWrite(() =>
			this.pool
				.query(
					`INSERT INTO log_entries (id, run_id, node_id, node_name, level, message, timestamp, data_json)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				ON CONFLICT (id) DO NOTHING`,
					[
						entry.id,
						entry.runId,
						entry.nodeId ?? null,
						entry.nodeName ?? null,
						entry.level,
						entry.message,
						entry.timestamp,
						entry.data ? JSON.stringify(entry.data) : null,
					],
				)
				.then(() => {}),
		);
	}

	// === Reads (delegated to in-memory store) ===

	getRun(runId: string): WorkflowRun | undefined {
		return this.memory.getRun(runId);
	}

	getRuns(opts?: RunQuery): { runs: WorkflowRun[]; total: number } {
		return this.memory.getRuns(opts);
	}

	getNodeRuns(runId: string): NodeRun[] {
		return this.memory.getNodeRuns(runId);
	}

	getNodeRun(nodeRunId: string): NodeRun | undefined {
		return this.memory.getNodeRun(nodeRunId);
	}

	getRunsByParent(parentRunId: string): WorkflowRun[] {
		// Tier 2 sub-workflow lineage. Same in-memory delegation strategy
		// as the idempotency cache — durable PG schema for parent_run_id
		// is deferred to a follow-up.
		return this.memory.getRunsByParent(parentRunId);
	}

	getEvents(runId: string, since?: number): RunEvent[] {
		return this.memory.getEvents(runId, since);
	}

	getLogs(runId: string, nodeId?: string): TraceLogEntry[] {
		return this.memory.getLogs(runId, nodeId);
	}

	// === Aggregations (delegated to in-memory store) ===

	getWorkflowSummaries(): WorkflowSummary[] {
		return this.memory.getWorkflowSummaries();
	}

	getAllTags(): string[] {
		return this.memory.getAllTags();
	}

	getActiveRunCount(): number {
		return this.memory.getActiveRunCount();
	}

	getMetrics(workflow?: string): MetricsResult {
		return this.memory.getMetrics(workflow);
	}

	// === Dashboards (sync via memory + async queue to PG) ===

	saveDashboard(dashboard: Dashboard): void {
		this.memory.saveDashboard(dashboard);
		this.enqueueWrite(() =>
			this.pool
				.query(
					`INSERT INTO dashboards (id, name, description, is_default, created_at, updated_at, widgets_json)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
				ON CONFLICT (id) DO UPDATE SET
				 name = EXCLUDED.name,
				 description = EXCLUDED.description,
				 is_default = EXCLUDED.is_default,
				 updated_at = EXCLUDED.updated_at,
				 widgets_json = EXCLUDED.widgets_json`,
					[
						dashboard.id,
						dashboard.name,
						dashboard.description ?? null,
						dashboard.isDefault,
						dashboard.createdAt,
						dashboard.updatedAt,
						JSON.stringify(dashboard.widgets),
					],
				)
				.then(() => {}),
		);
	}

	getDashboard(dashboardId: string): Dashboard | undefined {
		return this.memory.getDashboard(dashboardId);
	}

	listDashboards(): Dashboard[] {
		return this.memory.listDashboards();
	}

	deleteDashboard(dashboardId: string): boolean {
		const result = this.memory.deleteDashboard(dashboardId);
		if (result) {
			this.enqueueWrite(() => this.pool.query("DELETE FROM dashboards WHERE id = $1", [dashboardId]).then(() => {}));
		}
		return result;
	}

	updateDashboard(dashboardId: string, updates: Partial<Dashboard>): void {
		this.memory.updateDashboard(dashboardId, updates);

		const setClauses: string[] = ["updated_at = $1"];
		const values: unknown[] = [Date.now()];
		let paramIdx = 2;

		if (updates.name !== undefined) {
			setClauses.push(`name = $${paramIdx++}`);
			values.push(updates.name);
		}
		if (updates.description !== undefined) {
			setClauses.push(`description = $${paramIdx++}`);
			values.push(updates.description);
		}
		if (updates.isDefault !== undefined) {
			setClauses.push(`is_default = $${paramIdx++}`);
			values.push(updates.isDefault);
		}
		if (updates.widgets !== undefined) {
			setClauses.push(`widgets_json = $${paramIdx++}`);
			values.push(JSON.stringify(updates.widgets));
		}

		values.push(dashboardId);
		this.enqueueWrite(() =>
			this.pool.query(`UPDATE dashboards SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`, values).then(() => {}),
		);
	}

	// === Saved filters (E2) ===

	upsertSavedFilter(filter: SavedFilter): SavedFilter {
		const persisted = this.memory.upsertSavedFilter(filter);
		this.enqueueWrite(() =>
			this.pool
				.query(
					`INSERT INTO trace_saved_filters
						(id, name, status, tags_input, metadata_input, created_at, updated_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7)
					 ON CONFLICT (name) DO UPDATE SET
						status = EXCLUDED.status,
						tags_input = EXCLUDED.tags_input,
						metadata_input = EXCLUDED.metadata_input,
						updated_at = EXCLUDED.updated_at`,
					[
						persisted.id,
						persisted.name,
						persisted.status,
						persisted.tagsInput,
						persisted.metadataInput,
						persisted.createdAt,
						persisted.updatedAt,
					],
				)
				.then(() => {}),
		);
		return persisted;
	}

	listSavedFilters(): SavedFilter[] {
		return this.memory.listSavedFilters();
	}

	deleteSavedFilter(name: string): boolean {
		const removed = this.memory.deleteSavedFilter(name);
		if (removed) {
			this.enqueueWrite(() =>
				this.pool.query("DELETE FROM trace_saved_filters WHERE name = $1", [name]).then(() => {}),
			);
		}
		return removed;
	}

	// === Sample-body recording (option C) ===

	recordWorkflowSample(sample: WorkflowSample): WorkflowSample {
		// First-record-wins. Memory holds the canonical sample (sync
		// reads). PG INSERT uses ON CONFLICT DO NOTHING — same
		// "first-record sticks" semantic as the sqlite store.
		const persisted = this.memory.recordWorkflowSample(sample);
		this.enqueueWrite(() =>
			this.pool
				.query(
					`INSERT INTO trace_workflow_samples (workflow_name, body_json, source_run_id, recorded_at)
					 VALUES ($1, $2, $3, $4)
					 ON CONFLICT (workflow_name) DO NOTHING`,
					[persisted.workflowName, JSON.stringify(persisted.body), persisted.sourceRunId, persisted.recordedAt],
				)
				.then(() => {}),
		);
		return persisted;
	}

	getWorkflowSample(workflowName: string): WorkflowSample | undefined {
		return this.memory.getWorkflowSample(workflowName);
	}

	deleteWorkflowSample(workflowName: string): boolean {
		const removed = this.memory.deleteWorkflowSample(workflowName);
		if (removed) {
			this.enqueueWrite(() =>
				this.pool.query("DELETE FROM trace_workflow_samples WHERE workflow_name = $1", [workflowName]).then(() => {}),
			);
		}
		return removed;
	}

	// === Cleanup ===

	clearAll(): number {
		const count = this.memory.clearAll();
		this.enqueueWrite(async () => {
			await this.pool.query("DELETE FROM log_entries");
			await this.pool.query("DELETE FROM run_events");
			await this.pool.query("DELETE FROM node_runs");
			await this.pool.query("DELETE FROM workflow_runs");
			await this.pool.query("DELETE FROM dashboards");
			// Tier 2 follow-up — wipe durable tables too. Wrapped in
			// individual try blocks so a missing table (pre-v3 schema) on
			// one doesn't abort the others.
			for (const sql of [
				"DELETE FROM idempotency_cache",
				"DELETE FROM concurrency_locks",
				"DELETE FROM scheduled_dispatches",
			]) {
				try {
					await this.pool.query(sql);
				} catch (err) {
					if (!String((err as Error).message).match(/relation .* does not exist/i)) {
						console.error(`[PostgresRunStore] ${sql} failed:`, (err as Error).message);
					}
				}
			}
		});
		return count;
	}

	deleteRunsBefore(timestamp: number): number {
		const deleted = this.memory.deleteRunsBefore(timestamp);
		if (deleted > 0) {
			this.enqueueWrite(() =>
				this.pool
					.query("DELETE FROM workflow_runs WHERE started_at < $1 AND status != 'running'", [timestamp])
					.then(() => {}),
			);
		}
		return deleted;
	}

	evictOldRuns(maxRuns: number): void {
		this.memory.evictOldRuns(maxRuns);
		// PG eviction happens via deleteRunsBefore / retention policy
	}

	close(): void {
		this.stopFlushLoop();
		// Flush remaining writes synchronously-ish
		this.flush().finally(() => {
			this.pool.end().catch(() => {});
		});
		this.closed = true;
	}

	// === Idempotency cache (Tier 1) ===
	//
	// PG durable cache is out of scope for this PR — delegate to the
	// in-memory layer this store already uses for hot reads. Same-process
	// hits work exactly like the SQLite store; cross-process / cross-restart
	// hits are deferred to a follow-up PG schema migration. Operators
	// running PG today retain pre-Phase-3 behaviour (no caching) on a fresh
	// process and gain in-memory caching within a single process lifetime.
	//
	// Tier 2 follow-up (migration v3) — sync reads stay on the in-memory
	// mirror; writes async-persist to PG. On boot, `loadRecent()` rehydrates
	// the in-memory cache from PG so deferred dispatches + idempotency
	// entries + concurrency leases survive restarts.

	getIdempotencyCache(workflowName: string, stepId: string, key: string) {
		return this.memory.getIdempotencyCache(workflowName, stepId, key);
	}

	setIdempotencyCache(
		workflowName: string,
		stepId: string,
		key: string,
		entry: Parameters<typeof this.memory.setIdempotencyCache>[3],
	): void {
		this.memory.setIdempotencyCache(workflowName, stepId, key, entry);
		this.enqueueWrite(() =>
			this.pool
				.query(
					`INSERT INTO idempotency_cache
					(workflow_name, step_id, idempotency_key, data_json,
					 cached_at, expires_at, source_run_id, source_node_run_id)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
					ON CONFLICT (workflow_name, step_id, idempotency_key) DO UPDATE SET
					 data_json = EXCLUDED.data_json,
					 cached_at = EXCLUDED.cached_at,
					 expires_at = EXCLUDED.expires_at,
					 source_run_id = EXCLUDED.source_run_id,
					 source_node_run_id = EXCLUDED.source_node_run_id`,
					[
						workflowName,
						stepId,
						key,
						JSON.stringify(entry.data),
						entry.cachedAt,
						entry.expiresAt,
						entry.sourceRunId,
						entry.sourceNodeRunId,
					],
				)
				.then(() => {}),
		);
	}

	purgeExpiredIdempotencyCache(now: number): number {
		const removed = this.memory.purgeExpiredIdempotencyCache(now);
		this.enqueueWrite(() =>
			this.pool
				.query("DELETE FROM idempotency_cache WHERE expires_at IS NOT NULL AND expires_at <= $1", [now])
				.then(() => {}),
		);
		return removed;
	}

	// === Concurrency gating (Tier 2 #6) ===
	// Sync grants happen on the in-memory mirror; PG mirror is async-only.
	// The gate is single-process (in-process backend); PG persistence here is
	// purely for crash-recovery — boot loads active
	// (un-expired) leases back into memory so a process restart doesn't
	// over-grant.

	acquireConcurrencySlot(
		workflowName: string,
		concurrencyKey: string,
		concurrencyLimit: number,
		runId: string,
		leaseExpiresAt: number,
	) {
		const result = this.memory.acquireConcurrencySlot(
			workflowName,
			concurrencyKey,
			concurrencyLimit,
			runId,
			leaseExpiresAt,
		);
		if (result.acquired) {
			this.enqueueWrite(() =>
				this.pool
					.query(
						`INSERT INTO concurrency_locks
						(workflow_name, concurrency_key, run_id, acquired_at, expires_at)
						VALUES ($1, $2, $3, $4, $5)
						ON CONFLICT (workflow_name, concurrency_key, run_id) DO UPDATE SET
						 expires_at = EXCLUDED.expires_at`,
						[workflowName, concurrencyKey, runId, Date.now(), leaseExpiresAt],
					)
					.then(() => {}),
			);
		}
		return result;
	}

	releaseConcurrencySlot(workflowName: string, concurrencyKey: string, runId: string): void {
		this.memory.releaseConcurrencySlot(workflowName, concurrencyKey, runId);
		this.enqueueWrite(() =>
			this.pool
				.query("DELETE FROM concurrency_locks WHERE workflow_name = $1 AND concurrency_key = $2 AND run_id = $3", [
					workflowName,
					concurrencyKey,
					runId,
				])
				.then(() => {}),
		);
	}

	purgeExpiredConcurrencySlots(now: number): number {
		const removed = this.memory.purgeExpiredConcurrencySlots(now);
		this.enqueueWrite(() =>
			this.pool.query("DELETE FROM concurrency_locks WHERE expires_at <= $1", [now]).then(() => {}),
		);
		return removed;
	}

	getConcurrencySnapshot(now: number) {
		return this.memory.getConcurrencySnapshot(now);
	}

	// === Durable scheduling (Tier 2 #5+#7 follow-up) ===
	// Tier 2 follow-up (migration v3) — PG mirror is now real durable
	// storage. Boot recovery (`HttpTrigger.recoverDispatches`) reads the
	// in-memory mirror, which is rehydrated from PG on init.

	upsertScheduledDispatch(row: Parameters<typeof this.memory.upsertScheduledDispatch>[0]): void {
		this.memory.upsertScheduledDispatch(row);
		// Tier C #2 — preserve claimed_by + claimed_at on conflict, same
		// invariant as sqlite. Re-upserts (debounce reset, queue re-defer)
		// MUST NOT release the claim or peers would re-claim the same row.
		this.enqueueWrite(() =>
			this.pool
				.query(
					`INSERT INTO scheduled_dispatches
					(run_id, workflow_name, trigger_type, scheduled_at, expires_at,
					 dispatch_status, payload_json, created_at)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
					ON CONFLICT (run_id) DO UPDATE SET
					 scheduled_at = EXCLUDED.scheduled_at,
					 expires_at = EXCLUDED.expires_at,
					 dispatch_status = EXCLUDED.dispatch_status,
					 payload_json = EXCLUDED.payload_json`,
					[
						row.runId,
						row.workflowName,
						row.triggerType,
						row.scheduledAt,
						row.expiresAt ?? null,
						row.dispatchStatus,
						JSON.stringify(row.payload ?? null),
						row.createdAt,
					],
				)
				.then(() => {}),
		);
	}

	// === Tier C #2 — cross-process scheduler coordination ===
	//
	// These methods bypass the in-memory mirror and hit PG directly —
	// claim atomicity REQUIRES the database to be the single source of
	// truth. The mirror is refreshed lazily as queries return.

	async claimDispatchesAsync(
		processId: string,
		leaseMs: number,
		now: number,
		opts?: { triggerType?: string },
	): Promise<ScheduledDispatchRow[]> {
		const triggerClause = opts?.triggerType ? "AND trigger_type = $4" : "";
		const args: (string | number)[] = [processId, now, leaseMs];
		if (opts?.triggerType) args.push(opts.triggerType);
		const sql = `
			UPDATE scheduled_dispatches
			SET claimed_by = $1, claimed_at = $2
			WHERE (claimed_by IS NULL OR claimed_at + $3 < $2) ${triggerClause}
			RETURNING *
		`;
		const { rows } = await this.pool.query(sql, args);
		const out: ScheduledDispatchRow[] = rows.map((r: Record<string, unknown>) => ({
			runId: r.run_id as string,
			workflowName: r.workflow_name as string,
			triggerType: r.trigger_type as string,
			scheduledAt: Number(r.scheduled_at),
			expiresAt: r.expires_at !== null && r.expires_at !== undefined ? Number(r.expires_at) : undefined,
			dispatchStatus: r.dispatch_status as ScheduledDispatchRow["dispatchStatus"],
			payload: typeof r.payload_json === "string" ? JSON.parse(r.payload_json as string) : r.payload_json,
			createdAt: Number(r.created_at),
			claimedBy: r.claimed_by !== null && r.claimed_by !== undefined ? (r.claimed_by as string) : undefined,
			claimedAt: r.claimed_at !== null && r.claimed_at !== undefined ? Number(r.claimed_at) : undefined,
		}));
		// Refresh the mirror so subsequent sync reads see the claim.
		for (const row of out) this.memory.upsertScheduledDispatch(row);
		out.sort((a, b) => a.scheduledAt - b.scheduledAt);
		return out;
	}

	/**
	 * Sync wrapper required by the `RunStore` interface. PG's claim API
	 * is fundamentally async (network round-trip); the sync wrapper
	 * returns the LAST snapshot from the in-memory mirror.
	 *
	 * **For cross-process correctness, callers MUST use
	 * `claimDispatchesAsync()` directly.** The sync wrapper exists so
	 * the interface contract is satisfied for sqlite + in-memory
	 * callers; PG users opt into the async path via the trigger's
	 * recovery code (`HttpTrigger.recoverDispatches()` calls the
	 * async version when the store is a `PostgresRunStore`).
	 */
	claimDispatches(
		processId: string,
		leaseMs: number,
		now: number,
		opts?: { triggerType?: string },
	): ScheduledDispatchRow[] {
		// Fire the async claim; return whatever the mirror has right now
		// (won't include rows claimed in this call until the async query
		// resolves and refreshes the mirror).
		void this.claimDispatchesAsync(processId, leaseMs, now, opts);
		return this.memory.claimDispatches(processId, leaseMs, now, opts);
	}

	heartbeatClaims(processId: string, now: number): number {
		const count = this.memory.heartbeatClaims(processId, now);
		this.enqueueWrite(() =>
			this.pool
				.query("UPDATE scheduled_dispatches SET claimed_at = $1 WHERE claimed_by = $2", [now, processId])
				.then(() => {}),
		);
		return count;
	}

	releaseClaim(runId: string): boolean {
		const removed = this.memory.releaseClaim(runId);
		this.enqueueWrite(() =>
			this.pool
				.query(
					"UPDATE scheduled_dispatches SET claimed_by = NULL, claimed_at = NULL WHERE run_id = $1 AND claimed_by IS NOT NULL",
					[runId],
				)
				.then(() => {}),
		);
		return removed;
	}

	deleteScheduledDispatch(runId: string): boolean {
		const removed = this.memory.deleteScheduledDispatch(runId);
		this.enqueueWrite(() =>
			this.pool.query("DELETE FROM scheduled_dispatches WHERE run_id = $1", [runId]).then(() => {}),
		);
		return removed;
	}

	getScheduledDispatches(opts?: { triggerType?: string; status?: string }) {
		return this.memory.getScheduledDispatches(opts);
	}

	purgeExpiredScheduledDispatches(now: number): number {
		const removed = this.memory.purgeExpiredScheduledDispatches(now);
		this.enqueueWrite(() =>
			this.pool
				.query("DELETE FROM scheduled_dispatches WHERE expires_at IS NOT NULL AND expires_at < $1", [now])
				.then(() => {}),
		);
		return removed;
	}

	// === Write Queue ===

	private enqueueWrite(fn: () => Promise<void>): void {
		if (this.closed) return;
		this.writeQueue.push(fn);
	}

	private async flush(): Promise<void> {
		if (this.flushing || this.writeQueue.length === 0) return;
		this.flushing = true;

		while (this.writeQueue.length > 0) {
			const batch = this.writeQueue.splice(0, 50);
			await Promise.allSettled(
				batch.map((fn) =>
					fn().catch((err) => {
						console.error("[PostgresRunStore] Write failed:", err.message);
					}),
				),
			);
		}

		this.flushing = false;
	}

	private startFlushLoop(): void {
		if (this.flushTimer) return;
		this.flushTimer = setInterval(() => {
			this.flush().catch(() => {});
		}, 100);
		// Ensure interval doesn't prevent process exit
		if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
			this.flushTimer.unref();
		}
	}

	private stopFlushLoop(): void {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
	}

	// === Row → Object Mappers ===

	private rowToRun(row: Record<string, unknown>): WorkflowRun {
		return {
			id: row.id as string,
			workflowName: row.workflow_name as string,
			workflowPath: row.workflow_path as string,
			triggerType: row.trigger_type as string,
			triggerSummary: row.trigger_summary as string,
			status: row.status as WorkflowRun["status"],
			startedAt: Number(row.started_at),
			finishedAt: row.finished_at != null ? Number(row.finished_at) : undefined,
			durationMs: row.duration_ms != null ? Number(row.duration_ms) : undefined,
			error: row.error_json ? (parseJson(row.error_json) as WorkflowRun["error"]) : undefined,
			tags: row.tags_json ? (parseJson(row.tags_json) as string[]) : undefined,
			metadata: row.metadata_json ? (parseJson(row.metadata_json) as Record<string, unknown>) : undefined,
			nodeCount: Number(row.node_count),
			completedNodes: Number(row.completed_nodes),
			// PR 1-5 polish · pre-v5 PG rows have NULL on the columns added
			// by migration v5. Mirror sqlite's `rowToRun`: NULL `environment`
			// reads as "production" (the legacy default scope) so historical
			// data still surfaces under the EnvChip default. Every other new
			// column maps NULL → undefined.
			environment: ((row.environment as string | null) ?? "production") as string,
			replayOf: (row.replay_of as string | null) ?? undefined,
			parentRunId: (row.parent_run_id as string | null) ?? undefined,
			parentNodeRunId: (row.parent_node_run_id as string | null) ?? undefined,
			scheduledAt: row.scheduled_at != null ? Number(row.scheduled_at) : undefined,
			expiresAt: row.expires_at != null ? Number(row.expires_at) : undefined,
			debounceKey: (row.debounce_key as string | null) ?? undefined,
			debounceMode: ((row.debounce_mode as string | null) ?? undefined) as "leading" | "trailing" | undefined,
			pingCount: row.ping_count != null ? Number(row.ping_count) : undefined,
			lastCompletedStepIndex: row.last_completed_step_index != null ? Number(row.last_completed_step_index) : undefined,
		};
	}

	private rowToNodeRun(row: Record<string, unknown>): NodeRun {
		const flags = (row.flags_json ? parseJson(row.flags_json) : undefined) as
			| {
					wait?: boolean;
					dispatch?: "in-process" | "http-self";
					subworkflowDepth?: number;
					middleware?: string;
					iterationIndex?: number;
			  }
			| undefined;
		return {
			id: row.id as string,
			runId: row.run_id as string,
			nodeName: row.node_name as string,
			nodeType: row.node_type as string,
			runtimeKind: (row.runtime_kind as string) ?? undefined,
			status: row.status as NodeRun["status"],
			startedAt: Number(row.started_at),
			finishedAt: row.finished_at != null ? Number(row.finished_at) : undefined,
			durationMs: row.duration_ms != null ? Number(row.duration_ms) : undefined,
			inputs: row.inputs_json ? parseJson(row.inputs_json) : undefined,
			outputs: row.outputs_json ? parseJson(row.outputs_json) : undefined,
			error: row.error_json ? (parseJson(row.error_json) as NodeRun["error"]) : undefined,
			parentNodeId: (row.parent_node_id as string) ?? undefined,
			depth: Number(row.depth),
			stepIndex: Number(row.step_index),
			metrics: row.metrics_json ? (parseJson(row.metrics_json) as NodeRun["metrics"]) : undefined,
			wait: flags?.wait,
			dispatch: flags?.dispatch,
			subworkflowDepth: flags?.subworkflowDepth,
			middleware: flags?.middleware,
			iterationIndex: flags?.iterationIndex,
		};
	}

	private rowToEvent(row: Record<string, unknown>): RunEvent {
		return {
			id: row.id as string,
			type: row.type as RunEvent["type"],
			runId: row.run_id as string,
			workflowName: row.workflow_name as string,
			timestamp: Number(row.timestamp),
			nodeName: (row.node_name as string) ?? undefined,
			nodeId: (row.node_id as string) ?? undefined,
			payload: row.payload_json ? parseJson(row.payload_json) : undefined,
		};
	}

	private rowToLog(row: Record<string, unknown>): TraceLogEntry {
		return {
			id: row.id as string,
			runId: row.run_id as string,
			nodeId: (row.node_id as string) ?? undefined,
			nodeName: (row.node_name as string) ?? undefined,
			level: row.level as TraceLogEntry["level"],
			message: row.message as string,
			timestamp: Number(row.timestamp),
			data: row.data_json ? (parseJson(row.data_json) as Record<string, unknown>) : undefined,
		};
	}

	private rowToDashboard(row: Record<string, unknown>): Dashboard {
		return {
			id: row.id as string,
			name: row.name as string,
			description: (row.description as string) ?? undefined,
			isDefault: row.is_default === true,
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
			widgets: row.widgets_json ? (parseJson(row.widgets_json) as Dashboard["widgets"]) : [],
		};
	}
}

/**
 * Parse JSON that may already be an object (pg driver auto-parses JSONB).
 */
function parseJson(value: unknown): unknown {
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	return value;
}

/**
 * Serialize the in-memory NodeRun flag bag for the `flags_json` JSONB
 * column. Mirrors `encodeNodeRunFlags` in SqliteRunStore. Returns null
 * when no flags are set so the column stays NULL on the common case.
 */
function encodeNodeRunFlagsForPg(nodeRun: NodeRun): string | null {
	const flags: Record<string, unknown> = {};
	if (nodeRun.wait !== undefined) flags.wait = nodeRun.wait;
	if (nodeRun.dispatch !== undefined) flags.dispatch = nodeRun.dispatch;
	if (nodeRun.subworkflowDepth !== undefined) flags.subworkflowDepth = nodeRun.subworkflowDepth;
	if (nodeRun.middleware !== undefined) flags.middleware = nodeRun.middleware;
	if (nodeRun.iterationIndex !== undefined) flags.iterationIndex = nodeRun.iterationIndex;
	if (Object.keys(flags).length === 0) return null;
	return JSON.stringify(flags);
}
