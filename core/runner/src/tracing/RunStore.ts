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

	/**
	 * Snapshot of in-flight concurrency slots — used by the
	 * `/__blok/concurrency/state` endpoint and Studio's in-flight tile.
	 *
	 * Returns one entry per `(workflowName, concurrencyKey)` bucket with
	 * an array of currently-held leases (un-expired). Empty buckets are
	 * omitted. Sort order is unspecified — caller sorts as needed.
	 */
	getConcurrencySnapshot(now: number): Array<{
		workflowName: string;
		concurrencyKey: string;
		leases: Array<{ runId: string; expiresAt: number }>;
	}>;

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

	/**
	 * Tier C #2 — atomically claim eligible scheduled dispatches for the
	 * given `processId`. Returns the claimed rows. Used by trigger boot
	 * recovery (`HttpTrigger.recoverDispatches()`) to prevent multi-
	 * process deployments sharing a PG store from double-firing the same
	 * dispatch.
	 *
	 * Eligibility: a row is claimable when `claimed_by IS NULL`, OR
	 * when its lease is stale (`claimed_at < now - leaseMs`). The claim
	 * is set atomically — once one process claims a row, peers see it
	 * as claimed and skip it on their next recovery pass.
	 *
	 * After claiming, the process registers timers for the returned
	 * rows. The `DeferredRunScheduler` heartbeats the claim
	 * periodically; if the process crashes, the lease expires and a
	 * surviving process can take over on the next recovery.
	 *
	 * On single-process / sqlite deployments this resolves trivially —
	 * one process, no contention. On cross-backend Postgres deployments
	 * this is the foundation for safe horizontal scaling of the durable
	 * scheduler.
	 */
	claimDispatches(
		processId: string,
		leaseMs: number,
		now: number,
		opts?: { triggerType?: string },
	): ScheduledDispatchRow[];

	/**
	 * Tier C #2 — refresh the `claimed_at` timestamp for every row
	 * claimed by `processId`. Idempotent; runs as a single UPDATE.
	 * Called periodically by the `DeferredRunScheduler` heartbeat loop
	 * while the process has registered timers.
	 *
	 * Returns the number of rows refreshed.
	 */
	heartbeatClaims(processId: string, now: number): number;

	/**
	 * Tier C #2 — clear the claim for a single dispatch. Called when the
	 * dispatch fires or is cancelled, BEFORE deleting the row. (For
	 * deletes the claim clear is implicit; this method exists for the
	 * rare case where ownership is released without deleting — e.g.
	 * graceful shutdown that wants peers to take over immediately.)
	 *
	 * Returns true when a row's claim was cleared, false when the row
	 * doesn't exist OR has no claim.
	 */
	releaseClaim(runId: string): boolean;

	/**
	 * Janitor sweep — delete every `scheduled_dispatches` row whose
	 * `expires_at` has elapsed (`expires_at IS NOT NULL AND expires_at < now`).
	 * Rows without a TTL are left alone (their owning runs may legitimately
	 * stay queued indefinitely). Returns the count of deleted rows.
	 *
	 * Forward-scheduled rows whose owning runs were deleted (orphan dispatch
	 * rows) get reaped on the next `HttpTrigger.recoverDispatches()` call,
	 * not here. This sweep only handles past-TTL rows.
	 */
	purgeExpiredScheduledDispatches(now: number): number;

	// === Lifecycle ===
	close(): void;
}
