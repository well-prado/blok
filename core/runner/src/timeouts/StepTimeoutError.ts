/**
 * Tier 2 quick-wins — thrown by `RunnerSteps` when a step's
 * `step.process()` exceeds its `maxDuration` cap.
 *
 * The error participates in the existing retry loop: each retry
 * attempt wraps its own setTimeout-based timeout, so a step that
 * times out N times will trigger N retries (each capped at
 * `maxDuration`) before the run flips to `"timedOut"`.
 *
 * Note: setTimeout-based timeout REJECTS the wrapper promise but
 * doesn't truly abort the underlying async work — the
 * `step.process()` continues running until natural completion.
 * The parent runner has already moved on; the orphaned promise
 * resolves harmlessly into the void. Proper cooperative
 * cancellation via `AbortSignal` is a deferred follow-up.
 */
export class StepTimeoutError extends Error {
	public readonly stepName: string;
	public readonly maxDurationMs: number;

	constructor(stepName: string, maxDurationMs: number) {
		super(`Step '${stepName}' exceeded maxDuration of ${maxDurationMs}ms`);
		this.name = "StepTimeoutError";
		this.stepName = stepName;
		this.maxDurationMs = maxDurationMs;
		Object.setPrototypeOf(this, StepTimeoutError.prototype);
	}
}

export function isStepTimeoutError(err: unknown): err is StepTimeoutError {
	return err instanceof StepTimeoutError;
}
