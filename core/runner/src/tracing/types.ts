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
	| "LOG_ENTRY";

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
