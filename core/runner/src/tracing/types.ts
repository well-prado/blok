// === Run Lifecycle ===

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
	error?: {
		message: string;
		code?: string;
		stack?: string;
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
