/**
 * Tier 2 #6 — extract concurrency-key config from a workflow's trigger
 * block, regardless of which trigger type owns it (HTTP, Worker, …).
 *
 * Returns null when the trigger has no concurrency gate. The caller (a
 * `TriggerBase.run()` invocation) treats null as "skip the gate, run the
 * workflow normally" — zero-overhead default.
 *
 * Triggers that gain support for concurrency keys later only need to
 * appear in {@link CONCURRENCY_TRIGGER_KEYS}.
 */

/** Trigger types whose schema declares the `ConcurrencyOptsFields` mixin. */
const CONCURRENCY_TRIGGER_KEYS = ["http", "worker"] as const;

const DEFAULT_LIMIT = 1;
const DEFAULT_LEASE_MS = 60 * 60 * 1000;

/** Parsed, normalized concurrency config ready for the gate. */
export interface NormalizedConcurrencyConfig {
	/** The literal or `js/...` expression to resolve at run time. */
	keyExpression: string;
	/** Maximum concurrent runs per resolved key. */
	limit: number;
	/** Lease duration for the slot in milliseconds. */
	leaseMs: number;
	/**
	 * Behavior when the gate denies acquisition.
	 * - `"throw"` (default): emit `ConcurrencyLimitError` → HTTP 429 / Worker NACK.
	 * - `"queue"`: defer the run via `DeferredRunScheduler`, throw
	 *   `DeferredDispatchSignal` with status `"queued"`.
	 *
	 * Tier 2 #6 follow-up. Reuses the Tier 2 #5+#7 deferred-dispatch plumbing.
	 */
	onLimit: "throw" | "queue";
}

/**
 * Read a workflow's trigger config and return the normalized concurrency
 * gate configuration, or null when the workflow has no gate.
 *
 * Defaults are applied here:
 * - `concurrencyLimit` → `1` (Trigger.dev "named mutex per key" parity).
 * - `concurrencyLeaseMs` → 1 hour, override via `BLOK_CONCURRENCY_LEASE_MS`
 *   process-wide.
 */
export function readConcurrencyConfig(
	trigger: Record<string, unknown> | undefined | null,
): NormalizedConcurrencyConfig | null {
	if (!trigger) return null;

	for (const key of CONCURRENCY_TRIGGER_KEYS) {
		const cfg = trigger[key] as
			| {
					concurrencyKey?: unknown;
					concurrencyLimit?: unknown;
					concurrencyLeaseMs?: unknown;
					onLimit?: unknown;
			  }
			| undefined;
		if (!cfg) continue;

		const keyExpression = typeof cfg.concurrencyKey === "string" ? cfg.concurrencyKey.trim() : "";
		if (!keyExpression) continue;

		const limit = Number.isInteger(cfg.concurrencyLimit) ? (cfg.concurrencyLimit as number) : DEFAULT_LIMIT;

		const envLeaseRaw = process.env.BLOK_CONCURRENCY_LEASE_MS;
		const envLease = envLeaseRaw && /^\d+$/.test(envLeaseRaw) ? Number(envLeaseRaw) : null;
		const perTriggerLease = Number.isInteger(cfg.concurrencyLeaseMs) ? (cfg.concurrencyLeaseMs as number) : null;
		// Per-trigger value wins over env override; env wins over the hard default.
		const leaseMs = perTriggerLease ?? envLease ?? DEFAULT_LEASE_MS;

		// onLimit: only "throw" (default) and "queue" are valid; anything else
		// falls back to "throw" (defensive — schema already rejects bad values).
		const onLimit: "throw" | "queue" = cfg.onLimit === "queue" ? "queue" : "throw";

		return { keyExpression, limit, leaseMs, onLimit };
	}

	return null;
}

export const CONCURRENCY_DEFAULTS = {
	limit: DEFAULT_LIMIT,
	leaseMs: DEFAULT_LEASE_MS,
} as const;
