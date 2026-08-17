import type { NodeRunStatus, RunEventType, WorkflowRunStatus } from "@/types";

// Status color lives in exactly ONE place: the `--color-status-*` tokens in
// `app.css`. These maps used to be a third, disagreeing vocabulary (raw
// `text-green-400` here, `#2bcd71` in the token layer, `#22c55e` in the chart
// code). The `Record<WorkflowRunStatus | NodeRunStatus, string>` type keeps
// them exhaustive, so a new status is a typecheck error, not a blank chip.
//
// Chip = `-ink` for the label, the plain fill at 10% for the wash. The two
// roles are separate tokens on purpose (app.css layer 3): the fill is sized
// for a 6px dot, the ink for 12px text. Every pair here is asserted >= 4.5:1
// in `src/__tests__/tokens.test.ts`.
export const STATUS_COLORS: Record<WorkflowRunStatus | NodeRunStatus, string> = {
	pending: "text-status-pending-ink bg-status-pending/10",
	running: "text-status-running-ink bg-status-running/10",
	paused: "text-status-paused-ink bg-status-paused/10",
	completed: "text-status-completed-ink bg-status-completed/10",
	failed: "text-status-failed-ink bg-status-failed/10",
	cancelled: "text-status-cancelled-ink bg-status-cancelled/10",
	skipped: "text-status-skipped-ink bg-status-skipped/10",
	throttled: "text-status-throttled-ink bg-status-throttled/10",
	delayed: "text-status-delayed-ink bg-status-delayed/10",
	expired: "text-status-expired-ink bg-status-expired/10",
	debounced: "text-status-debounced-ink bg-status-debounced/10",
	queued: "text-status-queued-ink bg-status-queued/10",
	crashed: "text-status-crashed-ink bg-status-crashed/10",
	timedOut: "text-status-timedOut-ink bg-status-timedOut/10",
};

export const STATUS_DOT_COLORS: Record<WorkflowRunStatus | NodeRunStatus, string> = {
	pending: "bg-status-pending",
	running: "bg-status-running",
	paused: "bg-status-paused",
	completed: "bg-status-completed",
	failed: "bg-status-failed",
	cancelled: "bg-status-cancelled",
	skipped: "bg-status-skipped",
	throttled: "bg-status-throttled",
	delayed: "bg-status-delayed",
	expired: "bg-status-expired",
	debounced: "bg-status-debounced",
	queued: "bg-status-queued",
	crashed: "bg-status-crashed",
	timedOut: "bg-status-timedOut",
};

export const STATUS_LABELS: Record<WorkflowRunStatus | NodeRunStatus, string> = {
	pending: "Pending",
	running: "Running",
	paused: "Paused",
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
	RUN_PAUSED: "Run Paused",
	RUN_RESUMED: "Run Resumed",
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
	RUN_CANCELLED: "Run Cancelled",
	RUN_CRASHED: "Run Crashed",
	RUN_TIMED_OUT: "Run Timed Out",
	BROWSER_SESSION_OPENED: "Browser Opened",
	BROWSER_PAGE_UPDATED: "Browser Page Updated",
	BROWSER_ACTION: "Browser Action",
	BROWSER_ARTIFACT: "Browser Artifact",
	BROWSER_SESSION_CLOSED: "Browser Closed",
};

export const EVENT_COLORS: Record<RunEventType, string> = {
	RUN_STARTED: "text-blue-400 bg-blue-400/10",
	RUN_PAUSED: "text-amber-300 bg-amber-300/10",
	RUN_RESUMED: "text-blue-400 bg-blue-400/10",
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
	RUN_CANCELLED: "text-purple-400 bg-purple-400/10",
	RUN_CRASHED: "text-red-500 bg-red-500/10",
	RUN_TIMED_OUT: "text-orange-400 bg-orange-400/10",
	BROWSER_SESSION_OPENED: "text-sky-400 bg-sky-400/10",
	BROWSER_PAGE_UPDATED: "text-sky-300 bg-sky-300/10",
	BROWSER_ACTION: "text-cyan-400 bg-cyan-400/10",
	BROWSER_ARTIFACT: "text-violet-400 bg-violet-400/10",
	BROWSER_SESSION_CLOSED: "text-zinc-400 bg-zinc-400/10",
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
