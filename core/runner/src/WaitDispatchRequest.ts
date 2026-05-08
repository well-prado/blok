/**
 * PR 4 · `wait.for(duration)` / `wait.until(date)` step primitive.
 *
 * Thrown by `RunnerSteps` when a wait step is reached on its first
 * pass. Carries the resolved deadline + step index so `TriggerBase.run`
 * can:
 *   1. Mark the run as `delayed` with the wait's `scheduledAt` field.
 *   2. Persist the dispatch to `scheduled_dispatches` (durable scheduler).
 *   3. Register a timer via `DeferredRunScheduler.schedule(...)`.
 *   4. Throw `DeferredDispatchSignal` so the HTTP transport returns 202.
 *
 * Distinct from `DeferredDispatchSignal` because:
 *   - DDS is throw at the trigger gate (no step has run yet).
 *   - WaitDispatchRequest is thrown mid-workflow (steps 1..N-1 done).
 *
 * The `lastCompletedStepIndex` field is the resume cursor — the runner
 * sets it just before throwing so `dispatchDeferred` re-entry can skip
 * past completed pre-wait steps.
 */
export interface WaitDispatchInfo {
	/** Resolved deadline in ms-since-epoch. */
	scheduledAt: number;
	/** Step index of the wait in the workflow's steps array. */
	stepIndex: number;
	/** Step id of the wait (for logging + diagnostics). */
	stepId: string;
	/**
	 * Resume cursor. The runner sets this to `stepIndex - 1` (or the
	 * highest non-wait step it completed) so re-entry skips already-
	 * done pre-wait steps. Persisted onto `WorkflowRun.lastCompletedStepIndex`.
	 */
	lastCompletedStepIndex: number;
}

export class WaitDispatchRequest extends Error {
	readonly info: WaitDispatchInfo;

	constructor(info: WaitDispatchInfo) {
		super(
			`Wait step "${info.stepId}" requesting deferred dispatch at scheduledAt=${info.scheduledAt} (resume cursor: ${info.lastCompletedStepIndex}).`,
		);
		this.name = "WaitDispatchRequest";
		this.info = info;
		Object.setPrototypeOf(this, WaitDispatchRequest.prototype);
	}
}

export function isWaitDispatchRequest(err: unknown): err is WaitDispatchRequest {
	return err instanceof WaitDispatchRequest;
}
