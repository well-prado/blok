// === Run Lifecycle ===

/**
 * Lifecycle status of a workflow run.
 *
 * - `pending`: created but not yet started.
 * - `running`: currently executing.
 * - `completed`: finished successfully.
 * - `failed`: a step threw or the run aborted with an error.
 * - `cancelled`: stopped externally before completion.
 * - `throttled` (Tier 2 #6): rejected at run-entry because the
 *   concurrency limit for the resolved `concurrencyKey` was reached.
 *   Distinct from `failed` — no step ran; nothing produced an error.
 * - `delayed` (Tier 2 #5): scheduled to start at a future time. The
 *   run record exists; the dispatch is pending. Transitions to
 *   `running` when the timer fires.
 * - `expired` (Tier 2 #5): TTL exceeded before dispatch. Auto-cancelled
 *   without execution. Distinct from `cancelled` (which is operator-
 *   initiated) and `failed` (which implies a step ran).
 * - `debounced` (Tier 2 #7): coalesced into another run via the
 *   `debounce.key` mechanism. The "loser" of a leading-mode coalesce;
 *   in trailing mode this state is transient (run flips to `running`
 *   when the debounce timer fires).
 * - `crashed` (Tier 2 quick-wins): the runner itself crashed (uncaught
 *   exception, OOM, signal). Distinct from `failed` (which implies a
 *   step's `process()` threw cleanly). Currently MANUAL — call
 *   `tracker.markRunCrashed(runId, {error})` from custom triggers /
 *   ops harnesses. Auto-flip on uncaught TriggerBase errors is a
 *   deferred follow-up.
 * - `timedOut` (Tier 2 quick-wins): a step's final retry attempt
 *   exceeded its `maxDuration` cap. Distinct from `failed` so SLA
 *   dashboards can separate timeout-driven failures (network /
 *   capacity) from logic failures (bugs). Auto-flipped by
 *   `RunnerSteps` on final-attempt `StepTimeoutError`.
 */
export type WorkflowRunStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "throttled"
	| "delayed"
	| "expired"
	| "debounced"
	| "queued"
	| "crashed"
	| "timedOut";

/**
 * Structured failure detail attached to a {@link WorkflowRun} or
 * {@link NodeRun}. When the failure source threw a typed `BlokError`
 * (master plan §17), every field below may be populated. When the
 * source threw an unstructured `Error`, only `message` and `stack`
 * are set. Studio's `NodeDetail` panel renders the structured fields
 * when present and falls back gracefully otherwise.
 */
export interface RunErrorDetail {
	message: string;
	stack?: string;
	/** Stable machine identifier — see `docs/error-codes.md`. */
	code?: string;
	/** One of the 12 `BlokErrorCategory` values (e.g. `"DEPENDENCY"`). */
	category?: string;
	/** One of `"INFO" | "WARN" | "ERROR" | "FATAL"`. */
	severity?: string;
	/** HTTP-status mapping for the failure. */
	httpStatus?: number;
	/** Whether the runner-level retry policy may retry this. */
	retryable?: boolean;
	/** Suggested backoff before retrying, in milliseconds. */
	retryAfterMs?: number;
	/** Multi-paragraph context (what was tried, why it failed). */
	description?: string;
	/** Suggested next step for the developer. */
	remediation?: string;
	/** Link to documentation explaining the code. */
	docUrl?: string;
	/** Category-specific structured details (Zod issues, SQL state). */
	details?: unknown;
	/** Bounded slice of inputs/state at error time (§17.6). */
	contextSnapshot?: unknown;
	/** Flattened cause chain (outermost first). */
	causes?: ReadonlyArray<Record<string, unknown>>;
}

export interface WorkflowRun {
	id: string;
	workflowName: string;
	workflowPath: string;
	triggerType: string;
	triggerSummary: string;
	status: WorkflowRunStatus;
	startedAt: number;
	finishedAt?: number;
	durationMs?: number;
	error?: RunErrorDetail;
	tags?: string[];
	metadata?: Record<string, unknown>;
	nodeCount: number;
	completedNodes: number;
	/**
	 * Environment scope · Phase 2 of the Studio redesign · trigger.dev v4
	 * parity. Defaults to `"production"` for legacy runs (before this
	 * field was introduced) and for runtimes that don't set `BLOK_ENV`.
	 * Studio filters all list views by `useEnvScope.current` so operators
	 * see only the env they're inspecting; the EnvChip in the sidebar
	 * controls this. Persisted as a regular column on each store; old
	 * SQLite databases still work because the column is optional.
	 */
	environment?: string;
	/**
	 * Tier 1 · replay lineage. When this run was started via
	 * `POST /__blok/runs/:id/replay`, this carries the original run's id.
	 * Studio renders a "Replay of #..." breadcrumb that links back to the
	 * source run. Absent on first-class triggered runs.
	 *
	 * Plumbed end-to-end via the `X-Blok-Replay-Of` HTTP header that the
	 * replay endpoint sets on the dispatched request. TriggerBase reads
	 * the header and threads it into `tracker.startRun({ replayOf })`.
	 */
	replayOf?: string;
	/**
	 * Tier 2 · sub-workflow lineage. When this run was started by a
	 * `subworkflow:` step in another workflow, this carries the parent
	 * run's id. Studio renders a "called from #..." breadcrumb that
	 * links back to the parent run. Absent on first-class triggered runs.
	 */
	parentRunId?: string;
	/**
	 * Tier 2 · sub-workflow lineage. The specific NodeRun within the
	 * parent run that invoked this sub-workflow — lets Studio jump to
	 * the exact sub-workflow step on the parent's run-detail page.
	 */
	parentNodeRunId?: string;
	/**
	 * Tier 2 #5 · scheduled dispatch time (ms since epoch). Set when the
	 * run is created with `delay` on the trigger config, OR when the
	 * debounce coordinator parks a coalescing run. Absent on immediate
	 * runs.
	 */
	scheduledAt?: number;
	/**
	 * Tier 2 #5 · TTL deadline (ms since epoch). When `now > expiresAt`
	 * at dispatch time, the run is marked `expired` and skipped. Set
	 * from `trigger.ttl` plus the original submission timestamp. Absent
	 * when no TTL is configured.
	 */
	expiresAt?: number;
	/**
	 * Tier 2 #7 · resolved debounce key (`debounce.key` after
	 * `js/...`-expression evaluation). Pings sharing this key + workflow
	 * name coalesce into the same `WorkflowRun`. Absent on non-debounced
	 * runs.
	 */
	debounceKey?: string;
	/**
	 * Tier 2 #7 · debounce mode that produced this run. Surfaces in
	 * Studio's run detail so users can tell `leading` (immediate-fire)
	 * vs `trailing` (silence-then-fire) at a glance.
	 */
	debounceMode?: "leading" | "trailing";
	/**
	 * Tier 2 #7 · number of pings absorbed by this run before dispatch.
	 * Starts at 1 (the first ping). Subsequent same-key pings increment
	 * this rather than creating new run records. Surfaces on Studio's
	 * run row as "Pings: N".
	 */
	pingCount?: number;
}

// === Node Lifecycle ===

export type NodeRunStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface NodeRun {
	id: string;
	runId: string;
	nodeName: string;
	nodeType: string;
	runtimeKind?: string;
	status: NodeRunStatus;
	startedAt: number;
	finishedAt?: number;
	durationMs?: number;
	inputs?: unknown;
	outputs?: unknown;
	error?: RunErrorDetail;
	/**
	 * Latest streaming progress hint emitted via the proto `Progress`
	 * event during `ExecuteStream` (master plan §17 Phase 5
	 * follow-up). Studio renders it as a live progress bar; the
	 * value is overwritten on each new frame so only the most recent
	 * milestone is preserved. Absent for unary calls and for SDKs
	 * that don't emit progress frames.
	 */
	progress?: {
		/** 0–100, clamped. */
		percent: number;
		/** Free-form phase label (`"validating"`, `"writing"`, …). May be empty. */
		phase: string;
		/** Wall-clock receipt timestamp (ms since epoch). */
		updatedAt: number;
	};
	/**
	 * Latest streaming `PartialResult` snapshot during `ExecuteStream`.
	 * Useful for UIs that want to show interim state of a long-running
	 * computation (row count, partial output). Always overwritten by
	 * newer frames — only the latest snapshot is preserved.
	 */
	partialResult?: {
		snapshot: unknown;
		updatedAt: number;
	};
	parentNodeId?: string;
	depth: number;
	stepIndex: number;
	metrics?: {
		duration_ms?: number;
		cpu_ms?: number;
		memory_bytes?: number;
		/** Approximate or exact bytes sent on the wire to the SDK. */
		request_bytes?: number;
		/** Bytes received from the SDK in the response. */
		response_bytes?: number;
	};
	/**
	 * Tier 1 idempotency cache lineage. Populated by `RunTracker.markNodeCached`
	 * when the step short-circuited via a cache hit instead of running. Studio
	 * renders a "CACHED" badge with a click-through to the source run/node.
	 * Absent on regular completed nodes.
	 */
	cached?: {
		sourceRunId: string;
		sourceNodeRunId: string;
		cachedAt: number;
	};
	/**
	 * Tier 1 retry attempts. One entry per `NODE_ATTEMPT_FAILED` event the
	 * step emitted before either succeeding or exhausting `retry.maxAttempts`.
	 * Capped at 10 entries (`MAX_STORED_ATTEMPTS`) — extreme retry counts
	 * are bounded so a runaway loop can't bloat the run store.
	 *
	 * Studio renders this as a collapsible "Attempts (N)" disclosure on the
	 * step's panel. The final outcome lives on the node's status / error
	 * fields; this array carries only the failed attempts that came before.
	 */
	attempts?: Array<{
		attempt: number;
		error: RunErrorDetail;
		timestamp: number;
	}>;
	/**
	 * Tier 2 #4 sub-workflow mode — only set for `nodeType === "subworkflow"`.
	 * - `true` (default) — synchronous: parent step blocks on child completion.
	 * - `false` — fire-and-forget: parent returns dispatch metadata immediately;
	 *   child runs asynchronously via `setImmediate`. Studio renders a distinct
	 *   `↳ async` badge in StepRail to differentiate from synchronous siblings.
	 *
	 * Captured at `tracker.startNode()` time so it survives the trace and is
	 * visible to Studio without recomputing from outputs heuristics.
	 */
	wait?: boolean;
}

/**
 * Stored result of a previously-successful step execution, keyed by
 * `(workflowName, step.id, idempotencyKey)`. On cache hit, RunnerSteps
 * skips `step.process()` and replays the cached `data` through the same
 * `PersistenceHelper.applyStepOutput` rules — caching layers ABOVE
 * persistence, never within it.
 */
export interface CachedStepResult {
	/** The data the step originally returned. */
	data: unknown;
	/** ms since epoch when the entry was written. */
	cachedAt: number;
	/** ms since epoch when the entry expires; null = no expiry. */
	expiresAt: number | null;
	/** Run that originally produced this result. */
	sourceRunId: string;
	/** Node run that originally produced this result. */
	sourceNodeRunId: string;
}

/**
 * Outcome of an `acquireConcurrencySlot` attempt (Tier 2 #6).
 *
 * The store's gate decides whether the run is allowed to proceed by
 * comparing the current in-flight count for the (workflow, key) pair
 * against the requested limit.
 */
export interface ConcurrencySlotResult {
	/** True when the slot was granted; false when the run should be throttled. */
	acquired: boolean;
	/**
	 * Number of in-flight runs (including the just-acquired one when
	 * `acquired === true`) sharing the same (workflowName, concurrencyKey).
	 * Useful for observability — Studio surfaces this on `RUN_THROTTLED`.
	 */
	currentInFlight: number;
}

// === Durable scheduling (Tier 2 #5+#7 follow-up) ===

/**
 * A persisted scheduled dispatch — one row per pending HTTP-trigger
 * deferral. Written by `DeferredRunScheduler.schedule()` when a
 * `persist` payload is provided; deleted on cancel or fire.
 *
 * Boot recovery (HttpTrigger.recoverDispatches) scans this table,
 * marks past-due+TTL-expired rows as `"expired"`, and re-registers
 * timers for live dispatches.
 */
export interface ScheduledDispatchRow {
	runId: string;
	workflowName: string;
	/** `"http"` for v1; future triggers can opt in. */
	triggerType: string;
	/** ms since epoch when to dispatch. */
	scheduledAt: number;
	/** ms since epoch TTL deadline (undefined = no TTL). */
	expiresAt?: number;
	/** Mirrors the run record's status — `"delayed" | "queued" | "debounced"`. */
	dispatchStatus: "delayed" | "queued" | "debounced";
	/**
	 * JSON-serialized minimal Context subset, trigger-defined.
	 * For HTTP: `{method, path, headers, body, params, query, workflowPath}`
	 * with sensitive header keys stripped (authorization, cookie, x-api-key).
	 */
	payload: unknown;
	/** ms since epoch when the row was first written. */
	createdAt: number;
}

// === Events ===

export type RunEventType =
	| "RUN_STARTED"
	| "RUN_COMPLETED"
	| "RUN_FAILED"
	| "NODE_STARTED"
	| "NODE_COMPLETED"
	| "NODE_FAILED"
	| "NODE_SKIPPED"
	| "VARS_UPDATED"
	| "LOG_ENTRY"
	/** §17 Phase 5: streaming `Progress` frame from the SDK. */
	| "NODE_PROGRESS"
	/** §17 Phase 5: streaming `PartialResult` frame from the SDK. */
	| "NODE_PARTIAL_RESULT"
	/**
	 * Tier 1 idempotency cache hit: the step short-circuited via the
	 * idempotency cache instead of running. Payload carries
	 * `{ durationMs, source: { sourceRunId, sourceNodeRunId, cachedAt } }`.
	 * Studio renders a CACHED badge on the affected node.
	 */
	| "NODE_CACHED"
	/**
	 * Tier 1 retry: a step attempt failed and another retry will follow.
	 * Payload carries `{ attempt, error }`. Final attempt failure (after
	 * exhausting `retry.maxAttempts`) emits `NODE_FAILED` instead.
	 */
	| "NODE_ATTEMPT_FAILED"
	/**
	 * Tier 2 #6 concurrency gate denied a run before any step executed.
	 * Payload carries `{ concurrencyKey, concurrencyLimit, currentInFlight }`.
	 * The run's status flips to `"throttled"` (distinct from `"failed"` —
	 * no step ran). Studio surfaces a Throttled badge.
	 */
	| "RUN_THROTTLED"
	/**
	 * Tier 2 #5 — run scheduled for later dispatch via `trigger.delay`.
	 * Payload `{scheduledAt, delayMs, expiresAt?}`. Status flips to
	 * `"delayed"`; transitions to `"running"` when the timer fires.
	 */
	| "RUN_DELAYED"
	/**
	 * Tier 2 #5 — TTL exceeded; run auto-cancelled before dispatch.
	 * Payload `{expiresAt, expiredAt, lateBy}`. Status flips to `"expired"`.
	 */
	| "RUN_EXPIRED"
	/**
	 * Tier 2 #7 — run coalesced into a debounce window. Payload
	 * `{debounceKey, mode, intoRunId?, pingCount?}`. Status flips to
	 * `"debounced"`. In leading mode this is terminal (the run never
	 * executes — execution went to a sibling). In trailing mode this is
	 * transient and the same run flips to `"running"` when the window
	 * closes.
	 */
	| "RUN_DEBOUNCED"
	/**
	 * Tier 2 #6 follow-up — concurrency gate denied a run AND the trigger
	 * is configured with `onLimit: "queue"`. Instead of throwing, the run
	 * is deferred via `DeferredRunScheduler` and re-attempts acquisition
	 * after a 1s delay. Payload `{concurrencyKey, concurrencyLimit,
	 * currentInFlight, scheduledAt}`. Status flips to `"queued"`;
	 * transitions to `"running"` when the timer fires (and may flip back
	 * to `"queued"` on re-denial).
	 */
	| "RUN_QUEUED"
	/**
	 * Tier 2 polish — operator cancelled a pending (delayed/debounced/
	 * queued) run via `POST /__blok/runs/:runId/cancel`. Payload
	 * `{durationMs, previousStatus}`. Status flips to `"cancelled"`.
	 * Currently only pre-execution states are cancellable; running runs
	 * require cooperative `AbortSignal` (deferred follow-up).
	 */
	| "RUN_CANCELLED"
	/**
	 * Tier 2 quick-wins — run crashed (uncaught exception / OOM /
	 * signal). Payload `{durationMs, error}`. Distinct from `RUN_FAILED`
	 * (which implies a step's `process()` threw cleanly). Currently
	 * manual via `tracker.markRunCrashed(runId, {error})`.
	 */
	| "RUN_CRASHED"
	/**
	 * Tier 2 quick-wins — a step's final retry attempt exceeded its
	 * `maxDuration` cap. Payload `{durationMs, stepId, maxDurationMs,
	 * attemptsExhausted}`. Auto-emitted by `RunnerSteps` when the
	 * timeout fires on the last attempt. Run status flips to
	 * `"timedOut"`.
	 */
	| "RUN_TIMED_OUT";

export interface RunEvent {
	id: string;
	type: RunEventType;
	runId: string;
	workflowName: string;
	timestamp: number;
	nodeName?: string;
	nodeId?: string;
	payload?: unknown;
}

// === Log Entry ===

export interface TraceLogEntry {
	id: string;
	runId: string;
	nodeId?: string;
	nodeName?: string;
	level: "debug" | "info" | "warn" | "error";
	message: string;
	timestamp: number;
	data?: Record<string, unknown>;
}

// === API Response Types ===

export interface WorkflowSummary {
	name: string;
	path: string;
	triggerTypes: string[];
	totalRuns: number;
	recentRuns: number;
	lastRunAt?: number;
	lastRunStatus?: WorkflowRunStatus;
	errorRate: number;
	avgDurationMs: number;
	p95DurationMs: number;
}

export interface WorkflowDetail extends WorkflowSummary {
	definition?: unknown;
	nodeNames: string[];
	runtimes: string[];
}

export interface PaginatedResult<T> {
	data: T[];
	total: number;
	page: number;
	limit: number;
}

// === Start Options ===

export interface StartRunOptions {
	workflowName: string;
	workflowPath: string;
	triggerType: string;
	triggerSummary: string;
	nodeCount: number;
	tags?: string[];
	metadata?: Record<string, unknown>;
	/**
	 * Tier 1 · replay lineage. When a run is started via the replay endpoint,
	 * this carries the original run's id so Studio can render a "Replay of #..."
	 * breadcrumb. Plumbed end-to-end via the `X-Blok-Replay-Of` HTTP header.
	 */
	replayOf?: string;
	/**
	 * Tier 2 · sub-workflow lineage. Populated by `SubworkflowNode` when
	 * invoking a child workflow inline. Studio uses this to render a
	 * "called from #..." breadcrumb on the child's run detail.
	 */
	parentRunId?: string;
	parentNodeRunId?: string;
	/**
	 * Tier 2 #5 · scheduled dispatch time (ms since epoch). When set, the
	 * run is created with status `"delayed"` instead of `"running"`.
	 */
	scheduledAt?: number;
	/**
	 * Tier 2 #5 · TTL deadline (ms since epoch). Persists onto the run
	 * for the dispatcher to consult.
	 */
	expiresAt?: number;
	/**
	 * Tier 2 #7 · resolved debounce key. When set, pings sharing this
	 * key + workflow name coalesce.
	 */
	debounceKey?: string;
	/**
	 * Tier 2 #7 · debounce mode that produced this run.
	 */
	debounceMode?: "leading" | "trailing";
	/**
	 * Tier 2 #7 · initial ping count for the run (typically 1 — the
	 * first ping). Subsequent pings increment via direct store update.
	 */
	pingCount?: number;
}

export interface StartNodeOptions {
	nodeName: string;
	nodeType: string;
	runtimeKind?: string;
	inputs?: unknown;
	parentNodeId?: string;
	depth: number;
	stepIndex: number;
	/**
	 * Tier 2 #4 sub-workflow mode. Only meaningful when `nodeType === "subworkflow"`.
	 * Persisted onto `NodeRun.wait` so Studio can render `↳ async` vs `↳ sub`.
	 */
	wait?: boolean;
}

// === Custom Dashboards ===

export type WidgetType =
	| "stat-card"
	| "timeline"
	| "error-rate"
	| "duration-distribution"
	| "workflow-breakdown"
	| "node-performance"
	| "recent-runs"
	| "heatmap";

export interface DashboardWidget {
	id: string;
	type: WidgetType;
	title: string;
	config: {
		workflow?: string;
		timeRange?: "1h" | "6h" | "24h" | "7d" | "30d";
		metric?: string;
		limit?: number;
		[key: string]: unknown;
	};
	position: {
		x: number;
		y: number;
		w: number;
		h: number;
	};
}

export interface Dashboard {
	id: string;
	name: string;
	description?: string;
	isDefault: boolean;
	createdAt: number;
	updatedAt: number;
	widgets: DashboardWidget[];
}

// === Store Query Types ===

export interface RunQuery {
	workflow?: string;
	status?: WorkflowRunStatus;
	tags?: string[];
	/**
	 * Tier 2 quick-wins — filter by metadata key=value pairs. Multiple
	 * pairs combine with AND semantics (a run matches only when all
	 * declared keys match the requested values, compared via stringified
	 * equality). Backed by `json_extract` on SQLite + `Object` lookup
	 * on InMemory. Sequential scan (no index); acceptable given the
	 * `evictOldRuns` size cap on the runs table.
	 */
	metadata?: Record<string, string>;
	limit?: number;
	offset?: number;
	sort?: "asc" | "desc";
}

export interface MetricsResult {
	totalRuns: number;
	completedRuns: number;
	failedRuns: number;
	avgDurationMs: number;
	p50DurationMs: number;
	p95DurationMs: number;
	p99DurationMs: number;
	executionTimeline: Array<{
		bucket: string;
		total: number;
		completed: number;
		failed: number;
	}>;
	durationDistribution: Array<{
		range: string;
		count: number;
	}>;
	workflowBreakdown: Array<{
		name: string;
		totalRuns: number;
		errorRate: number;
		avgDurationMs: number;
	}>;
	nodePerformance: Array<{
		nodeName: string;
		avgDurationMs: number;
		maxDurationMs: number;
		errorRate: number;
		executionCount: number;
	}>;
}
