/** Mirror of backend tracing types for the Studio frontend. */

export type WorkflowRunStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	/** Tier 2 #6: rejected at run-entry by the concurrency gate. No step ran. */
	| "throttled"
	/** Tier 2 #5: scheduled for a future dispatch; timer pending. */
	| "delayed"
	/** Tier 2 #5: TTL exceeded before dispatch. Auto-cancelled without execution. */
	| "expired"
	/** Tier 2 #7: coalesced into another run via the debounce key. */
	| "debounced"
	/**
	 * Tier 2 #6 follow-up: gate denied + `onLimit:"queue"` deferred the run.
	 * Will retry acquisition after `scheduledAt`; eventually transitions to
	 * `running` (and on completion to `completed`) or stays `queued` if the
	 * slot keeps being occupied.
	 */
	| "queued"
	/** Tier 2 quick-wins: runner crashed (uncaught exception / OOM / signal). */
	| "crashed"
	/** Tier 2 quick-wins: step's final retry attempt exceeded `maxDuration`. */
	| "timedOut";

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
	error?: {
		message: string;
		code?: string;
		stack?: string;
	};
	tags?: string[];
	metadata?: Record<string, unknown>;
	nodeCount: number;
	completedNodes: number;
	/**
	 * Tier 1 · replay lineage. When this run was started via the replay
	 * endpoint, this carries the original run's id so Studio can render
	 * a "Replay of #..." breadcrumb that links back to the source.
	 */
	replayOf?: string;
	/**
	 * Tier 2 · sub-workflow lineage. When this run was started by a
	 * `subworkflow:` step in another workflow, this carries the parent
	 * run's id. Studio renders a "called from #..." breadcrumb.
	 */
	parentRunId?: string;
	/**
	 * Tier 2 · sub-workflow lineage. The specific NodeRun within the
	 * parent run that invoked this sub-workflow.
	 */
	parentNodeRunId?: string;
	/** Tier 2 #5: scheduled dispatch time (ms since epoch). */
	scheduledAt?: number;
	/** Tier 2 #5: TTL deadline (ms since epoch). */
	expiresAt?: number;
	/** Tier 2 #7: resolved debounce key. */
	debounceKey?: string;
	/** Tier 2 #7: debounce mode (`leading` | `trailing`). */
	debounceMode?: "leading" | "trailing";
	/** Tier 2 #7: pings absorbed by this run before dispatch. */
	pingCount?: number;
}

export type NodeRunStatus = "pending" | "running" | "completed" | "failed" | "skipped";

/**
 * Structured failure detail per master plan §17. Mirrors the runner-side
 * `RunErrorDetail` shape from `core/runner/src/tracing/types.ts`. All
 * structured fields are optional — for unstructured throws only
 * `message` and `stack` are populated.
 */
export interface NodeRunErrorDetail {
	message: string;
	stack?: string;
	code?: string;
	/** One of the 12 `BlokErrorCategory` values, e.g. `"DEPENDENCY"`. */
	category?: string;
	/** `"INFO" | "WARN" | "ERROR" | "FATAL"`. */
	severity?: string;
	httpStatus?: number;
	retryable?: boolean;
	retryAfterMs?: number;
	description?: string;
	remediation?: string;
	docUrl?: string;
	details?: unknown;
	contextSnapshot?: unknown;
	causes?: ReadonlyArray<Record<string, unknown>>;
}

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
	/**
	 * Failure detail. When the node threw a typed `BlokError` (master plan
	 * §17), the structured fields (category, retryable, remediation,
	 * causes, …) are populated and rendered by `NodeDetail` with the
	 * full §17.10 affordances. Unstructured throws set only `message`
	 * and `stack`.
	 */
	error?: NodeRunErrorDetail;
	/**
	 * Latest streaming `Progress` frame from the SDK (master plan §17
	 * Phase 5 follow-up). Studio renders it as a live progress bar
	 * that drives forward as new frames arrive. Absent for unary
	 * calls and SDKs that don't emit progress.
	 */
	progress?: {
		/** 0–100, clamped. */
		percent: number;
		/** Free-form phase label (e.g. `"validating"`). May be empty. */
		phase: string;
		/** Wall-clock receipt timestamp (ms since epoch). */
		updatedAt: number;
	};
	/**
	 * Latest streaming `PartialResult` snapshot — useful for showing
	 * interim state of a long-running computation.
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
		/** gRPC adapter only: bytes sent on the wire to the SDK. */
		request_bytes?: number;
		/** gRPC adapter only: bytes received in the SDK's response. */
		response_bytes?: number;
	};
	/**
	 * Tier 1 idempotency cache hit lineage. When set, this node short-
	 * circuited via the cache instead of running. Studio renders a CACHED
	 * badge with click-through to the source run/node.
	 */
	cached?: {
		sourceRunId: string;
		sourceNodeRunId: string;
		cachedAt: number;
	};
	/**
	 * Tier 1 retry attempts that failed before the node ultimately
	 * succeeded or was fail-noded. Capped at 10 entries by the runner.
	 * Studio renders this as an "Attempts (N)" disclosure.
	 */
	attempts?: Array<{
		attempt: number;
		error: NodeRunErrorDetail;
		timestamp: number;
	}>;
	/**
	 * Tier 2 #4 sub-workflow mode. Only set for `nodeType === "subworkflow"`.
	 * - `true` (default) — synchronous: parent step blocks on child completion.
	 * - `false` — fire-and-forget: child runs asynchronously. Studio renders
	 *   a distinct `↳ async` badge (vs `↳ sub`) in StepRail.
	 */
	wait?: boolean;
	/**
	 * G2 (v0.6) sub-workflow dispatch strategy. Only set for
	 * `nodeType === "subworkflow"`. Drives a small `http` badge alongside
	 * the existing `↳ async`/`↳ sub` in StepRail so operators can see at
	 * a glance whether the child ran in-process or via an HTTP self-call.
	 * - `"in-process"` (default; also `undefined` on pre-v0.6 traces) —
	 *   child ran in the same Node process.
	 * - `"http-self"` — child was dispatched as a fresh HTTP request to
	 *   `BLOK_SELF_BASE_URL`, potentially landing on a different process.
	 */
	dispatch?: "in-process" | "http-self";
	/**
	 * PR 5 E3 — sub-workflow nesting depth. Top-level workflow's
	 * sub-workflow step has `subworkflowDepth = 1`; nested sub-workflows
	 * have higher values. Studio renders `↳ sub (N)` / `↳ async (N)`
	 * only when N >= 2 to keep top-level invocations un-cluttered.
	 */
	subworkflowDepth?: number;
	/**
	 * v0.5 — origin middleware name. Set when this NodeRun was emitted
	 * during the trigger's `runMiddlewareChain` dispatch (e.g.
	 * "auth-check", "rate-limit"). Studio renders `mw:<name>` on the
	 * step row so operators can see at a glance which middleware in the
	 * trigger.http.middleware chain produced this nested step. Absent
	 * on the main workflow's own steps.
	 */
	middleware?: string;
	/**
	 * v0.5.3 — iteration index for inner steps of a `forEach` or `loop`
	 * primitive. ForEachNode + LoopNode set this per iteration on the
	 * cloned child ctx; RunnerSteps propagates it onto each NodeRun.
	 * StepRail uses it to group consecutive sibling rows under
	 * "iteration N" headers — instead of rendering a 5-iteration forEach
	 * with 3 inner steps as 15 flat rows with duplicate names, we render
	 * 5 collapsible groups. Undefined for top-level steps, for steps
	 * inside non-iteration primitives (`tryCatch`, `switch`), and for
	 * legacy traces written before v0.5.3.
	 */
	iterationIndex?: number;
}

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
	 * Tier 1: idempotency cache hit — the step short-circuited via the
	 * cache instead of running. Payload carries the source run/node lineage.
	 */
	| "NODE_CACHED"
	/**
	 * Tier 1: retry attempt failed; another attempt will follow.
	 * Final failure (after exhausting maxAttempts) emits NODE_FAILED.
	 */
	| "NODE_ATTEMPT_FAILED"
	/**
	 * Tier 2 #6 concurrency gate denied the run. Payload carries
	 * `{ concurrencyKey, concurrencyLimit, currentInFlight, durationMs }`.
	 */
	| "RUN_THROTTLED"
	/** Tier 2 #5: scheduled for a future dispatch. Payload `{scheduledAt, delayMs, expiresAt?}`. */
	| "RUN_DELAYED"
	/** Tier 2 #5: TTL exceeded before dispatch. Payload `{expiresAt, expiredAt, lateBy}`. */
	| "RUN_EXPIRED"
	/** Tier 2 #7: coalesced into another run. Payload `{debounceKey, mode, intoRunId?, pingCount, scheduledAt?}`. */
	| "RUN_DEBOUNCED"
	/**
	 * Tier 2 #6 follow-up: concurrency gate denied + `onLimit:"queue"` deferred
	 * the run. Payload `{concurrencyKey, concurrencyLimit, currentInFlight, scheduledAt}`.
	 */
	| "RUN_QUEUED"
	/**
	 * Tier 2 polish: operator cancelled a pending (delayed/debounced/queued) run
	 * via `POST /__blok/runs/:runId/cancel`. Payload `{durationMs, previousStatus}`.
	 */
	| "RUN_CANCELLED"
	/** Tier 2 quick-wins: runner crashed. Payload `{durationMs, error}`. */
	| "RUN_CRASHED"
	/** Tier 2 quick-wins: step's final retry attempt timed out. Payload `{durationMs, stepId, maxDurationMs, attemptsExhausted}`. */
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

/**
 * E2 — server-side saved filter (mirrors `SavedFilter` in
 * `core/runner/src/tracing/types.ts`). Replaces the prior
 * localStorage-only shape; Studio now reads/writes through
 * `/__blok/saved-filters` so presets survive across browsers + devs.
 */
export interface SavedFilter {
	id: string;
	name: string;
	status: string;
	tagsInput: string;
	metadataInput: string;
	createdAt: number;
	updatedAt: number;
}

export interface WorkflowDetail extends WorkflowSummary {
	definition?: unknown;
	nodeNames: string[];
	runtimes: string[];
	/**
	 * Sample-body for the empty-state curl snippet. `body` is always
	 * present when `examples` is set. `source` provenance:
	 *   - `author` — declared in `trigger.http.examples.body`.
	 *   - `recorded` — captured from a real successful run (v0.6 option C).
	 *   - `inferred` — synthesized from static step-input analysis (#100).
	 *   - `empty` — no body references + no recording + no override.
	 */
	examples?: {
		body: unknown;
		source: "author" | "recorded" | "inferred" | "empty";
	};
}

export interface RunDetail {
	run: WorkflowRun;
	nodes: NodeRun[];
	logs: TraceLogEntry[];
}

export interface RunListResponse {
	runs: WorkflowRun[];
	total: number;
	page: number;
}

/**
 * Mirrors `ScheduledDispatchRow` in `core/runner/src/tracing/types.ts`.
 * Returned by `GET /__blok/scheduled` for the Studio "Scheduled runs"
 * view (E1).
 */
export interface ScheduledDispatchRow {
	runId: string;
	workflowName: string;
	triggerType: string;
	scheduledAt: number;
	expiresAt?: number;
	dispatchStatus: "delayed" | "queued" | "debounced";
	payload: unknown;
	createdAt: number;
	claimedBy?: string;
	claimedAt?: number;
}

export interface ScheduledDispatchesResponse {
	rows: ScheduledDispatchRow[];
	total: number;
	/**
	 * Server-side `Date.now()` snapshot. Used by the client to render
	 * accurate "fires in 27s" countdowns without clock skew.
	 */
	now: number;
}

export interface HealthResponse {
	status: string;
	version: string;
	uptime: number;
	activeRuns: number;
}

export interface ConfigResponse {
	workflows: string[];
	triggers: string[];
}

export interface DiffResponse {
	runA: RunDetail;
	runB: RunDetail;
}

export interface MetricsResponse {
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

export interface TagsResponse {
	tags: string[];
}

export interface AddTagResponse {
	added: string[];
	tags: string[];
}

export interface RemoveTagResponse {
	removed: boolean;
	tags: string[];
}

// === Webhooks ===

export interface Webhook {
	id: string;
	url: string;
	events: string[];
	secret?: string;
	createdAt: number;
	active: boolean;
	lastTriggeredAt?: number;
	lastStatus?: number;
	failCount: number;
}

export interface WebhooksResponse {
	webhooks: Webhook[];
}

// === AI Explanation ===

export interface ExplainResponse {
	explanation: string;
	model: string;
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

export interface DashboardsResponse {
	dashboards: Dashboard[];
}
