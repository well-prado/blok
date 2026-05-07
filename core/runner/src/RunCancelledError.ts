/**
 * Tier 2 follow-up · thrown by `RunnerSteps` between steps when the
 * run's `ctx.signal.aborted` flips to true (typically because an
 * operator called `POST /__blok/runs/:runId/cancel` on a `running`
 * run).
 *
 * Distinct from `Error` so `TriggerBase.run`'s catch block can:
 * - Skip `failRun` (status is already `"cancelled"` via the
 *   tracker's `abortRunningRun` flow).
 * - Re-throw so transport layers can surface the cancellation
 *   appropriately (HTTP 499 / Worker ACK).
 */
export class RunCancelledError extends Error {
	readonly runId?: string;

	constructor(runId?: string, message?: string) {
		super(message ?? `Run ${runId ?? "(unknown)"} cancelled via AbortSignal`);
		this.name = "RunCancelledError";
		this.runId = runId;
		Object.setPrototypeOf(this, RunCancelledError.prototype);
	}
}

export function isRunCancelledError(err: unknown): err is RunCancelledError {
	return err instanceof RunCancelledError;
}
