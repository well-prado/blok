/**
 * Tier 2 #7 — debounce coordinator.
 *
 * Coalesces rapid same-key triggers into a single delayed run. Modes:
 *
 * - `"trailing"` (default): each ping resets a timer; the run fires
 *   after `delayMs` of silence. Latest payload wins via the captured
 *   closure. `maxDelayMs` bounds tail latency — even with continuous
 *   pings, the run fires after `maxDelayMs` from the FIRST ping.
 * - `"leading"`: the first ping fires immediately. Subsequent pings
 *   within `delayMs` are dropped. Window resets after `delayMs` of
 *   silence.
 *
 * Process-wide singleton. In-memory only — fast, synchronous internally.
 * The `register()` API is async so callers don't need to discriminate,
 * but the coordinator always uses the local in-memory fast path.
 */

export type DebounceDispatchFn = () => Promise<void>;

export type DebounceMode = "leading" | "trailing";

export interface DebounceRegisterOpts {
	workflowName: string;
	debounceKey: string;
	mode: DebounceMode;
	delayMs: number;
	maxDelayMs?: number;
	/**
	 * Run id allocated by the caller for THIS ping. On a fresh window
	 * this becomes the active run id; on a coalesce it's a "loser" and
	 * the caller marks it `debounced` terminal.
	 */
	runId: string;
	/**
	 * Callback the coordinator invokes when the trailing-mode window
	 * closes. Captures ctx + runId via closure. NOT called for leading
	 * mode (the caller runs the first ping synchronously) or for
	 * coalesce pings (those are dropped by definition).
	 */
	onFire: DebounceDispatchFn;
	/**
	 * Test-only override of "now" for deterministic tests. Production
	 * code does not pass this.
	 */
	__now?: number;
}

/**
 * The outcome of `register`. Branches the caller's behavior.
 *
 * - `"fire-immediate"` (leading + fresh window) — caller runs the
 *   workflow synchronously. The window is now open; subsequent pings
 *   in `delayMs` are suppressed.
 * - `"schedule-trailing"` (trailing + fresh window) — caller marks the
 *   run `debounced` (transient) and throws `DeferredDispatchSignal`.
 *   The coordinator's timer will invoke `onFire` after the window.
 * - `"coalesce"` (leading or trailing + existing window) — caller marks
 *   the run `debounced` (terminal, with `intoRunId = activeRunId`) and
 *   throws `DeferredDispatchSignal`. The active run absorbs the ping.
 */
export interface DebounceRegisterResult {
	outcome: "fire-immediate" | "schedule-trailing" | "coalesce";
	/**
	 * The runId of the run that owns the active window. Equal to
	 * `opts.runId` on `fire-immediate` and `schedule-trailing`; equal to
	 * the EXISTING window's runId on `coalesce` (so the caller knows
	 * which run absorbed the ping).
	 */
	activeRunId: string;
	/** Dispatch time for trailing windows; undefined on `fire-immediate`. */
	scheduledAt?: number;
	/** Pings absorbed by the active window so far (including this one). */
	pingCount: number;
}

interface DebounceState {
	bucketKey: string;
	mode: DebounceMode;
	delayMs: number;
	maxDelayMs?: number;
	firstPingAt: number;
	lastPingAt: number;
	pingCount: number;
	/** runId of the active window's run. Source of truth for coalesce attribution. */
	activeRunId: string;
	/** Trailing-only — current setTimeout handle. */
	timer?: NodeJS.Timeout;
	/** Trailing-only — `firstPingAt + maxDelayMs` (when set). */
	maxDelayDeadline?: number;
	/** Trailing-only — captured dispatch fn (latest payload via closure). */
	onFire?: DebounceDispatchFn;
}

export class DebounceCoordinator {
	private static instance: DebounceCoordinator | null = null;

	private states: Map<string, DebounceState> = new Map();

	static getInstance(): DebounceCoordinator {
		if (!DebounceCoordinator.instance) {
			DebounceCoordinator.instance = new DebounceCoordinator();
		}
		return DebounceCoordinator.instance;
	}

	/** Test-only — reset the singleton + clear all state. */
	static resetInstance(): void {
		DebounceCoordinator.instance?.clear();
		DebounceCoordinator.instance = null;
	}

	private bucket(workflowName: string, debounceKey: string): string {
		return `${workflowName}\x1f${debounceKey}`;
	}

	async register(opts: DebounceRegisterOpts): Promise<DebounceRegisterResult> {
		return this.registerLocal(opts);
	}

	/**
	 * In-memory fast path — preserved exactly from the v1 single-process
	 * implementation. Synchronous internally; the outer signature is
	 * async so callers don't need to discriminate.
	 */
	private registerLocal(opts: DebounceRegisterOpts): DebounceRegisterResult {
		const now = opts.__now ?? Date.now();
		const bucketKey = this.bucket(opts.workflowName, opts.debounceKey);
		const existing = this.states.get(bucketKey);

		// === Leading mode ===
		if (opts.mode === "leading") {
			if (existing) {
				// Window active — coalesce this ping (drop the run).
				existing.pingCount += 1;
				existing.lastPingAt = now;
				return {
					outcome: "coalesce",
					activeRunId: existing.activeRunId,
					pingCount: existing.pingCount,
				};
			}
			// Open a new window. Caller fires synchronously; coordinator just
			// tracks state to suppress follow-ups for `delayMs`.
			const state: DebounceState = {
				bucketKey,
				mode: "leading",
				delayMs: opts.delayMs,
				maxDelayMs: opts.maxDelayMs,
				firstPingAt: now,
				lastPingAt: now,
				pingCount: 1,
				activeRunId: opts.runId,
			};
			// Auto-close the window after delayMs of silence — clear state so
			// subsequent pings start fresh.
			state.timer = setTimeout(() => {
				const cur = this.states.get(bucketKey);
				if (cur && cur.lastPingAt + opts.delayMs <= Date.now()) {
					this.states.delete(bucketKey);
				}
			}, opts.delayMs);
			this.states.set(bucketKey, state);
			return { outcome: "fire-immediate", activeRunId: opts.runId, pingCount: 1 };
		}

		// === Trailing mode ===
		if (existing) {
			// Extend the window: cancel the old timer, set a new one. Latest
			// payload wins via the captured `onFire`.
			if (existing.timer) clearTimeout(existing.timer);
			existing.pingCount += 1;
			existing.lastPingAt = now;
			existing.onFire = opts.onFire;

			const naiveDeadline = now + opts.delayMs;
			const dispatchAt =
				existing.maxDelayDeadline !== undefined ? Math.min(naiveDeadline, existing.maxDelayDeadline) : naiveDeadline;
			const wait = Math.max(0, dispatchAt - now);
			existing.timer = setTimeout(() => this.fireTrailingLocal(bucketKey), wait);
			return {
				outcome: "coalesce",
				activeRunId: existing.activeRunId,
				scheduledAt: dispatchAt,
				pingCount: existing.pingCount,
			};
		}

		// New trailing window.
		const state: DebounceState = {
			bucketKey,
			mode: "trailing",
			delayMs: opts.delayMs,
			maxDelayMs: opts.maxDelayMs,
			firstPingAt: now,
			lastPingAt: now,
			pingCount: 1,
			activeRunId: opts.runId,
			maxDelayDeadline: opts.maxDelayMs !== undefined ? now + opts.maxDelayMs : undefined,
			onFire: opts.onFire,
		};
		const naiveDeadline = now + opts.delayMs;
		const dispatchAt =
			state.maxDelayDeadline !== undefined ? Math.min(naiveDeadline, state.maxDelayDeadline) : naiveDeadline;
		const wait = Math.max(0, dispatchAt - now);
		state.timer = setTimeout(() => this.fireTrailingLocal(bucketKey), wait);
		this.states.set(bucketKey, state);
		return {
			outcome: "schedule-trailing",
			activeRunId: opts.runId,
			scheduledAt: dispatchAt,
			pingCount: 1,
		};
	}

	private fireTrailingLocal(bucketKey: string): void {
		const state = this.states.get(bucketKey);
		if (!state) return;
		this.states.delete(bucketKey);
		if (state.onFire) {
			void state.onFire().catch((err: unknown) => {
				console.error(
					`[blok][scheduling] DebounceCoordinator trailing-fire failed for key ${bucketKey}:`,
					err instanceof Error ? err.stack || err.message : err,
				);
			});
		}
	}

	/** Cancel an active window without firing. Returns true if cancelled. */
	async cancel(workflowName: string, debounceKey: string): Promise<boolean> {
		const bucketKey = this.bucket(workflowName, debounceKey);
		const state = this.states.get(bucketKey);
		if (state?.timer) clearTimeout(state.timer);
		return this.states.delete(bucketKey);
	}

	/** Number of active LOCAL debounce windows. Tests + observability. Excludes cross-process windows owned by other processes. */
	size(): number {
		return this.states.size;
	}

	/** True if THIS process has a local window for `(workflow, key)`. Excludes windows owned by other processes. */
	has(workflowName: string, debounceKey: string): boolean {
		return this.states.has(this.bucket(workflowName, debounceKey));
	}

	/** Cancel everything without firing. Local state only — cross-process buckets fall back to lease-expiry. */
	clear(): void {
		for (const state of this.states.values()) {
			if (state.timer) clearTimeout(state.timer);
		}
		this.states.clear();
	}
}
