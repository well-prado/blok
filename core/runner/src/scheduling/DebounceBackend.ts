/**
 * Tier C #1 · Cross-process debounce backend interface.
 *
 * Mirrors the relationship between `ConcurrencyBackend` and the
 * `RunStore`-backed concurrency gate: an optional async capability that
 * lets `DebounceCoordinator` coordinate windows across processes
 * (NATS KV, Redis) instead of relying on the local in-memory Map.
 *
 * Default behavior is unchanged — when no backend is set, the
 * coordinator uses its existing in-memory state. The backend is opt-in
 * via `BLOK_DEBOUNCE_BACKEND={nats-kv|redis}` and installed by trigger
 * packages during `listen()`.
 *
 * **Semantic trade-off**: this v1 ships *owner-local payload*
 * semantics. The owning process's captured closure (`onFire`) fires
 * when its local timer elapses; payloads from coalesce pings on other
 * processes are dropped (the doc only records `pingCount`,
 * `lastPingAt`, and `scheduledAt`). Cross-process latest-payload-wins
 * is a deferred follow-up — would require persisting each ping's
 * payload to the shared doc.
 */

export type DebounceBackendMode = "leading" | "trailing";

export interface DebounceRegisterBackendOpts {
	workflowName: string;
	debounceKey: string;
	mode: DebounceBackendMode;
	delayMs: number;
	maxDelayMs?: number;
	/** Run id allocated by the caller for THIS ping. */
	runId: string;
	/** Process identity used for owner-lease attribution. */
	processId: string;
	/** Owner lease in ms — when expired, another process can take over. */
	ownerLeaseMs: number;
	/** Current wall-clock ms. */
	now: number;
}

/**
 * Result of a `registerPing`. Three outcomes, mirroring the
 * single-process `DebounceRegisterResult` shape:
 *
 * - `"owner-new"` — caller is the new owner of a fresh window.
 *   For leading mode: fire synchronously. For trailing mode: start a
 *   local timer to fire at `scheduledAt`.
 * - `"owner-extend"` — caller is the existing owner; window extended.
 *   Cancel + restart local timer to fire at the new `scheduledAt`.
 * - `"coalesce"` — caller is NOT the owner. Mark the run `debounced`
 *   with `intoRunId = activeRunId`.
 */
export interface DebounceRegisterBackendResult {
	outcome: "owner-new" | "owner-extend" | "coalesce";
	activeRunId: string;
	/** The runId of the OWNING process. Equal to opts.runId when outcome ∈ {owner-new, owner-extend}; differs on coalesce. */
	scheduledAt: number;
	pingCount: number;
}

/**
 * Result of a `finalize` call from an owning process's local timer.
 *
 * - `"fire"` — caller still owns AND the silence period elapsed.
 *   Bucket has been atomically DELETEd; caller dispatches.
 * - `"reschedule"` — caller still owns, but coalesce pings from other
 *   processes pushed `scheduledAt` forward. Caller restarts local
 *   timer for `scheduledAt - now`.
 * - `"abandoned"` — caller's lease expired and another process took
 *   ownership. Caller silently drops the closure.
 */
export type DebounceFinalizeResult =
	| { finalize: "fire" }
	| { finalize: "reschedule"; scheduledAt: number }
	| { finalize: "abandoned" };

export interface DebounceBackend {
	/** Identifying string for logs/metrics. e.g. `"nats-kv"`, `"redis"`. */
	readonly name: string;

	/** Lifecycle — open the underlying connection. Idempotent. */
	connect(): Promise<void>;

	/** Lifecycle — close the underlying connection. Idempotent. */
	disconnect(): Promise<void>;

	/**
	 * Atomically record a ping against the `(workflow, debounceKey)`
	 * bucket and decide ownership. Returns one of the three outcomes
	 * documented on {@link DebounceRegisterBackendResult}.
	 */
	registerPing(opts: DebounceRegisterBackendOpts): Promise<DebounceRegisterBackendResult>;

	/**
	 * Owner calls this on local timer fire. Atomically:
	 *  - If `runId` still owns AND `now >= scheduledAt` → DELETE the
	 *    bucket and return `{finalize: "fire"}`.
	 *  - If `runId` still owns but `now < scheduledAt` → return
	 *    `{finalize: "reschedule", scheduledAt}`.
	 *  - If `runId` no longer owns (lease expired + handoff) → return
	 *    `{finalize: "abandoned"}`.
	 */
	finalize(workflowName: string, debounceKey: string, runId: string, now: number): Promise<DebounceFinalizeResult>;

	/** Cancel an active window without firing. Returns true if cancelled. */
	cancel(workflowName: string, debounceKey: string): Promise<boolean>;

	/**
	 * Janitor sweep — purge every bucket whose owner lease expired
	 * AND whose `scheduledAt` is in the past. Returns the count of
	 * purged buckets. Cheap per-bucket lazy-purge happens inside the
	 * registerPing/finalize scripts.
	 */
	purgeExpired(now: number): Promise<number>;
}
