/**
 * Tier 2 #5 + #7 — thrown by `TriggerBase.run()` when a workflow's
 * scheduling gates (debounce / delay) defer the run to a future
 * dispatch. Tier 2 #6 follow-up extends this to cover `onLimit:"queue"`
 * (concurrency-gate-deferred runs); same transport translation.
 *
 * NOT a true error — a control-flow exception. Trigger transports
 * catch it and translate it into the appropriate transport-level
 * response:
 *
 * - HTTP trigger → `202 Accepted` with `Location: /__blok/runs/:id`
 *   header and structured JSON body.
 * - Worker trigger → ACK without retry (the deferred coordinator owns
 *   the eventual dispatch).
 *
 * Carries the run-detail summary the transport needs to populate the
 * response.
 */
export interface DeferredDispatchInfo {
	/** Run id allocated by the tracer when the run was created. */
	runId: string;
	/** Workflow name. */
	workflowName: string;
	/**
	 * Resolved status the run was placed in:
	 * - `"delayed"` — Tier 2 #5 (`trigger.delay`).
	 * - `"debounced"` — Tier 2 #7 (`trigger.debounce`).
	 * - `"queued"` — Tier 2 #6 follow-up (`trigger.onLimit:"queue"`).
	 */
	status: "delayed" | "debounced" | "queued";
	/** ms since epoch when the run is scheduled to dispatch. */
	scheduledAt: number;
	/** ms since epoch when the run will expire if not dispatched. Undefined when no TTL. */
	expiresAt?: number;
	/** True when the run was placed in `"debounced"` status (Tier 2 #7). */
	debounced: boolean;
	/** Pings absorbed by the run so far (always 1+). */
	pingCount: number;
	/**
	 * For leading-mode debounce, the runId of the sibling that fired
	 * immediately. Lets transports return `Location: /__blok/runs/<sibling>`
	 * so the caller can poll the actually-running run.
	 */
	intoRunId?: string;
}

export class DeferredDispatchSignal extends Error {
	public readonly info: DeferredDispatchInfo;

	constructor(info: DeferredDispatchInfo) {
		super(
			`Run ${info.runId} for workflow '${info.workflowName}' was deferred ` +
				`(${info.status}; scheduledAt=${info.scheduledAt}; pingCount=${info.pingCount}).`,
		);
		this.name = "DeferredDispatchSignal";
		this.info = info;
		Object.setPrototypeOf(this, DeferredDispatchSignal.prototype);
	}
}

export function isDeferredDispatchSignal(err: unknown): err is DeferredDispatchSignal {
	return err instanceof DeferredDispatchSignal;
}
