import type {
	CachedStepResult,
	ConcurrencySlotResult,
	Dashboard,
	MetricsResult,
	NodeRun,
	RunEvent,
	RunQuery,
	ScheduledDispatchRow,
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

	// === Sub-workflow lineage (Tier 2) ===
	/**
	 * Return every run whose `parentRunId` matches the given run id, sorted
	 * oldest-first. Used by Studio's "Sub-runs" list on a parent's run-detail
	 * page. Returns `[]` when the run has no children.
	 */
	getRunsByParent(parentRunId: string): WorkflowRun[];

	// === Cleanup ===
	clearAll(): number;
	deleteRunsBefore(timestamp: number): number;
	evictOldRuns(maxRuns: number): void;

	// === Idempotency cache (Tier 1) ===
	/**
	 * Look up a previously-cached step result. Returns null on miss or
	 * when the entry has expired (expired entries are lazily purged on read).
	 */
	getIdempotencyCache(workflowName: string, stepId: string, key: string): CachedStepResult | null;

	/**
	 * Store a step result keyed by (workflowName, stepId, key). Overwrites any
	 * previous entry for the same triple. Pass `expiresAt: null` for no TTL.
	 */
	setIdempotencyCache(workflowName: string, stepId: string, key: string, entry: CachedStepResult): void;

	/**
	 * Delete every entry whose `expiresAt` is non-null and `<= now`. Returns
	 * the number of rows removed. Cheap to call periodically; safe under
	 * concurrent reads.
	 */
	purgeExpiredIdempotencyCache(now: number): number;

	// === Concurrency gating (Tier 2 #6) ===
	/**
	 * Try to acquire a slot for `(workflowName, concurrencyKey)`. Lazily
	 * purges expired leases for the same key first, then grants the slot
	 * iff `currentInFlight < concurrencyLimit`.
	 *
	 * Returns:
	 *   `{ acquired: true,  currentInFlight: <new count> }` on success
	 *   `{ acquired: false, currentInFlight: <observed count> }` on denial
	 *
	 * The lease has a hard upper bound (`leaseExpiresAt` in ms since epoch).
	 * Callers MUST release the slot in a `finally` block; the lease is the
	 * crash-safety net for processes that die before release.
	 */
	acquireConcurrencySlot(
		workflowName: string,
		concurrencyKey: string,
		concurrencyLimit: number,
		runId: string,
		leaseExpiresAt: number,
	): ConcurrencySlotResult;

	/**
	 * Release a slot previously acquired by `runId`. Idempotent — releasing
	 * an unknown `runId` is a no-op (covers double-release races between
	 * the happy-path `finally` block and the lazy-purge fallback).
	 */
	releaseConcurrencySlot(workflowName: string, concurrencyKey: string, runId: string): void;

	/**
	 * Delete every lease whose `expiresAt <= now`. Returns the number of
	 * rows removed. Cheap to call periodically (e.g. from a janitor task);
	 * the gate also lazy-purges per-key on every acquire call.
	 */
	purgeExpiredConcurrencySlots(now: number): number;

	// === Durable scheduling (Tier 2 #5+#7 follow-up) ===

	/**
	 * Persist a scheduled dispatch row, or replace an existing one with
	 * the same `runId` (debounce reset, queue re-defer). Idempotent.
	 *
	 * Called by `DeferredRunScheduler.schedule()` when a `persist` payload
	 * is provided. The row carries everything the trigger needs to
	 * reconstruct dispatch on boot.
	 */
	upsertScheduledDispatch(row: ScheduledDispatchRow): void;

	/**
	 * Delete a scheduled dispatch row. Returns true when a row existed.
	 * Idempotent — safe to call on rows that have already been deleted
	 * (e.g. after the timer fires + cancel races).
	 */
	deleteScheduledDispatch(runId: string): boolean;

	/**
	 * List scheduled dispatches, optionally filtered by trigger type
	 * and/or status. Used by trigger boot recovery (HttpTrigger) to
	 * find rows it owns.
	 */
	getScheduledDispatches(opts?: { triggerType?: string; status?: string }): ScheduledDispatchRow[];

	// === Lifecycle ===
	close(): void;
}
