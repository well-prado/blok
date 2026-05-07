/**
 * PR 1-5 polish · thrown by `TriggerBase.run()` when a queued run's
 * `concurrencyQueueTimeoutMs` (PR 5 B2) has elapsed before the gate granted
 * a slot.
 *
 * Distinct from `ConcurrencyLimitError`: a TTL-expired queued run will NEVER
 * succeed (the timer won't re-fire). Conflating it with a transient denial
 * misleads HTTP clients into retrying — the queued run is permanently dead,
 * so the only correct response is `410 Gone`.
 *
 * Triggers catch this and translate:
 * - HTTP trigger → `410 Gone` with structured body (no `Retry-After` — it
 *   would contradict the 410 contract).
 * - Worker trigger → ACK without retry (the in-process scheduler owns the
 *   eventual dispatch and won't reschedule an expired run).
 *
 * The run record itself is already flipped to `expired` by
 * `tracker.markRunExpired` before this error is thrown, so observability
 * surfaces (Studio status badge, `RUN_EXPIRED` event) are independent of
 * the transport-level response.
 */
export interface QueueExpiredInfo {
	/** Workflow name whose queue TTL elapsed. */
	workflowName: string;
	/** Resolved key value (after evaluating the `concurrencyKey` expression). */
	concurrencyKey: string;
	/**
	 * The deadline that was breached (ms since epoch). The run was queued
	 * with `expiresAt = scheduledAt + concurrencyQueueTimeoutMs` and the
	 * dispatcher observed `now > expiresAt`.
	 */
	queueExpiredAt: number;
	/** Run id allocated by the tracer; flipped to `expired` before throw. */
	runId: string;
}

export class QueueExpiredError extends Error {
	public readonly info: QueueExpiredInfo;

	constructor(info: QueueExpiredInfo) {
		super(
			`Queued run expired for workflow '${info.workflowName}' (key='${info.concurrencyKey}', ` +
				`queueExpiredAt=${info.queueExpiredAt}). Run will not be retried.`,
		);
		this.name = "QueueExpiredError";
		this.info = info;
		// Restore prototype chain when extending Error in transpiled code.
		Object.setPrototypeOf(this, QueueExpiredError.prototype);
	}
}

export function isQueueExpiredError(err: unknown): err is QueueExpiredError {
	return err instanceof QueueExpiredError;
}
