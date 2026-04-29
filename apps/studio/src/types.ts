/** Mirror of backend tracing types for the Studio frontend. */

export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

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
	};
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
	| "NODE_PARTIAL_RESULT";

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

export interface WorkflowDetail extends WorkflowSummary {
	definition?: unknown;
	nodeNames: string[];
	runtimes: string[];
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
