/**
 * Tier 2 #6 — thrown by `TriggerBase.run()` when a workflow's concurrency
 * gate denies a run because the in-flight count for the resolved
 * `concurrencyKey` has reached `concurrencyLimit`.
 *
 * Triggers catch this and translate it into the appropriate transport-level
 * response:
 * - HTTP trigger → `429 Too Many Requests` with `Retry-After` header.
 * - Worker trigger → NACK with redelivery (existing job-queue retry handles
 *   spacing).
 *
 * Carries enough context for both observability (logs / Studio events) and
 * client-facing error payloads.
 */
export interface ConcurrencyLimitInfo {
	/** Workflow name whose gate fired. */
	workflowName: string;
	/** Resolved key value (after evaluating the `concurrencyKey` expression). */
	concurrencyKey: string;
	/** Per-key limit from the trigger config. */
	concurrencyLimit: number;
	/** Number of in-flight runs observed at the moment of denial. */
	currentInFlight: number;
	/**
	 * Suggested back-off in milliseconds before retrying. A heuristic — the
	 * gate doesn't observe a queue, so we recommend a minimum (the default
	 * matches the smallest meaningful HTTP `Retry-After` precision = 1s).
	 */
	retryAfterMs: number;
	/** Run id allocated by the tracer for this denied attempt. */
	runId: string;
}

export class ConcurrencyLimitError extends Error {
	public readonly info: ConcurrencyLimitInfo;

	constructor(info: ConcurrencyLimitInfo) {
		super(
			`Concurrency limit reached for workflow '${info.workflowName}' (key='${info.concurrencyKey}', ` +
				`limit=${info.concurrencyLimit}, currentInFlight=${info.currentInFlight}). ` +
				`Retry after ~${info.retryAfterMs}ms.`,
		);
		this.name = "ConcurrencyLimitError";
		this.info = info;
		// Restore prototype chain when extending Error in transpiled code.
		Object.setPrototypeOf(this, ConcurrencyLimitError.prototype);
	}
}

export function isConcurrencyLimitError(err: unknown): err is ConcurrencyLimitError {
	return err instanceof ConcurrencyLimitError;
}
