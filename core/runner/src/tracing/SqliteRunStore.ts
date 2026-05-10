import { createRequire } from "node:module";
import type { RunStore } from "./RunStore";

const esmRequire = createRequire(import.meta.url);
import type {
	CachedStepResult,
	ConcurrencySlotResult,
	Dashboard,
	MetricsResult,
	NodeRun,
	NodeRunStatus,
	RunEvent,
	RunEventType,
	RunQuery,
	ScheduledDispatchRow,
	TraceLogEntry,
	WorkflowRun,
	WorkflowRunStatus,
	WorkflowSummary,
} from "./types";

/**
 * Minimal interface covering the shared API surface of
 * better-sqlite3 and bun:sqlite Database instances.
 */
interface SqliteDatabase {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): unknown;
	transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
	close(): void;
}

interface SqliteStatement {
	run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all(...params: unknown[]): Record<string, unknown>[];
}

// Row types for SQLite query results
interface RunRow {
	id: string;
	workflow_name: string;
	workflow_path: string;
	trigger_type: string;
	trigger_summary: string;
	status: string;
	started_at: number;
	finished_at: number | null;
	duration_ms: number | null;
	error_json: string | null;
	tags_json: string | null;
	metadata_json: string | null;
	node_count: number;
	completed_nodes: number;
	/**
	 * Environment scope (Phase 2.1). NULL on rows from before the column
	 * was added — `rowToRun` defaults those to `"production"` so the
	 * legacy data still shows up under the default env scope.
	 */
	environment: string | null;
	/**
	 * Tier 1 replay lineage. NULL on first-class triggered runs; carries
	 * the source run id when started via `POST /__blok/runs/:id/replay`.
	 * Added in migration v5.
	 */
	replay_of: string | null;
	/**
	 * Tier 2 sub-workflow lineage. NULL on first-class triggered runs;
	 * carries the parent run's id when this run was started by a
	 * `subworkflow:` step. Added in migration v6.
	 */
	parent_run_id: string | null;
	/**
	 * Tier 2 sub-workflow lineage. The specific parent NodeRun that
	 * invoked this sub-workflow. Added in migration v6.
	 */
	parent_node_run_id: string | null;
	/**
	 * Tier 2 #5 · scheduled dispatch time (ms since epoch). NULL for
	 * immediate runs. Added in migration v8.
	 */
	scheduled_at: number | null;
	/**
	 * Tier 2 #5 · TTL deadline (ms since epoch). NULL when no TTL is
	 * configured. Added in migration v8.
	 */
	expires_at: number | null;
	/**
	 * Tier 2 #7 · resolved debounce key. NULL on non-debounced runs.
	 * Added in migration v8.
	 */
	debounce_key: string | null;
	/**
	 * Tier 2 #7 · debounce mode (`leading` | `trailing`). NULL on non-
	 * debounced runs. Added in migration v8.
	 */
	debounce_mode: string | null;
	/**
	 * Tier 2 #7 · pings absorbed by this run. NULL pre-Tier-2-#7;
	 * `1`+ on debounced runs. Added in migration v8.
	 */
	ping_count: number | null;
	/**
	 * PR 4 · wait.for / wait.until resume cursor. NULL = no wait
	 * encountered; `i` = runner finished step i and may resume at i+1
	 * after a wait dispatchDeferred re-entry. Added in migration v10.
	 */
	last_completed_step_index: number | null;
	/**
	 * v0.6 · JSON-serialized snapshot of `ctx.state` taken before the
	 * runner throws `WaitDispatchRequest`. Read on dispatchDeferred
	 * re-entry to rehydrate `ctx.state` so cross-process recovery
	 * (where ctx is rebuilt fresh) sees the same pre-wait state.
	 * NULL = no wait encountered, OR the snapshot exceeded the size
	 * cap and was skipped. Added in migration v11.
	 */
	state_snapshot: string | null;
	// Aggregate fields used in some queries
	trigger_types?: string;
	total_runs?: number;
	recent_runs?: number;
	last_run_at?: number;
	error_count?: number;
	avg_duration?: number;
}

interface NodeRunRow {
	id: string;
	run_id: string;
	node_name: string;
	node_type: string;
	runtime_kind: string | null;
	status: string;
	started_at: number;
	finished_at: number | null;
	duration_ms: number | null;
	inputs_json: string | null;
	outputs_json: string | null;
	error_json: string | null;
	parent_node_id: string | null;
	depth: number;
	step_index: number;
	metrics_json: string | null;
	/**
	 * JSON-serialized {@link NodeRun.cached} lineage. NULL on rows that did
	 * not short-circuit via the idempotency cache. Added in migration v4.
	 */
	cached_json: string | null;
	/**
	 * JSON-serialized {@link NodeRun.attempts} array. NULL when the node
	 * succeeded on first try (`maxAttempts: 1` default). Added in migration v5.
	 */
	attempts_json: string | null;
}

interface IdempotencyCacheRow {
	workflow_name: string;
	step_id: string;
	idempotency_key: string;
	data_json: string;
	cached_at: number;
	expires_at: number | null;
	source_run_id: string;
	source_node_run_id: string;
}

interface EventRow {
	id: string;
	type: string;
	run_id: string;
	workflow_name: string;
	timestamp: number;
	node_name: string | null;
	node_id: string | null;
	payload_json: string | null;
}

interface LogRow {
	id: string;
	run_id: string;
	node_id: string | null;
	node_name: string | null;
	level: string;
	message: string;
	timestamp: number;
	data_json: string | null;
}

interface DashboardRow {
	id: string;
	name: string;
	description: string | null;
	is_default: number;
	created_at: number;
	updated_at: number;
	widgets_json: string;
}

const isBun = "Bun" in globalThis;

/**
 * SQLite-backed RunStore supporting both bun:sqlite and better-sqlite3.
 *
 * When running under Bun, uses the built-in bun:sqlite module for
 * optimal performance. Falls back to better-sqlite3 under Node.js.
 *
 * Provides persistent trace storage that survives process restarts.
 * All operations are synchronous.
 *
 * Schema is auto-migrated on construction via a versioned migration system.
 */
export class SqliteRunStore implements RunStore {
	private db: SqliteDatabase;

	// Prepared statements (lazy-initialized)
	private stmts: Record<string, SqliteStatement> = {};

	constructor(dbPath = ".blok/trace.db") {
		if (isBun) {
			// Use Bun's built-in SQLite (3-6x faster than better-sqlite3)
			const bunMod = "bun:sqlite";
			const { Database } = esmRequire(bunMod);
			this.db = new Database(dbPath);
		} else {
			// Fallback to better-sqlite3 for Node.js
			let Database: new (path: string) => SqliteDatabase;
			try {
				const mod = "better-sqlite3";
				Database = esmRequire(mod);
			} catch {
				throw new Error(
					"SqliteRunStore requires 'better-sqlite3'. Install it:\n" +
						"  npm install better-sqlite3\n" +
						"  # or\n" +
						"  bun add better-sqlite3",
				);
			}
			this.db = new Database(dbPath);
		}

		// Use exec for pragmas — works in both bun:sqlite and better-sqlite3
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	// === Schema Migration ===

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS _trace_migrations (
				version INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`);

		const applied = new Set(
			this.db
				.prepare("SELECT version FROM _trace_migrations")
				.all()
				.map((r) => (r as { version: number }).version),
		);

		const migrations: Array<{ version: number; sql: string }> = [
			{
				version: 1,
				sql: `
					CREATE TABLE IF NOT EXISTS workflow_runs (
						id TEXT PRIMARY KEY,
						workflow_name TEXT NOT NULL,
						workflow_path TEXT NOT NULL,
						trigger_type TEXT NOT NULL,
						trigger_summary TEXT NOT NULL,
						status TEXT NOT NULL DEFAULT 'running',
						started_at INTEGER NOT NULL,
						finished_at INTEGER,
						duration_ms INTEGER,
						error_json TEXT,
						tags_json TEXT DEFAULT '[]',
						metadata_json TEXT,
						node_count INTEGER NOT NULL DEFAULT 0,
						completed_nodes INTEGER NOT NULL DEFAULT 0
					);

					CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs(workflow_name);
					CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status);
					CREATE INDEX IF NOT EXISTS idx_runs_started_at ON workflow_runs(started_at);

					CREATE TABLE IF NOT EXISTS node_runs (
						id TEXT PRIMARY KEY,
						run_id TEXT NOT NULL,
						node_name TEXT NOT NULL,
						node_type TEXT NOT NULL,
						runtime_kind TEXT,
						status TEXT NOT NULL DEFAULT 'running',
						started_at INTEGER NOT NULL,
						finished_at INTEGER,
						duration_ms INTEGER,
						inputs_json TEXT,
						outputs_json TEXT,
						error_json TEXT,
						parent_node_id TEXT,
						depth INTEGER NOT NULL DEFAULT 0,
						step_index INTEGER NOT NULL DEFAULT 0,
						metrics_json TEXT,
						FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
					);

					CREATE INDEX IF NOT EXISTS idx_nodes_run ON node_runs(run_id);

					CREATE TABLE IF NOT EXISTS run_events (
						id TEXT PRIMARY KEY,
						type TEXT NOT NULL,
						run_id TEXT NOT NULL,
						workflow_name TEXT NOT NULL,
						timestamp INTEGER NOT NULL,
						node_name TEXT,
						node_id TEXT,
						payload_json TEXT,
						FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
					);

					CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id);
					CREATE INDEX IF NOT EXISTS idx_events_timestamp ON run_events(timestamp);

					CREATE TABLE IF NOT EXISTS log_entries (
						id TEXT PRIMARY KEY,
						run_id TEXT NOT NULL,
						node_id TEXT,
						node_name TEXT,
						level TEXT NOT NULL,
						message TEXT NOT NULL,
						timestamp INTEGER NOT NULL,
						data_json TEXT,
						FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
					);

					CREATE INDEX IF NOT EXISTS idx_logs_run ON log_entries(run_id);
				`,
			},
			{
				version: 2,
				sql: `
					CREATE TABLE IF NOT EXISTS dashboards (
						id TEXT PRIMARY KEY,
						name TEXT NOT NULL,
						description TEXT,
						is_default INTEGER NOT NULL DEFAULT 0,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						widgets_json TEXT NOT NULL DEFAULT '[]'
					);
				`,
			},
			{
				// Phase 2.1 · environment scoping. Add `environment` to
				// workflow_runs so list views can filter by env. Existing
				// rows get NULL (which `rowToRun` reads as `production` —
				// see RunRow comment) so legacy data still appears under
				// the default scope without a backfill.
				version: 3,
				sql: `
					ALTER TABLE workflow_runs ADD COLUMN environment TEXT;
					CREATE INDEX IF NOT EXISTS idx_runs_environment ON workflow_runs(environment);
				`,
			},
			{
				// Tier 1 · idempotency caching. Adds:
				//  - `node_runs.cached_json` for cache-hit lineage on a node
				//    that short-circuited rather than ran.
				//  - `idempotency_cache` table for the cache backend keyed
				//    on (workflow_name, step_id, idempotency_key). Existing
				//    `node_runs` rows get NULL `cached_json` (a non-cached
				//    historical execution).
				version: 4,
				sql: `
					ALTER TABLE node_runs ADD COLUMN cached_json TEXT;

					CREATE TABLE IF NOT EXISTS idempotency_cache (
						workflow_name TEXT NOT NULL,
						step_id TEXT NOT NULL,
						idempotency_key TEXT NOT NULL,
						data_json TEXT NOT NULL,
						cached_at INTEGER NOT NULL,
						expires_at INTEGER,
						source_run_id TEXT NOT NULL,
						source_node_run_id TEXT NOT NULL,
						PRIMARY KEY (workflow_name, step_id, idempotency_key)
					);

					CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_cache(expires_at);
				`,
			},
			{
				// Tier 1 · retry loop + replay lineage. Adds:
				//  - `node_runs.attempts_json` for the per-attempt failure
				//    history before the node ultimately succeeded or was
				//    fail-noded (capped at MAX_STORED_ATTEMPTS by RunTracker).
				//  - `workflow_runs.replay_of` for the source run id when a
				//    run is started via `POST /__blok/runs/:id/replay`.
				// Existing rows: NULL on both → "no retries; not a replay".
				version: 5,
				sql: `
					ALTER TABLE node_runs ADD COLUMN attempts_json TEXT;
					ALTER TABLE workflow_runs ADD COLUMN replay_of TEXT;
					CREATE INDEX IF NOT EXISTS idx_runs_replay_of ON workflow_runs(replay_of);
				`,
			},
			{
				// Tier 2 · sub-workflow lineage. Adds parent/child run linkage:
				//  - `workflow_runs.parent_run_id` — the parent run that
				//    invoked this run via a `subworkflow:` step.
				//  - `workflow_runs.parent_node_run_id` — the specific
				//    NodeRun within the parent that was the sub-workflow
				//    step (lets Studio jump to the exact invocation site).
				// Index on parent_run_id for efficient `getRunsByParent` queries.
				// Existing rows: NULL on both → "first-class triggered run".
				version: 6,
				sql: `
					ALTER TABLE workflow_runs ADD COLUMN parent_run_id TEXT;
					ALTER TABLE workflow_runs ADD COLUMN parent_node_run_id TEXT;
					CREATE INDEX IF NOT EXISTS idx_runs_parent_run ON workflow_runs(parent_run_id);
				`,
			},
			{
				// Tier 2 #6 · concurrency keys. Adds a per-(workflow, key)
				// in-flight slot table. Composite PK on (workflow_name,
				// concurrency_key, run_id) lets a single run hold at most
				// one slot per bucket while still permitting the
				// `concurrencyLimit` runs to coexist within a bucket.
				// `expires_at` is the lease upper bound — covers
				// crash-safety when a process dies before releasing.
				version: 7,
				sql: `
					CREATE TABLE IF NOT EXISTS concurrency_locks (
						workflow_name TEXT NOT NULL,
						concurrency_key TEXT NOT NULL,
						run_id TEXT NOT NULL,
						acquired_at INTEGER NOT NULL,
						expires_at INTEGER NOT NULL,
						PRIMARY KEY (workflow_name, concurrency_key, run_id)
					);
					CREATE INDEX IF NOT EXISTS idx_locks_expires ON concurrency_locks(expires_at);
					CREATE INDEX IF NOT EXISTS idx_locks_workflow_key ON concurrency_locks(workflow_name, concurrency_key);
				`,
			},
			{
				// Tier 2 #5 + #7 · scheduling fields on workflow_runs:
				//  - `scheduled_at` — dispatch time (ms since epoch) for
				//    runs deferred via `trigger.delay`. NULL on immediate
				//    runs.
				//  - `expires_at` — TTL deadline (ms since epoch). When
				//    `now > expires_at` at dispatch time, the run is
				//    marked `expired` and skipped.
				//  - `debounce_key` — resolved key for runs that absorbed
				//    pings via `trigger.debounce`. NULL on non-debounced
				//    runs.
				//  - `debounce_mode` — `leading` | `trailing`.
				//  - `ping_count` — number of pings absorbed by this run.
				// Indexes:
				//  - `idx_runs_scheduled_at` for "list scheduled runs"
				//    queries (Studio surface).
				//  - `idx_runs_debounce_key` for the debounce coordinator's
				//    "is there an active run for this key?" lookup
				//    (in-memory map is the hot path; SQLite is the
				//    fallback / restart-recovery).
				// Existing rows: NULL on every new column. Backward-compat.
				version: 8,
				sql: `
					ALTER TABLE workflow_runs ADD COLUMN scheduled_at INTEGER;
					ALTER TABLE workflow_runs ADD COLUMN expires_at INTEGER;
					ALTER TABLE workflow_runs ADD COLUMN debounce_key TEXT;
					ALTER TABLE workflow_runs ADD COLUMN debounce_mode TEXT;
					ALTER TABLE workflow_runs ADD COLUMN ping_count INTEGER;
					CREATE INDEX IF NOT EXISTS idx_runs_scheduled_at ON workflow_runs(scheduled_at);
					CREATE INDEX IF NOT EXISTS idx_runs_debounce_key ON workflow_runs(workflow_name, debounce_key);
				`,
			},
			{
				// Tier 2 #5+#7 follow-up · durable scheduler.
				//
				// `scheduled_dispatches` persists the minimum payload needed
				// to re-fire a deferred dispatch after a process crash. The
				// `DeferredRunScheduler` writes a row when a dispatch is
				// scheduled, deletes it when the dispatch fires or is
				// cancelled. On boot, HttpTrigger.recoverDispatches scans
				// the table, marks past-due+TTL-expired rows as `expired`,
				// and re-registers timers for live dispatches.
				//
				// Workers don't need this — broker (BullMQ/NATS) already
				// owns delayed delivery.
				//
				// Columns:
				//  - `run_id` — PK, FK-style reference to `workflow_runs.id`.
				//  - `workflow_name` — used by trigger boot recovery to
				//    filter rows it owns (when multiple HTTP triggers
				//    share the same store).
				//  - `trigger_type` — `"http"` for v1; future triggers
				//    can opt in by writing this column.
				//  - `scheduled_at` — ms since epoch when to fire.
				//  - `expires_at` — TTL deadline (NULL = no TTL).
				//  - `dispatch_status` — `"delayed"` | `"queued"` |
				//    `"debounced"`. Mirrors the run record's status.
				//  - `payload_json` — JSON-serialized minimal Context
				//    subset (HTTP: method, path, headers, body, params,
				//    query, workflow_path). Headers are pre-stripped of
				//    sensitive keys (authorization, cookie, x-api-key).
				//  - `created_at` — when the row was first written.
				version: 9,
				sql: `
					CREATE TABLE IF NOT EXISTS scheduled_dispatches (
						run_id TEXT PRIMARY KEY,
						workflow_name TEXT NOT NULL,
						trigger_type TEXT NOT NULL,
						scheduled_at INTEGER NOT NULL,
						expires_at INTEGER,
						dispatch_status TEXT NOT NULL,
						payload_json TEXT NOT NULL,
						created_at INTEGER NOT NULL
					);
					CREATE INDEX IF NOT EXISTS idx_scheduled_dispatches_at ON scheduled_dispatches(scheduled_at);
					CREATE INDEX IF NOT EXISTS idx_scheduled_dispatches_trigger ON scheduled_dispatches(trigger_type, workflow_name);
				`,
			},
			{
				// PR 4 — wait.for(duration) / wait.until(date) step primitive.
				//
				// On dispatchDeferred re-entry, the runner needs to know which
				// steps already completed in the previous pass so it can skip
				// past them. last_completed_step_index is the canonical
				// resume cursor — runner increments after each non-wait
				// step, then on re-entry skips steps with
				// stepIndex <= last_completed_step_index. Default NULL (= no
				// resume cursor; runner starts at step 0 as today).
				version: 10,
				sql: `
					ALTER TABLE workflow_runs ADD COLUMN last_completed_step_index INTEGER;
				`,
			},
			{
				// v0.6 prerequisite for wait-inside-primitives Phase 2.
				//
				// state_snapshot is a JSON blob of `ctx.state` taken
				// immediately before RunnerSteps throws WaitDispatchRequest.
				// On dispatchDeferred re-entry — especially the cross-process
				// recovery path where a fresh ctx is rebuilt from the
				// persisted scheduled_dispatches row — TriggerBase.run reads
				// this column and rehydrates ctx.state so subsequent steps
				// see the same pre-wait state regardless of restart.
				//
				// Default NULL (= no snapshot; runner doesn't rehydrate,
				// preserving exact pre-v0.6 behaviour for runs that never
				// hit a wait).
				version: 11,
				sql: `
					ALTER TABLE workflow_runs ADD COLUMN state_snapshot TEXT;
				`,
			},
		];

		const applyMigration = this.db.transaction((m: { version: number; sql: string }) => {
			this.db.exec(m.sql);
			this.db.prepare("INSERT INTO _trace_migrations (version) VALUES (?)").run(m.version);
		});

		for (const m of migrations) {
			if (!applied.has(m.version)) {
				applyMigration(m);
			}
		}
	}

	// === Prepared Statement Helpers ===

	private stmt(key: string, sql: string): SqliteStatement {
		if (!this.stmts[key]) {
			this.stmts[key] = this.db.prepare(sql);
		}
		return this.stmts[key];
	}

	// === Writes ===

	saveRun(run: WorkflowRun): void {
		this.stmt(
			"saveRun",
			`
			INSERT OR REPLACE INTO workflow_runs
			(id, workflow_name, workflow_path, trigger_type, trigger_summary,
			 status, started_at, finished_at, duration_ms, error_json,
			 tags_json, metadata_json, node_count, completed_nodes, environment, replay_of,
			 parent_run_id, parent_node_run_id,
			 scheduled_at, expires_at, debounce_key, debounce_mode, ping_count,
			 last_completed_step_index, state_snapshot)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		).run(
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
			run.stateSnapshot ?? null,
		);
	}

	updateRun(runId: string, updates: Partial<WorkflowRun>): void {
		const setClauses: string[] = [];
		const values: unknown[] = [];

		if (updates.status !== undefined) {
			setClauses.push("status = ?");
			values.push(updates.status);
		}
		if (updates.finishedAt !== undefined) {
			setClauses.push("finished_at = ?");
			values.push(updates.finishedAt);
		}
		if (updates.durationMs !== undefined) {
			setClauses.push("duration_ms = ?");
			values.push(updates.durationMs);
		}
		if (updates.error !== undefined) {
			setClauses.push("error_json = ?");
			values.push(JSON.stringify(updates.error));
		}
		if (updates.tags !== undefined) {
			setClauses.push("tags_json = ?");
			values.push(JSON.stringify(updates.tags));
		}
		if (updates.completedNodes !== undefined) {
			setClauses.push("completed_nodes = ?");
			values.push(updates.completedNodes);
		}
		if (updates.metadata !== undefined) {
			setClauses.push("metadata_json = ?");
			values.push(JSON.stringify(updates.metadata));
		}
		if (updates.replayOf !== undefined) {
			setClauses.push("replay_of = ?");
			values.push(updates.replayOf);
		}
		if (updates.parentRunId !== undefined) {
			setClauses.push("parent_run_id = ?");
			values.push(updates.parentRunId);
		}
		if (updates.parentNodeRunId !== undefined) {
			setClauses.push("parent_node_run_id = ?");
			values.push(updates.parentNodeRunId);
		}
		if (updates.scheduledAt !== undefined) {
			setClauses.push("scheduled_at = ?");
			values.push(updates.scheduledAt);
		}
		if (updates.expiresAt !== undefined) {
			setClauses.push("expires_at = ?");
			values.push(updates.expiresAt);
		}
		if (updates.debounceKey !== undefined) {
			setClauses.push("debounce_key = ?");
			values.push(updates.debounceKey);
		}
		if (updates.debounceMode !== undefined) {
			setClauses.push("debounce_mode = ?");
			values.push(updates.debounceMode);
		}
		if (updates.pingCount !== undefined) {
			setClauses.push("ping_count = ?");
			values.push(updates.pingCount);
		}
		if (updates.lastCompletedStepIndex !== undefined) {
			setClauses.push("last_completed_step_index = ?");
			values.push(updates.lastCompletedStepIndex);
		}
		if (updates.stateSnapshot !== undefined) {
			setClauses.push("state_snapshot = ?");
			values.push(updates.stateSnapshot);
		}
		if (updates.startedAt !== undefined) {
			setClauses.push("started_at = ?");
			values.push(updates.startedAt);
		}

		if (setClauses.length === 0) return;

		values.push(runId);
		this.db.prepare(`UPDATE workflow_runs SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
	}

	saveNodeRun(nodeRun: NodeRun): void {
		this.stmt(
			"saveNodeRun",
			`
			INSERT OR REPLACE INTO node_runs
			(id, run_id, node_name, node_type, runtime_kind,
			 status, started_at, finished_at, duration_ms,
			 inputs_json, outputs_json, error_json,
			 parent_node_id, depth, step_index, metrics_json, cached_json, attempts_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		).run(
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
			nodeRun.cached ? JSON.stringify(nodeRun.cached) : null,
			nodeRun.attempts ? JSON.stringify(nodeRun.attempts) : null,
		);
	}

	updateNodeRun(nodeRunId: string, updates: Partial<NodeRun>): void {
		const setClauses: string[] = [];
		const values: unknown[] = [];

		if (updates.status !== undefined) {
			setClauses.push("status = ?");
			values.push(updates.status);
		}
		if (updates.finishedAt !== undefined) {
			setClauses.push("finished_at = ?");
			values.push(updates.finishedAt);
		}
		if (updates.durationMs !== undefined) {
			setClauses.push("duration_ms = ?");
			values.push(updates.durationMs);
		}
		if (updates.outputs !== undefined) {
			setClauses.push("outputs_json = ?");
			values.push(JSON.stringify(updates.outputs));
		}
		if (updates.error !== undefined) {
			setClauses.push("error_json = ?");
			values.push(JSON.stringify(updates.error));
		}
		if (updates.metrics !== undefined) {
			setClauses.push("metrics_json = ?");
			values.push(JSON.stringify(updates.metrics));
		}
		if (updates.cached !== undefined) {
			setClauses.push("cached_json = ?");
			values.push(JSON.stringify(updates.cached));
		}
		if (updates.attempts !== undefined) {
			setClauses.push("attempts_json = ?");
			values.push(JSON.stringify(updates.attempts));
		}

		if (setClauses.length === 0) return;

		values.push(nodeRunId);
		this.db.prepare(`UPDATE node_runs SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
	}

	saveEvent(event: RunEvent): void {
		this.stmt(
			"saveEvent",
			`
			INSERT INTO run_events (id, type, run_id, workflow_name, timestamp, node_name, node_id, payload_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`,
		).run(
			event.id,
			event.type,
			event.runId,
			event.workflowName,
			event.timestamp,
			event.nodeName ?? null,
			event.nodeId ?? null,
			event.payload !== undefined ? JSON.stringify(event.payload) : null,
		);
	}

	saveLog(entry: TraceLogEntry): void {
		this.stmt(
			"saveLog",
			`
			INSERT INTO log_entries (id, run_id, node_id, node_name, level, message, timestamp, data_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`,
		).run(
			entry.id,
			entry.runId,
			entry.nodeId ?? null,
			entry.nodeName ?? null,
			entry.level,
			entry.message,
			entry.timestamp,
			entry.data ? JSON.stringify(entry.data) : null,
		);
	}

	// === Reads ===

	getRun(runId: string): WorkflowRun | undefined {
		const row = this.stmt("getRun", "SELECT * FROM workflow_runs WHERE id = ?").get(runId) as RunRow | undefined;
		return row ? this.rowToRun(row) : undefined;
	}

	getRuns(opts?: RunQuery): { runs: WorkflowRun[]; total: number } {
		const conditions: string[] = [];
		const params: unknown[] = [];

		if (opts?.workflow) {
			conditions.push("workflow_name = ?");
			params.push(opts.workflow);
		}
		if (opts?.status) {
			conditions.push("status = ?");
			params.push(opts.status);
		}
		// Tier 2 quick-wins — metadata key=value filter via json_extract.
		// Multiple key=value pairs combine with AND semantics. Indexed scans
		// aren't possible against arbitrary JSON keys; sequential scan is
		// acceptable given the runs table has size cap via evictOldRuns.
		if (opts?.metadata) {
			const entries = Object.entries(opts.metadata);
			for (const [k, v] of entries) {
				// Use prefixed paths for safety: only allow keys matching
				// /^[a-zA-Z0-9_-]+$/ to prevent JSON path injection. Keys with
				// special characters silently skip filtering — caller can
				// always fall back to client-side filter for those.
				if (!/^[a-zA-Z0-9_-]+$/.test(k)) continue;
				conditions.push(`json_extract(metadata_json, '$.${k}') = ?`);
				params.push(v);
			}
		}
		const tags = opts?.tags;
		if (tags && tags.length > 0) {
			// For each tag, check that it exists in the JSON array
			for (const tag of tags) {
				conditions.push("json_each.value = ?");
				params.push(tag);
			}
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const sortDir = opts?.sort === "asc" ? "ASC" : "DESC";
		const limit = opts?.limit ?? 50;
		const offset = opts?.offset ?? 0;

		let countSql: string;
		let querySql: string;

		if (tags && tags.length > 0) {
			// Use json_each for tag filtering with GROUP BY + HAVING for AND semantics
			countSql = `
				SELECT COUNT(DISTINCT wr.id) as total
				FROM workflow_runs wr, json_each(wr.tags_json)
				${where}
			`;
			// For multiple tags, use HAVING to require all tags match
			if (tags.length > 1) {
				const tagConditions = conditions.filter((c) => c !== "json_each.value = ?");
				const tagParams = params.filter((_, i) => i < params.length - tags.length);

				const baseWhere = tagConditions.length > 0 ? `WHERE ${tagConditions.join(" AND ")}` : "";
				const tagPlaceholders = tags.map(() => "?").join(", ");

				countSql = `
					SELECT COUNT(*) as total FROM (
						SELECT wr.id
						FROM workflow_runs wr, json_each(wr.tags_json)
						${baseWhere} ${baseWhere ? "AND" : "WHERE"} json_each.value IN (${tagPlaceholders})
						GROUP BY wr.id
						HAVING COUNT(DISTINCT json_each.value) = ?
					)
				`;
				querySql = `
					SELECT wr.* FROM workflow_runs wr
					WHERE wr.id IN (
						SELECT wr2.id
						FROM workflow_runs wr2, json_each(wr2.tags_json)
						${baseWhere.replace(/wr\./g, "wr2.")} ${baseWhere ? "AND" : "WHERE"} json_each.value IN (${tagPlaceholders})
						GROUP BY wr2.id
						HAVING COUNT(DISTINCT json_each.value) = ?
					)
					ORDER BY wr.started_at ${sortDir}
					LIMIT ? OFFSET ?
				`;
				const allTagParams = [...tagParams, ...tags, tags.length];
				const total = (this.db.prepare(countSql).get(...allTagParams) as { total: number } | undefined)?.total ?? 0;
				const rows = this.db.prepare(querySql).all(...allTagParams, limit, offset) as unknown as RunRow[];
				return { runs: rows.map((r) => this.rowToRun(r)), total };
			}

			querySql = `
				SELECT DISTINCT wr.*
				FROM workflow_runs wr, json_each(wr.tags_json)
				${where}
				ORDER BY wr.started_at ${sortDir}
				LIMIT ? OFFSET ?
			`;
		} else {
			countSql = `SELECT COUNT(*) as total FROM workflow_runs ${where}`;
			querySql = `SELECT * FROM workflow_runs ${where} ORDER BY started_at ${sortDir} LIMIT ? OFFSET ?`;
		}

		const total = (this.db.prepare(countSql).get(...params) as { total: number } | undefined)?.total ?? 0;
		const rows = this.db.prepare(querySql).all(...params, limit, offset) as unknown as RunRow[];
		return { runs: rows.map((r) => this.rowToRun(r)), total };
	}

	getNodeRuns(runId: string): NodeRun[] {
		const rows = this.stmt("getNodeRuns", "SELECT * FROM node_runs WHERE run_id = ? ORDER BY step_index").all(
			runId,
		) as unknown as NodeRunRow[];
		return rows.map((r) => this.rowToNodeRun(r));
	}

	getNodeRun(nodeRunId: string): NodeRun | undefined {
		const row = this.stmt("getNodeRun", "SELECT * FROM node_runs WHERE id = ?").get(nodeRunId) as
			| NodeRunRow
			| undefined;
		return row ? this.rowToNodeRun(row) : undefined;
	}

	getRunsByParent(parentRunId: string): WorkflowRun[] {
		const rows = this.stmt(
			"getRunsByParent",
			"SELECT * FROM workflow_runs WHERE parent_run_id = ? ORDER BY started_at ASC",
		).all(parentRunId) as unknown as RunRow[];
		return rows.map((r) => this.rowToRun(r));
	}

	getEvents(runId: string, since?: number): RunEvent[] {
		if (since) {
			return (
				this.stmt(
					"getEventsSince",
					"SELECT * FROM run_events WHERE run_id = ? AND timestamp > ? ORDER BY timestamp",
				).all(runId, since) as unknown as EventRow[]
			).map((r) => this.rowToEvent(r));
		}
		return (
			this.stmt("getEvents", "SELECT * FROM run_events WHERE run_id = ? ORDER BY timestamp").all(
				runId,
			) as unknown as EventRow[]
		).map((r) => this.rowToEvent(r));
	}

	getLogs(runId: string, nodeId?: string): TraceLogEntry[] {
		if (nodeId) {
			return (
				this.stmt("getLogsNode", "SELECT * FROM log_entries WHERE run_id = ? AND node_id = ? ORDER BY timestamp").all(
					runId,
					nodeId,
				) as unknown as LogRow[]
			).map((r) => this.rowToLog(r));
		}
		return (
			this.stmt("getLogs", "SELECT * FROM log_entries WHERE run_id = ? ORDER BY timestamp").all(
				runId,
			) as unknown as LogRow[]
		).map((r) => this.rowToLog(r));
	}

	// === Aggregations ===

	getWorkflowSummaries(): WorkflowSummary[] {
		const rows = this.db
			.prepare(`
			SELECT
				workflow_name,
				workflow_path,
				COUNT(*) as total_runs,
				SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) as recent_runs,
				MAX(started_at) as last_run_at,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as error_count,
				AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avg_duration,
				GROUP_CONCAT(DISTINCT trigger_type) as trigger_types
			FROM workflow_runs
			GROUP BY workflow_name
		`)
			.all(Date.now() - 24 * 60 * 60 * 1000) as unknown as RunRow[];

		return rows.map((r) => {
			// Get last run status
			const lastRun = this.db
				.prepare("SELECT status FROM workflow_runs WHERE workflow_name = ? ORDER BY started_at DESC LIMIT 1")
				.get(r.workflow_name) as { status: string } | undefined;

			// Get p95 duration
			const durations = this.db
				.prepare(
					"SELECT duration_ms FROM workflow_runs WHERE workflow_name = ? AND duration_ms IS NOT NULL ORDER BY duration_ms",
				)
				.all(r.workflow_name) as unknown as { duration_ms: number }[];

			const p95Index = Math.floor(durations.length * 0.95);
			const p95 = durations.length > 0 ? (durations[Math.min(p95Index, durations.length - 1)]?.duration_ms ?? 0) : 0;

			return {
				name: r.workflow_name,
				path: r.workflow_path,
				triggerTypes: r.trigger_types ? r.trigger_types.split(",") : [],
				totalRuns: r.total_runs ?? 0,
				recentRuns: r.recent_runs ?? 0,
				lastRunAt: r.last_run_at ?? undefined,
				lastRunStatus: lastRun?.status as WorkflowRunStatus | undefined,
				errorRate: (r.total_runs ?? 0) > 0 ? (r.error_count ?? 0) / (r.total_runs ?? 1) : 0,
				avgDurationMs: r.avg_duration ?? 0,
				p95DurationMs: p95,
			};
		});
	}

	getAllTags(): string[] {
		const rows = this.db
			.prepare(`
			SELECT DISTINCT value as tag
			FROM workflow_runs, json_each(workflow_runs.tags_json)
			ORDER BY value
		`)
			.all() as unknown as { tag: string }[];
		return rows.map((r) => r.tag);
	}

	getActiveRunCount(): number {
		const row = this.db.prepare("SELECT COUNT(*) as count FROM workflow_runs WHERE status = 'running'").get() as
			| { count: number }
			| undefined;
		return row?.count ?? 0;
	}

	getMetrics(workflow?: string): MetricsResult {
		const where = workflow ? "WHERE workflow_name = ?" : "";
		const params = workflow ? [workflow] : [];

		// Basic stats
		const stats = this.db
			.prepare(`
			SELECT
				COUNT(*) as total_runs,
				SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_runs,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_runs,
				AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avg_duration
			FROM workflow_runs ${where}
		`)
			.get(...params) as
			| { total_runs: number; completed_runs: number; failed_runs: number; avg_duration: number }
			| undefined;

		// Percentiles
		const durations = this.db
			.prepare(
				`SELECT duration_ms FROM workflow_runs ${where} ${where ? "AND" : "WHERE"} duration_ms IS NOT NULL ORDER BY duration_ms`,
			)
			.all(...params) as unknown as { duration_ms: number }[];

		const durationValues = durations.map((d) => d.duration_ms);

		const percentile = (arr: number[], p: number) => {
			if (arr.length === 0) return 0;
			const idx = Math.floor(arr.length * p);
			return arr[Math.min(idx, arr.length - 1)];
		};

		// Execution timeline — hourly buckets for last 24h
		const now = Date.now();
		const bucketSize = 60 * 60 * 1000;
		const bucketCount = 24;
		const executionTimeline: MetricsResult["executionTimeline"] = [];

		for (let i = bucketCount - 1; i >= 0; i--) {
			const bucketStart = now - (i + 1) * bucketSize;
			const bucketEnd = now - i * bucketSize;

			const bucketStats = this.db
				.prepare(`
				SELECT
					COUNT(*) as total,
					SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
					SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
				FROM workflow_runs
				${where} ${where ? "AND" : "WHERE"} started_at >= ? AND started_at < ?
			`)
				.get(...params, bucketStart, bucketEnd) as { total: number; completed: number; failed: number } | undefined;

			executionTimeline.push({
				bucket: new Date(bucketStart).toISOString(),
				total: bucketStats?.total ?? 0,
				completed: bucketStats?.completed ?? 0,
				failed: bucketStats?.failed ?? 0,
			});
		}

		// Duration distribution
		const ranges = [
			{ range: "0-10ms", min: 0, max: 10 },
			{ range: "10-50ms", min: 10, max: 50 },
			{ range: "50-100ms", min: 50, max: 100 },
			{ range: "100-500ms", min: 100, max: 500 },
			{ range: "500ms-1s", min: 500, max: 1000 },
			{ range: "1-5s", min: 1000, max: 5000 },
			{ range: "5s+", min: 5000, max: Number.POSITIVE_INFINITY },
		];
		const durationDistribution = ranges.map(({ range, min, max }) => ({
			range,
			count: durationValues.filter((d) => d >= min && d < max).length,
		}));

		// Workflow breakdown
		const wfRows = this.db
			.prepare(`
			SELECT
				workflow_name as name,
				COUNT(*) as total_runs,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
				AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avg_duration
			FROM workflow_runs ${where}
			GROUP BY workflow_name
		`)
			.all(...params) as unknown as { name: string; total_runs: number; failed: number; avg_duration: number }[];

		const workflowBreakdown = wfRows.map((r) => ({
			name: r.name,
			totalRuns: r.total_runs,
			errorRate: r.total_runs > 0 ? r.failed / r.total_runs : 0,
			avgDurationMs: r.avg_duration ?? 0,
		}));

		// Node performance
		const runIdWhere = workflow ? "WHERE nr.run_id IN (SELECT id FROM workflow_runs WHERE workflow_name = ?)" : "";
		const nodeRows = this.db
			.prepare(`
			SELECT
				nr.node_name,
				COUNT(*) as total,
				SUM(CASE WHEN nr.status = 'failed' THEN 1 ELSE 0 END) as failed,
				AVG(CASE WHEN nr.duration_ms IS NOT NULL THEN nr.duration_ms END) as avg_duration,
				MAX(CASE WHEN nr.duration_ms IS NOT NULL THEN nr.duration_ms END) as max_duration
			FROM node_runs nr
			${runIdWhere}
			GROUP BY nr.node_name
		`)
			.all(...params) as unknown as {
			node_name: string;
			total: number;
			failed: number;
			avg_duration: number;
			max_duration: number;
		}[];

		const nodePerformance = nodeRows.map((r) => ({
			nodeName: r.node_name,
			avgDurationMs: r.avg_duration ?? 0,
			maxDurationMs: r.max_duration ?? 0,
			errorRate: r.total > 0 ? r.failed / r.total : 0,
			executionCount: r.total,
		}));

		return {
			totalRuns: stats?.total_runs ?? 0,
			completedRuns: stats?.completed_runs ?? 0,
			failedRuns: stats?.failed_runs ?? 0,
			avgDurationMs: stats?.avg_duration ?? 0,
			p50DurationMs: percentile(durationValues, 0.5),
			p95DurationMs: percentile(durationValues, 0.95),
			p99DurationMs: percentile(durationValues, 0.99),
			executionTimeline,
			durationDistribution,
			workflowBreakdown,
			nodePerformance,
		};
	}

	// === Dashboards ===

	saveDashboard(dashboard: Dashboard): void {
		this.stmt(
			"saveDashboard",
			`
			INSERT OR REPLACE INTO dashboards
			(id, name, description, is_default, created_at, updated_at, widgets_json)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`,
		).run(
			dashboard.id,
			dashboard.name,
			dashboard.description ?? null,
			dashboard.isDefault ? 1 : 0,
			dashboard.createdAt,
			dashboard.updatedAt,
			JSON.stringify(dashboard.widgets),
		);
	}

	getDashboard(dashboardId: string): Dashboard | undefined {
		const row = this.stmt("getDashboard", "SELECT * FROM dashboards WHERE id = ?").get(dashboardId) as
			| DashboardRow
			| undefined;
		return row ? this.rowToDashboard(row) : undefined;
	}

	listDashboards(): Dashboard[] {
		const rows = this.db
			.prepare("SELECT * FROM dashboards ORDER BY updated_at DESC")
			.all() as unknown as DashboardRow[];
		return rows.map((r) => this.rowToDashboard(r));
	}

	deleteDashboard(dashboardId: string): boolean {
		const result = this.stmt("deleteDashboard", "DELETE FROM dashboards WHERE id = ?").run(dashboardId);
		return result.changes > 0;
	}

	updateDashboard(dashboardId: string, updates: Partial<Dashboard>): void {
		const setClauses: string[] = ["updated_at = ?"];
		const values: unknown[] = [Date.now()];

		if (updates.name !== undefined) {
			setClauses.push("name = ?");
			values.push(updates.name);
		}
		if (updates.description !== undefined) {
			setClauses.push("description = ?");
			values.push(updates.description);
		}
		if (updates.isDefault !== undefined) {
			setClauses.push("is_default = ?");
			values.push(updates.isDefault ? 1 : 0);
		}
		if (updates.widgets !== undefined) {
			setClauses.push("widgets_json = ?");
			values.push(JSON.stringify(updates.widgets));
		}

		values.push(dashboardId);
		this.db.prepare(`UPDATE dashboards SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
	}

	// === Cleanup ===

	clearAll(): number {
		const count =
			(this.db.prepare("SELECT COUNT(*) as c FROM workflow_runs").get() as { c: number } | undefined)?.c ?? 0;
		this.db.exec("DELETE FROM log_entries");
		this.db.exec("DELETE FROM run_events");
		this.db.exec("DELETE FROM node_runs");
		this.db.exec("DELETE FROM workflow_runs");
		this.db.exec("DELETE FROM dashboards");
		this.db.exec("DELETE FROM idempotency_cache");
		this.db.exec("DELETE FROM concurrency_locks");
		return count;
	}

	// === Idempotency cache ===

	getIdempotencyCache(workflowName: string, stepId: string, key: string): CachedStepResult | null {
		const row = this.stmt(
			"getIdempotencyCache",
			"SELECT * FROM idempotency_cache WHERE workflow_name = ? AND step_id = ? AND idempotency_key = ?",
		).get(workflowName, stepId, key) as IdempotencyCacheRow | undefined;
		if (!row) return null;
		if (row.expires_at !== null && row.expires_at <= Date.now()) {
			// Lazy purge — remove the expired entry inline so subsequent
			// reads don't even pay for the row materialization.
			this.stmt(
				"deleteExpiredIdempotency",
				"DELETE FROM idempotency_cache WHERE workflow_name = ? AND step_id = ? AND idempotency_key = ?",
			).run(workflowName, stepId, key);
			return null;
		}
		return {
			data: JSON.parse(row.data_json),
			cachedAt: row.cached_at,
			expiresAt: row.expires_at,
			sourceRunId: row.source_run_id,
			sourceNodeRunId: row.source_node_run_id,
		};
	}

	setIdempotencyCache(workflowName: string, stepId: string, key: string, entry: CachedStepResult): void {
		this.stmt(
			"setIdempotencyCache",
			`
			INSERT OR REPLACE INTO idempotency_cache
			(workflow_name, step_id, idempotency_key, data_json, cached_at, expires_at,
			 source_run_id, source_node_run_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`,
		).run(
			workflowName,
			stepId,
			key,
			JSON.stringify(entry.data),
			entry.cachedAt,
			entry.expiresAt,
			entry.sourceRunId,
			entry.sourceNodeRunId,
		);
	}

	purgeExpiredIdempotencyCache(now: number): number {
		const result = this.stmt(
			"purgeExpiredIdempotency",
			"DELETE FROM idempotency_cache WHERE expires_at IS NOT NULL AND expires_at <= ?",
		).run(now);
		return result.changes;
	}

	// === Concurrency gating (Tier 2 #6) ===

	acquireConcurrencySlot(
		workflowName: string,
		concurrencyKey: string,
		concurrencyLimit: number,
		runId: string,
		leaseExpiresAt: number,
	): ConcurrencySlotResult {
		// Wrap the read-modify-write in a transaction so two concurrent
		// `acquireConcurrencySlot` calls can't both see N < limit and
		// both grant a slot. better-sqlite3 / bun:sqlite serialize within
		// a single connection; the transaction is the safety net for any
		// future multi-connection setup.
		const txn = this.db.transaction((): ConcurrencySlotResult => {
			const now = Date.now();

			// Lazy-purge expired leases for THIS bucket so we don't deny
			// based on a slot held by a process that crashed mid-run.
			this.stmt(
				"deleteExpiredLocksForBucket",
				"DELETE FROM concurrency_locks WHERE workflow_name = ? AND concurrency_key = ? AND expires_at <= ?",
			).run(workflowName, concurrencyKey, now);

			// Idempotent re-acquire — if the same runId already holds a
			// slot, refresh its lease (UPSERT on PK) and report success
			// without growing the count.
			const existing = this.stmt(
				"getLockForRun",
				"SELECT 1 FROM concurrency_locks WHERE workflow_name = ? AND concurrency_key = ? AND run_id = ?",
			).get(workflowName, concurrencyKey, runId) as { 1: number } | undefined;

			if (existing) {
				this.stmt(
					"refreshLockLease",
					"UPDATE concurrency_locks SET expires_at = ? WHERE workflow_name = ? AND concurrency_key = ? AND run_id = ?",
				).run(leaseExpiresAt, workflowName, concurrencyKey, runId);
				const count =
					(
						this.stmt(
							"countLocksForBucket",
							"SELECT COUNT(*) as c FROM concurrency_locks WHERE workflow_name = ? AND concurrency_key = ?",
						).get(workflowName, concurrencyKey) as { c: number } | undefined
					)?.c ?? 0;
				return { acquired: true, currentInFlight: count };
			}

			const currentCount =
				(
					this.stmt(
						"countLocksForBucket",
						"SELECT COUNT(*) as c FROM concurrency_locks WHERE workflow_name = ? AND concurrency_key = ?",
					).get(workflowName, concurrencyKey) as { c: number } | undefined
				)?.c ?? 0;

			if (currentCount >= concurrencyLimit) {
				return { acquired: false, currentInFlight: currentCount };
			}

			this.stmt(
				"insertLock",
				`INSERT INTO concurrency_locks
				(workflow_name, concurrency_key, run_id, acquired_at, expires_at)
				VALUES (?, ?, ?, ?, ?)`,
			).run(workflowName, concurrencyKey, runId, now, leaseExpiresAt);

			return { acquired: true, currentInFlight: currentCount + 1 };
		});

		return txn();
	}

	releaseConcurrencySlot(workflowName: string, concurrencyKey: string, runId: string): void {
		this.stmt(
			"releaseLock",
			"DELETE FROM concurrency_locks WHERE workflow_name = ? AND concurrency_key = ? AND run_id = ?",
		).run(workflowName, concurrencyKey, runId);
	}

	purgeExpiredConcurrencySlots(now: number): number {
		const result = this.stmt("purgeExpiredLocks", "DELETE FROM concurrency_locks WHERE expires_at <= ?").run(now);
		return result.changes;
	}

	getConcurrencySnapshot(now: number): Array<{
		workflowName: string;
		concurrencyKey: string;
		leases: Array<{ runId: string; expiresAt: number }>;
	}> {
		const rows = this.db
			.prepare("SELECT workflow_name, concurrency_key, run_id, expires_at FROM concurrency_locks WHERE expires_at > ?")
			.all(now) as Array<{
			workflow_name: string;
			concurrency_key: string;
			run_id: string;
			expires_at: number;
		}>;
		const buckets = new Map<
			string,
			{ workflowName: string; concurrencyKey: string; leases: Array<{ runId: string; expiresAt: number }> }
		>();
		for (const r of rows) {
			const key = `${r.workflow_name}\x1f${r.concurrency_key}`;
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = { workflowName: r.workflow_name, concurrencyKey: r.concurrency_key, leases: [] };
				buckets.set(key, bucket);
			}
			bucket.leases.push({ runId: r.run_id, expiresAt: r.expires_at });
		}
		return Array.from(buckets.values());
	}

	// === Durable scheduling (Tier 2 #5+#7 follow-up) ===

	upsertScheduledDispatch(row: ScheduledDispatchRow): void {
		this.stmt(
			"upsertScheduledDispatch",
			`INSERT INTO scheduled_dispatches
				(run_id, workflow_name, trigger_type, scheduled_at, expires_at, dispatch_status, payload_json, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(run_id) DO UPDATE SET
				scheduled_at = excluded.scheduled_at,
				expires_at = excluded.expires_at,
				dispatch_status = excluded.dispatch_status,
				payload_json = excluded.payload_json`,
		).run(
			row.runId,
			row.workflowName,
			row.triggerType,
			row.scheduledAt,
			row.expiresAt ?? null,
			row.dispatchStatus,
			JSON.stringify(row.payload ?? null),
			row.createdAt,
		);
	}

	deleteScheduledDispatch(runId: string): boolean {
		const result = this.stmt("deleteScheduledDispatch", "DELETE FROM scheduled_dispatches WHERE run_id = ?").run(runId);
		return result.changes > 0;
	}

	getScheduledDispatches(opts?: { triggerType?: string; status?: string }): ScheduledDispatchRow[] {
		const triggerType = opts?.triggerType;
		const status = opts?.status;
		const clauses: string[] = [];
		const args: (string | number)[] = [];
		if (triggerType) {
			clauses.push("trigger_type = ?");
			args.push(triggerType);
		}
		if (status) {
			clauses.push("dispatch_status = ?");
			args.push(status);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const sql = `SELECT * FROM scheduled_dispatches ${where} ORDER BY scheduled_at ASC`;
		const rows = this.db.prepare(sql).all(...args) as Array<{
			run_id: string;
			workflow_name: string;
			trigger_type: string;
			scheduled_at: number;
			expires_at: number | null;
			dispatch_status: string;
			payload_json: string;
			created_at: number;
		}>;
		return rows.map((r) => {
			let parsedPayload: unknown = null;
			try {
				parsedPayload = JSON.parse(r.payload_json);
			} catch {
				parsedPayload = null;
			}
			return {
				runId: r.run_id,
				workflowName: r.workflow_name,
				triggerType: r.trigger_type,
				scheduledAt: r.scheduled_at,
				expiresAt: r.expires_at ?? undefined,
				dispatchStatus: r.dispatch_status as ScheduledDispatchRow["dispatchStatus"],
				payload: parsedPayload,
				createdAt: r.created_at,
			};
		});
	}

	purgeExpiredScheduledDispatches(now: number): number {
		const result = this.stmt(
			"purgeExpiredScheduledDispatches",
			"DELETE FROM scheduled_dispatches WHERE expires_at IS NOT NULL AND expires_at < ?",
		).run(now);
		return result.changes;
	}

	deleteRunsBefore(timestamp: number): number {
		// Foreign key CASCADE handles child tables
		const result = this.db
			.prepare("DELETE FROM workflow_runs WHERE started_at < ? AND status != 'running'")
			.run(timestamp);
		return result.changes;
	}

	evictOldRuns(maxRuns: number): void {
		const count =
			(this.db.prepare("SELECT COUNT(*) as c FROM workflow_runs").get() as { c: number } | undefined)?.c ?? 0;
		if (count <= maxRuns) return;

		const toRemove = count - maxRuns;
		this.db
			.prepare(`
			DELETE FROM workflow_runs WHERE id IN (
				SELECT id FROM workflow_runs
				WHERE status != 'running'
				ORDER BY started_at ASC
				LIMIT ?
			)
		`)
			.run(toRemove);
	}

	close(): void {
		this.stmts = {};
		this.db.close();
	}

	// === Row → Object Mappers ===

	private rowToRun(row: RunRow): WorkflowRun {
		return {
			id: row.id,
			workflowName: row.workflow_name,
			workflowPath: row.workflow_path,
			triggerType: row.trigger_type,
			triggerSummary: row.trigger_summary,
			status: row.status as WorkflowRunStatus,
			startedAt: row.started_at,
			finishedAt: row.finished_at ?? undefined,
			durationMs: row.duration_ms ?? undefined,
			error: row.error_json ? JSON.parse(row.error_json) : undefined,
			tags: row.tags_json ? JSON.parse(row.tags_json) : undefined,
			metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
			nodeCount: row.node_count,
			completedNodes: row.completed_nodes,
			// Pre-Phase-2.1 rows have NULL `environment` — present them as
			// "production" so the EnvChip default-scope still surfaces
			// historical data without a backfill.
			environment: row.environment ?? "production",
			replayOf: row.replay_of ?? undefined,
			parentRunId: row.parent_run_id ?? undefined,
			parentNodeRunId: row.parent_node_run_id ?? undefined,
			scheduledAt: row.scheduled_at ?? undefined,
			expiresAt: row.expires_at ?? undefined,
			debounceKey: row.debounce_key ?? undefined,
			debounceMode: (row.debounce_mode ?? undefined) as "leading" | "trailing" | undefined,
			pingCount: row.ping_count ?? undefined,
			lastCompletedStepIndex: row.last_completed_step_index ?? undefined,
			stateSnapshot: row.state_snapshot ?? undefined,
		};
	}

	private rowToNodeRun(row: NodeRunRow): NodeRun {
		return {
			id: row.id,
			runId: row.run_id,
			nodeName: row.node_name,
			nodeType: row.node_type,
			runtimeKind: row.runtime_kind ?? undefined,
			status: row.status as NodeRunStatus,
			startedAt: row.started_at,
			finishedAt: row.finished_at ?? undefined,
			durationMs: row.duration_ms ?? undefined,
			inputs: row.inputs_json ? JSON.parse(row.inputs_json) : undefined,
			outputs: row.outputs_json ? JSON.parse(row.outputs_json) : undefined,
			error: row.error_json ? JSON.parse(row.error_json) : undefined,
			parentNodeId: row.parent_node_id ?? undefined,
			depth: row.depth,
			stepIndex: row.step_index,
			metrics: row.metrics_json ? JSON.parse(row.metrics_json) : undefined,
			cached: row.cached_json ? (JSON.parse(row.cached_json) as NodeRun["cached"]) : undefined,
			attempts: row.attempts_json ? (JSON.parse(row.attempts_json) as NodeRun["attempts"]) : undefined,
		};
	}

	private rowToEvent(row: EventRow): RunEvent {
		return {
			id: row.id,
			type: row.type as RunEventType,
			runId: row.run_id,
			workflowName: row.workflow_name,
			timestamp: row.timestamp,
			nodeName: row.node_name ?? undefined,
			nodeId: row.node_id ?? undefined,
			payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
		};
	}

	private rowToLog(row: LogRow): TraceLogEntry {
		return {
			id: row.id,
			runId: row.run_id,
			nodeId: row.node_id ?? undefined,
			nodeName: row.node_name ?? undefined,
			level: row.level as TraceLogEntry["level"],
			message: row.message,
			timestamp: row.timestamp,
			data: row.data_json ? JSON.parse(row.data_json) : undefined,
		};
	}

	private rowToDashboard(row: DashboardRow): Dashboard {
		return {
			id: row.id,
			name: row.name,
			description: row.description ?? undefined,
			isDefault: row.is_default === 1,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			widgets: row.widgets_json ? JSON.parse(row.widgets_json) : [],
		};
	}
}
