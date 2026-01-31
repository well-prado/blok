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
	TraceLogEntry,
	WorkflowRun,
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
		} finally {
			client.release();
		}
	}

	// === Writes (sync via memory + async queue to PG) ===

	saveRun(run: WorkflowRun): void {
		this.memory.saveRun(run);
		this.enqueueWrite(() =>
			this.pool
				.query(
					`INSERT INTO workflow_runs
				(id, workflow_name, workflow_path, trigger_type, trigger_summary,
				 status, started_at, finished_at, duration_ms, error_json,
				 tags_json, metadata_json, node_count, completed_nodes)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
				ON CONFLICT (id) DO UPDATE SET
				 status = EXCLUDED.status,
				 finished_at = EXCLUDED.finished_at,
				 duration_ms = EXCLUDED.duration_ms,
				 error_json = EXCLUDED.error_json,
				 tags_json = EXCLUDED.tags_json,
				 metadata_json = EXCLUDED.metadata_json,
				 completed_nodes = EXCLUDED.completed_nodes`,
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
		this.enqueueWrite(() =>
			this.pool
				.query(
					`INSERT INTO node_runs
				(id, run_id, node_name, node_type, runtime_kind,
				 status, started_at, finished_at, duration_ms,
				 inputs_json, outputs_json, error_json,
				 parent_node_id, depth, step_index, metrics_json)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
				ON CONFLICT (id) DO UPDATE SET
				 status = EXCLUDED.status,
				 finished_at = EXCLUDED.finished_at,
				 duration_ms = EXCLUDED.duration_ms,
				 outputs_json = EXCLUDED.outputs_json,
				 error_json = EXCLUDED.error_json,
				 metrics_json = EXCLUDED.metrics_json`,
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

	// === Cleanup ===

	clearAll(): number {
		const count = this.memory.clearAll();
		this.enqueueWrite(async () => {
			await this.pool.query("DELETE FROM log_entries");
			await this.pool.query("DELETE FROM run_events");
			await this.pool.query("DELETE FROM node_runs");
			await this.pool.query("DELETE FROM workflow_runs");
			await this.pool.query("DELETE FROM dashboards");
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
		};
	}

	private rowToNodeRun(row: Record<string, unknown>): NodeRun {
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
