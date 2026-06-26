import type { RunEvent, WorkflowRunStatus } from "@/types";

/**
 * Pure mappings from run events to UI state — extracted so they're unit-testable
 * without rendering the hooks. `useRunDetail` uses the status maps; `useGlobalStream`
 * uses `notificationForRunEvent`.
 *
 * TERMINAL events finish the run (set finishedAt). TRANSIENT events (queued /
 * delayed) set the status but the run is NOT done — finishedAt stays unset.
 */
export const TERMINAL_RUN_EVENT_STATUS: Partial<Record<RunEvent["type"], WorkflowRunStatus>> = {
	RUN_COMPLETED: "completed",
	RUN_FAILED: "failed",
	RUN_CRASHED: "crashed",
	RUN_TIMED_OUT: "timedOut",
	RUN_THROTTLED: "throttled",
	RUN_CANCELLED: "cancelled",
	RUN_EXPIRED: "expired",
};

export const TRANSIENT_RUN_EVENT_STATUS: Partial<Record<RunEvent["type"], WorkflowRunStatus>> = {
	RUN_QUEUED: "queued",
	RUN_DELAYED: "delayed",
};

export interface RunToast {
	type: "success" | "error" | "info";
	title: string;
	message: string;
}

/** Human-friendly duration. */
export function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The toast for a run event, or `null` for events that shouldn't notify. Uses
 * the existing success/error/info types (no new toast style): completed →
 * success; failed/crashed/timedOut → error (the title distinguishes them);
 * cancelled → info (an operator action, not a failure).
 */
export function notificationForRunEvent(event: RunEvent): RunToast | null {
	const wf = event.workflowName;
	const payload = event.payload as { durationMs?: number; error?: { message?: string } } | undefined;
	const errMsg = payload?.error?.message;

	switch (event.type) {
		case "RUN_COMPLETED":
			return {
				type: "success",
				title: `${wf} completed`,
				message: payload?.durationMs ? `Finished in ${formatMs(payload.durationMs)}` : "Run completed successfully",
			};
		case "RUN_FAILED":
			return { type: "error", title: `${wf} failed`, message: errMsg || "Run failed with an error" };
		case "RUN_CRASHED":
			return {
				type: "error",
				title: `${wf} crashed`,
				message: errMsg || "Process crashed (uncaught error / OOM / signal)",
			};
		case "RUN_TIMED_OUT":
			return { type: "error", title: `${wf} timed out`, message: "A step exceeded its maxDuration" };
		case "RUN_CANCELLED":
			return { type: "info", title: `${wf} cancelled`, message: "Run was cancelled" };
		default:
			return null;
	}
}
