// === Run Lifecycle ===

export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

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
	| "NODE_ATTEMPT_FAILED";

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
}

export interface StartNodeOptions {
	nodeName: string;
	nodeType: string;
	runtimeKind?: string;
	inputs?: unknown;
	parentNodeId?: string;
	depth: number;
	stepIndex: number;
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
