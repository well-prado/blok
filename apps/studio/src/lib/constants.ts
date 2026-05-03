import type { NodeRunStatus, RunEventType, WorkflowRunStatus } from "@/types";

export const STATUS_COLORS: Record<WorkflowRunStatus | NodeRunStatus, string> = {
	pending: "text-zinc-400 bg-zinc-400/10",
	running: "text-blue-400 bg-blue-400/10",
	completed: "text-green-400 bg-green-400/10",
	failed: "text-red-400 bg-red-400/10",
	cancelled: "text-purple-400 bg-purple-400/10",
	skipped: "text-zinc-500 bg-zinc-500/10",
	throttled: "text-amber-300 bg-amber-300/10",
	delayed: "text-yellow-400 bg-yellow-400/10",
	expired: "text-zinc-500 bg-zinc-500/10",
	debounced: "text-cyan-400 bg-cyan-400/10",
	queued: "text-lime-300 bg-lime-300/10",
	crashed: "text-red-500 bg-red-500/10",
	timedOut: "text-orange-400 bg-orange-400/10",
};

export const STATUS_DOT_COLORS: Record<WorkflowRunStatus | NodeRunStatus, string> = {
	pending: "bg-zinc-400",
	running: "bg-blue-400",
	completed: "bg-green-400",
	failed: "bg-red-400",
	cancelled: "bg-purple-400",
	skipped: "bg-zinc-500",
	throttled: "bg-amber-300",
	delayed: "bg-yellow-400",
	expired: "bg-zinc-500",
	debounced: "bg-cyan-400",
	queued: "bg-lime-300",
	crashed: "bg-red-500",
	timedOut: "bg-orange-400",
};

export const STATUS_LABELS: Record<WorkflowRunStatus | NodeRunStatus, string> = {
	pending: "Pending",
	running: "Running",
	completed: "Completed",
	failed: "Failed",
	cancelled: "Cancelled",
	skipped: "Skipped",
	throttled: "Throttled",
	delayed: "Delayed",
	expired: "Expired",
	debounced: "Debounced",
	queued: "Queued",
	crashed: "Crashed",
	timedOut: "Timed Out",
};

export const TIMELINE_BAR_COLORS: Record<NodeRunStatus, string> = {
	pending: "bg-zinc-600",
	running: "bg-blue-500",
	completed: "bg-green-500",
	failed: "bg-red-500",
	skipped: "bg-zinc-600",
};

export const EVENT_LABELS: Record<RunEventType, string> = {
	RUN_STARTED: "Run Started",
	RUN_COMPLETED: "Run Completed",
	RUN_FAILED: "Run Failed",
	NODE_STARTED: "Node Started",
	NODE_COMPLETED: "Node Completed",
	NODE_FAILED: "Node Failed",
	NODE_SKIPPED: "Node Skipped",
	VARS_UPDATED: "Vars Updated",
	LOG_ENTRY: "Log Entry",
	NODE_PROGRESS: "Node Progress",
	NODE_PARTIAL_RESULT: "Node Partial Result",
	NODE_CACHED: "Node Cached",
	NODE_ATTEMPT_FAILED: "Attempt Failed",
	RUN_THROTTLED: "Run Throttled",
	RUN_DELAYED: "Run Delayed",
	RUN_EXPIRED: "Run Expired",
	RUN_DEBOUNCED: "Run Debounced",
	RUN_QUEUED: "Run Queued",
	RUN_CRASHED: "Run Crashed",
	RUN_TIMED_OUT: "Run Timed Out",
};

export const EVENT_COLORS: Record<RunEventType, string> = {
	RUN_STARTED: "text-blue-400 bg-blue-400/10",
	RUN_COMPLETED: "text-green-400 bg-green-400/10",
	RUN_FAILED: "text-red-400 bg-red-400/10",
	NODE_STARTED: "text-blue-300 bg-blue-300/10",
	NODE_COMPLETED: "text-green-300 bg-green-300/10",
	NODE_FAILED: "text-red-300 bg-red-300/10",
	NODE_SKIPPED: "text-zinc-400 bg-zinc-400/10",
	VARS_UPDATED: "text-yellow-400 bg-yellow-400/10",
	LOG_ENTRY: "text-zinc-300 bg-zinc-300/10",
	NODE_PROGRESS: "text-cyan-400 bg-cyan-400/10",
	NODE_PARTIAL_RESULT: "text-cyan-300 bg-cyan-300/10",
	NODE_CACHED: "text-emerald-400 bg-emerald-400/10",
	NODE_ATTEMPT_FAILED: "text-amber-400 bg-amber-400/10",
	RUN_THROTTLED: "text-amber-300 bg-amber-300/10",
	RUN_DELAYED: "text-yellow-400 bg-yellow-400/10",
	RUN_EXPIRED: "text-zinc-500 bg-zinc-500/10",
	RUN_DEBOUNCED: "text-cyan-400 bg-cyan-400/10",
	RUN_QUEUED: "text-lime-300 bg-lime-300/10",
	RUN_CRASHED: "text-red-500 bg-red-500/10",
	RUN_TIMED_OUT: "text-orange-400 bg-orange-400/10",
};

export const LOG_LEVEL_COLORS = {
	debug: "text-zinc-400",
	info: "text-blue-400",
	warn: "text-amber-400",
	error: "text-red-400",
} as const;

export const TRIGGER_ICONS: Record<string, string> = {
	http: "Globe",
	cron: "Clock",
	queue: "ListOrdered",
	worker: "Cpu",
	websocket: "Radio",
	sse: "Radio",
	webhook: "Webhook",
};
