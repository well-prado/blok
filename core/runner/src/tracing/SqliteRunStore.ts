import type { RunStore } from "./RunStore";
import type {
	Dashboard,
	MetricsResult,
	NodeRun,
	RunEvent,
	RunQuery,
	TraceLogEntry,
	WorkflowRun,
	WorkflowRunStatus,
	WorkflowSummary,
} from "./types";

/**
 * SQLite-backed RunStore using better-sqlite3.
 *
 * Provides persistent trace storage that survives process restarts.
 * All operations are synchronous (better-sqlite3 is synchronous).
 *
 * Schema is auto-migrated on construction via a versioned migration system.
 */
export class SqliteRunStore implements RunStore {
	private db: import("better-sqlite3").Database;

	// Prepared statements (lazy-initialized)
	private stmts: Record<string, import("better-sqlite3").Statement> = {};

	constructor(dbPath: string = ".blok/trace.db") {
		let Database: typeof import("better-sqlite3");
		try {
			const mod = "better-sqlite3";
			Database = require(mod);
		} catch {
			throw new Error(
				"SqliteRunStore requires 'better-sqlite3'. Install it:\n" +
				"  npm install better-sqlite3\n" +
				"  # or\n" +
				"  pnpm add better-sqlite3",
			);
		}

		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("synchronous = NORMAL");
		this.db.pragma("foreign_keys = ON");
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
			this.db.prepare("SELECT version FROM _trace_migrations").all().map((r: any) => r.version),
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

	private stmt(key: string, sql: string): import("better-sqlite3").Statement {
		if (!this.stmts[key]) {
			this.stmts[key] = this.db.prepare(sql);
		}
		return this.stmts[key];
	}

	// === Writes ===

	saveRun(run: WorkflowRun): void {
		this.stmt("saveRun", `
			INSERT OR REPLACE INTO workflow_runs
			(id, workflow_name, workflow_path, trigger_type, trigger_summary,
			 status, started_at, finished_at, duration_ms, error_json,
			 tags_json, metadata_json, node_count, completed_nodes)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
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
		);
	}

	updateRun(runId: string, updates: Partial<WorkflowRun>): void {
		const setClauses: string[] = [];
		const values: unknown[] = [];

		if (updates.status !== undefined) { setClauses.push("status = ?"); values.push(updates.status); }
		if (updates.finishedAt !== undefined) { setClauses.push("finished_at = ?"); values.push(updates.finishedAt); }
		if (updates.durationMs !== undefined) { setClauses.push("duration_ms = ?"); values.push(updates.durationMs); }
		if (updates.error !== undefined) { setClauses.push("error_json = ?"); values.push(JSON.stringify(updates.error)); }
		if (updates.tags !== undefined) { setClauses.push("tags_json = ?"); values.push(JSON.stringify(updates.tags)); }
		if (updates.completedNodes !== undefined) { setClauses.push("completed_nodes = ?"); values.push(updates.completedNodes); }
		if (updates.metadata !== undefined) { setClauses.push("metadata_json = ?"); values.push(JSON.stringify(updates.metadata)); }

		if (setClauses.length === 0) return;

		values.push(runId);
		this.db.prepare(`UPDATE workflow_runs SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
	}

	saveNodeRun(nodeRun: NodeRun): void {
		this.stmt("saveNodeRun", `
			INSERT OR REPLACE INTO node_runs
			(id, run_id, node_name, node_type, runtime_kind,
			 status, started_at, finished_at, duration_ms,
			 inputs_json, outputs_json, error_json,
			 parent_node_id, depth, step_index, metrics_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
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
		);
	}

	updateNodeRun(nodeRunId: string, updates: Partial<NodeRun>): void {
		const setClauses: string[] = [];
		const values: unknown[] = [];

		if (updates.status !== undefined) { setClauses.push("status = ?"); values.push(updates.status); }
		if (updates.finishedAt !== undefined) { setClauses.push("finished_at = ?"); values.push(updates.finishedAt); }
		if (updates.durationMs !== undefined) { setClauses.push("duration_ms = ?"); values.push(updates.durationMs); }
		if (updates.outputs !== undefined) { setClauses.push("outputs_json = ?"); values.push(JSON.stringify(updates.outputs)); }
		if (updates.error !== undefined) { setClauses.push("error_json = ?"); values.push(JSON.stringify(updates.error)); }
		if (updates.metrics !== undefined) { setClauses.push("metrics_json = ?"); values.push(JSON.stringify(updates.metrics)); }

		if (setClauses.length === 0) return;

		values.push(nodeRunId);
		this.db.prepare(`UPDATE node_runs SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
	}

	saveEvent(event: RunEvent): void {
		this.stmt("saveEvent", `
			INSERT INTO run_events (id, type, run_id, workflow_name, timestamp, node_name, node_id, payload_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
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
		this.stmt("saveLog", `
			INSERT INTO log_entries (id, run_id, node_id, node_name, level, message, timestamp, data_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
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
		const row = this.stmt("getRun", "SELECT * FROM workflow_runs WHERE id = ?").get(runId) as any;
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
				const tagConditions = conditions.filter(c => c !== "json_each.value = ?");
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
				const total = (this.db.prepare(countSql).get(...allTagParams) as any)?.total ?? 0;
				const rows = this.db.prepare(querySql).all(...allTagParams, limit, offset) as any[];
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

		const total = (this.db.prepare(countSql).get(...params) as any)?.total ?? 0;
		const rows = this.db.prepare(querySql).all(...params, limit, offset) as any[];
		return { runs: rows.map((r) => this.rowToRun(r)), total };
	}

	getNodeRuns(runId: string): NodeRun[] {
		const rows = this.stmt("getNodeRuns",
			"SELECT * FROM node_runs WHERE run_id = ? ORDER BY step_index",
		).all(runId) as any[];
		return rows.map((r) => this.rowToNodeRun(r));
	}

	getNodeRun(nodeRunId: string): NodeRun | undefined {
		const row = this.stmt("getNodeRun", "SELECT * FROM node_runs WHERE id = ?").get(nodeRunId) as any;
		return row ? this.rowToNodeRun(row) : undefined;
	}

	getEvents(runId: string, since?: number): RunEvent[] {
		if (since) {
			return (this.stmt("getEventsSince",
				"SELECT * FROM run_events WHERE run_id = ? AND timestamp > ? ORDER BY timestamp",
			).all(runId, since) as any[]).map((r) => this.rowToEvent(r));
		}
		return (this.stmt("getEvents",
			"SELECT * FROM run_events WHERE run_id = ? ORDER BY timestamp",
		).all(runId) as any[]).map((r) => this.rowToEvent(r));
	}

	getLogs(runId: string, nodeId?: string): TraceLogEntry[] {
		if (nodeId) {
			return (this.stmt("getLogsNode",
				"SELECT * FROM log_entries WHERE run_id = ? AND node_id = ? ORDER BY timestamp",
			).all(runId, nodeId) as any[]).map((r) => this.rowToLog(r));
		}
		return (this.stmt("getLogs",
			"SELECT * FROM log_entries WHERE run_id = ? ORDER BY timestamp",
		).all(runId) as any[]).map((r) => this.rowToLog(r));
	}

	// === Aggregations ===

	getWorkflowSummaries(): WorkflowSummary[] {
		const rows = this.db.prepare(`
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
		`).all(Date.now() - 24 * 60 * 60 * 1000) as any[];

		return rows.map((r) => {
			// Get last run status
			const lastRun = this.db.prepare(
				"SELECT status FROM workflow_runs WHERE workflow_name = ? ORDER BY started_at DESC LIMIT 1",
			).get(r.workflow_name) as any;

			// Get p95 duration
			const durations = this.db.prepare(
				"SELECT duration_ms FROM workflow_runs WHERE workflow_name = ? AND duration_ms IS NOT NULL ORDER BY duration_ms",
			).all(r.workflow_name) as any[];

			const p95Index = Math.floor(durations.length * 0.95);
			const p95 = durations.length > 0
				? (durations[Math.min(p95Index, durations.length - 1)]?.duration_ms ?? 0)
				: 0;

			return {
				name: r.workflow_name,
				path: r.workflow_path,
				triggerTypes: r.trigger_types ? r.trigger_types.split(",") : [],
				totalRuns: r.total_runs,
				recentRuns: r.recent_runs,
				lastRunAt: r.last_run_at ?? undefined,
				lastRunStatus: lastRun?.status as WorkflowRunStatus | undefined,
				errorRate: r.total_runs > 0 ? r.error_count / r.total_runs : 0,
				avgDurationMs: r.avg_duration ?? 0,
				p95DurationMs: p95,
			};
		});
	}

	getAllTags(): string[] {
		const rows = this.db.prepare(`
			SELECT DISTINCT value as tag
			FROM workflow_runs, json_each(workflow_runs.tags_json)
			ORDER BY value
		`).all() as any[];
		return rows.map((r) => r.tag);
	}

	getActiveRunCount(): number {
		const row = this.db.prepare(
			"SELECT COUNT(*) as count FROM workflow_runs WHERE status = 'running'",
		).get() as any;
		return row?.count ?? 0;
	}

	getMetrics(workflow?: string): MetricsResult {
		const where = workflow ? "WHERE workflow_name = ?" : "";
		const params = workflow ? [workflow] : [];

		// Basic stats
		const stats = this.db.prepare(`
			SELECT
				COUNT(*) as total_runs,
				SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_runs,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_runs,
				AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avg_duration
			FROM workflow_runs ${where}
		`).get(...params) as any;

		// Percentiles
		const durations = this.db.prepare(
			`SELECT duration_ms FROM workflow_runs ${where} ${where ? "AND" : "WHERE"} duration_ms IS NOT NULL ORDER BY duration_ms`,
		).all(...params) as any[];

		const durationValues = durations.map((d: any) => d.duration_ms);

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

			const bucketStats = this.db.prepare(`
				SELECT
					COUNT(*) as total,
					SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
					SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
				FROM workflow_runs
				${where} ${where ? "AND" : "WHERE"} started_at >= ? AND started_at < ?
			`).get(...params, bucketStart, bucketEnd) as any;

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
		const wfRows = this.db.prepare(`
			SELECT
				workflow_name as name,
				COUNT(*) as total_runs,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
				AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avg_duration
			FROM workflow_runs ${where}
			GROUP BY workflow_name
		`).all(...params) as any[];

		const workflowBreakdown = wfRows.map((r: any) => ({
			name: r.name,
			totalRuns: r.total_runs,
			errorRate: r.total_runs > 0 ? r.failed / r.total_runs : 0,
			avgDurationMs: r.avg_duration ?? 0,
		}));

		// Node performance
		const runIdWhere = workflow
			? "WHERE nr.run_id IN (SELECT id FROM workflow_runs WHERE workflow_name = ?)"
			: "";
		const nodeRows = this.db.prepare(`
			SELECT
				nr.node_name,
				COUNT(*) as total,
				SUM(CASE WHEN nr.status = 'failed' THEN 1 ELSE 0 END) as failed,
				AVG(CASE WHEN nr.duration_ms IS NOT NULL THEN nr.duration_ms END) as avg_duration,
				MAX(CASE WHEN nr.duration_ms IS NOT NULL THEN nr.duration_ms END) as max_duration
			FROM node_runs nr
			${runIdWhere}
			GROUP BY nr.node_name
		`).all(...params) as any[];

		const nodePerformance = nodeRows.map((r: any) => ({
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
		this.stmt("saveDashboard", `
			INSERT OR REPLACE INTO dashboards
			(id, name, description, is_default, created_at, updated_at, widgets_json)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
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
		const row = this.stmt("getDashboard", "SELECT * FROM dashboards WHERE id = ?").get(dashboardId) as any;
		return row ? this.rowToDashboard(row) : undefined;
	}

	listDashboards(): Dashboard[] {
		const rows = this.db.prepare("SELECT * FROM dashboards ORDER BY updated_at DESC").all() as any[];
		return rows.map((r) => this.rowToDashboard(r));
	}

	deleteDashboard(dashboardId: string): boolean {
		const result = this.stmt("deleteDashboard", "DELETE FROM dashboards WHERE id = ?").run(dashboardId);
		return result.changes > 0;
	}

	updateDashboard(dashboardId: string, updates: Partial<Dashboard>): void {
		const setClauses: string[] = ["updated_at = ?"];
		const values: unknown[] = [Date.now()];

		if (updates.name !== undefined) { setClauses.push("name = ?"); values.push(updates.name); }
		if (updates.description !== undefined) { setClauses.push("description = ?"); values.push(updates.description); }
		if (updates.isDefault !== undefined) { setClauses.push("is_default = ?"); values.push(updates.isDefault ? 1 : 0); }
		if (updates.widgets !== undefined) { setClauses.push("widgets_json = ?"); values.push(JSON.stringify(updates.widgets)); }

		values.push(dashboardId);
		this.db.prepare(`UPDATE dashboards SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
	}

	// === Cleanup ===

	clearAll(): number {
		const count = (this.db.prepare("SELECT COUNT(*) as c FROM workflow_runs").get() as any)?.c ?? 0;
		this.db.exec("DELETE FROM log_entries");
		this.db.exec("DELETE FROM run_events");
		this.db.exec("DELETE FROM node_runs");
		this.db.exec("DELETE FROM workflow_runs");
		this.db.exec("DELETE FROM dashboards");
		return count;
	}

	deleteRunsBefore(timestamp: number): number {
		// Foreign key CASCADE handles child tables
		const result = this.db.prepare(
			"DELETE FROM workflow_runs WHERE started_at < ? AND status != 'running'",
		).run(timestamp);
		return result.changes;
	}

	evictOldRuns(maxRuns: number): void {
		const count = (this.db.prepare("SELECT COUNT(*) as c FROM workflow_runs").get() as any)?.c ?? 0;
		if (count <= maxRuns) return;

		const toRemove = count - maxRuns;
		this.db.prepare(`
			DELETE FROM workflow_runs WHERE id IN (
				SELECT id FROM workflow_runs
				WHERE status != 'running'
				ORDER BY started_at ASC
				LIMIT ?
			)
		`).run(toRemove);
	}

	close(): void {
		this.stmts = {};
		this.db.close();
	}

	// === Row → Object Mappers ===

	private rowToRun(row: any): WorkflowRun {
		return {
			id: row.id,
			workflowName: row.workflow_name,
			workflowPath: row.workflow_path,
			triggerType: row.trigger_type,
			triggerSummary: row.trigger_summary,
			status: row.status,
			startedAt: row.started_at,
			finishedAt: row.finished_at ?? undefined,
			durationMs: row.duration_ms ?? undefined,
			error: row.error_json ? JSON.parse(row.error_json) : undefined,
			tags: row.tags_json ? JSON.parse(row.tags_json) : undefined,
			metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
			nodeCount: row.node_count,
			completedNodes: row.completed_nodes,
		};
	}

	private rowToNodeRun(row: any): NodeRun {
		return {
			id: row.id,
			runId: row.run_id,
			nodeName: row.node_name,
			nodeType: row.node_type,
			runtimeKind: row.runtime_kind ?? undefined,
			status: row.status,
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
		};
	}

	private rowToEvent(row: any): RunEvent {
		return {
			id: row.id,
			type: row.type,
			runId: row.run_id,
			workflowName: row.workflow_name,
			timestamp: row.timestamp,
			nodeName: row.node_name ?? undefined,
			nodeId: row.node_id ?? undefined,
			payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
		};
	}

	private rowToLog(row: any): TraceLogEntry {
		return {
			id: row.id,
			runId: row.run_id,
			nodeId: row.node_id ?? undefined,
			nodeName: row.node_name ?? undefined,
			level: row.level,
			message: row.message,
			timestamp: row.timestamp,
			data: row.data_json ? JSON.parse(row.data_json) : undefined,
		};
	}

	private rowToDashboard(row: any): Dashboard {
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
