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
 * Storage abstraction for trace data.
 *
 * All methods are synchronous — both the in-memory and better-sqlite3
 * backends are inherently synchronous. A future async variant can be
 * added for PostgreSQL / Prisma without changing this interface.
 */
export interface RunStore {
	// === Writes ===
	saveRun(run: WorkflowRun): void;
	updateRun(runId: string, updates: Partial<WorkflowRun>): void;

	saveNodeRun(nodeRun: NodeRun): void;
	updateNodeRun(nodeRunId: string, updates: Partial<NodeRun>): void;

	saveEvent(event: RunEvent): void;
	saveLog(entry: TraceLogEntry): void;

	// === Reads ===
	getRun(runId: string): WorkflowRun | undefined;
	getRuns(opts?: RunQuery): { runs: WorkflowRun[]; total: number };

	getNodeRuns(runId: string): NodeRun[];
	getNodeRun(nodeRunId: string): NodeRun | undefined;

	getEvents(runId: string, since?: number): RunEvent[];
	getLogs(runId: string, nodeId?: string): TraceLogEntry[];

	// === Aggregations ===
	getWorkflowSummaries(): WorkflowSummary[];
	getAllTags(): string[];
	getActiveRunCount(): number;
	getMetrics(workflow?: string): MetricsResult;

	// === Dashboards ===
	saveDashboard(dashboard: Dashboard): void;
	getDashboard(dashboardId: string): Dashboard | undefined;
	listDashboards(): Dashboard[];
	deleteDashboard(dashboardId: string): boolean;
	updateDashboard(dashboardId: string, updates: Partial<Dashboard>): void;

	// === Cleanup ===
	clearAll(): number;
	deleteRunsBefore(timestamp: number): number;
	evictOldRuns(maxRuns: number): void;

	// === Lifecycle ===
	close(): void;
}
