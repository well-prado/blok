/**
 * Tier 2 #7 — debounce coordinator. Tier C #1 — cross-process awareness.
 *
 * Coalesces rapid same-key triggers into a single delayed run. Modes:
 *
 * - `"trailing"` (default): each ping resets a timer; the run fires
 *   after `delayMs` of silence. Latest payload wins (within a single
 *   owning process). `maxDelayMs` bounds tail latency — even with
 *   continuous pings, the run fires after `maxDelayMs` from the FIRST
 *   ping.
 * - `"leading"`: the first ping fires immediately. Subsequent pings
 *   within `delayMs` are dropped. Window resets after `delayMs` of
 *   silence.
 *
 * Process-wide singleton. **Default**: in-memory only — fast,
 * synchronous internally. **Cross-process mode (Tier C #1)**: install a
 * `DebounceBackend` via `setBackend()` and the coordinator routes
 * register/cancel through the backend with the same outcome surface,
 * keeping a local timer + closure for the OWNING process. The
 * `register()` API is async — callers must `await` it.
 *
 * Latest-payload semantics in cross-process mode: **owner-local**.
 * Pings from a non-owning process bump pingCount + push scheduledAt in
 * the shared doc but do NOT contribute their payload — only the
 * owning process's captured `onFire` closure fires. Cross-process
 * latest-payload-wins is deferred (would require persisting each
 * ping's payload to the shared doc; tracked in BACKLOG).
 */

import { randomUUID } from "node:crypto";
import type { DebounceBackend } from "./DebounceBackend";

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

const DEFAULT_OWNER_LEASE_MS = 60_000;

export class DebounceCoordinator {
	private static instance: DebounceCoordinator | null = null;

	private states: Map<string, DebounceState> = new Map();
	private backend: DebounceBackend | null = null;
	/** Process identity for cross-process owner-lease attribution. Stable for the lifetime of the singleton. */
	private readonly processId: string = randomUUID();
	private ownerLeaseMs: number = DEFAULT_OWNER_LEASE_MS;

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

	/**
	 * Install a cross-process backend. Set via `HttpTrigger.listen()` /
	 * `WorkerTrigger.listen()` when `BLOK_DEBOUNCE_BACKEND` is configured.
	 * Pass `null` to revert to the in-memory fast path.
	 */
	setBackend(backend: DebounceBackend | null): void {
		this.backend = backend;
	}

	getBackend(): DebounceBackend | null {
		return this.backend;
	}

	/**
	 * Override the owner-lease duration. Used by `HttpTrigger.listen()` /
	 * `WorkerTrigger.listen()` to apply `BLOK_DEBOUNCE_OWNER_LEASE_MS`.
	 */
	setOwnerLeaseMs(ms: number): void {
		if (Number.isFinite(ms) && ms > 0) {
			this.ownerLeaseMs = ms;
		}
	}

	private bucket(workflowName: string, debounceKey: string): string {
		return `${workflowName}\x1f${debounceKey}`;
	}

	async register(opts: DebounceRegisterOpts): Promise<DebounceRegisterResult> {
		if (this.backend) {
			return this.registerCrossProcess(opts);
		}
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

	/**
	 * Cross-process path — delegates ownership to the backend and uses
	 * a local timer + closure for the OWNING process.
	 *
	 * Three outcomes from the backend:
	 *  - `owner-new`: this process is the new owner. Start a local timer
	 *    + closure; on fire, atomically finalize via the backend.
	 *  - `owner-extend`: this process is already the owner. Cancel +
	 *    restart the local timer at the new scheduledAt; refresh closure.
	 *  - `coalesce`: another process owns the window. Just return.
	 *
	 * Leading mode: `owner-new` translates to `fire-immediate` (caller
	 * fires synchronously); `owner-extend`/`coalesce` translate to
	 * `coalesce`.
	 */
	private async registerCrossProcess(opts: DebounceRegisterOpts): Promise<DebounceRegisterResult> {
		const backend = this.backend;
		if (!backend) return this.registerLocal(opts);

		const now = opts.__now ?? Date.now();
		const bucketKey = this.bucket(opts.workflowName, opts.debounceKey);

		let res: Awaited<ReturnType<DebounceBackend["registerPing"]>>;
		try {
			res = await backend.registerPing({
				workflowName: opts.workflowName,
				debounceKey: opts.debounceKey,
				mode: opts.mode,
				delayMs: opts.delayMs,
				maxDelayMs: opts.maxDelayMs,
				runId: opts.runId,
				processId: this.processId,
				ownerLeaseMs: this.ownerLeaseMs,
				now,
			});
		} catch (err) {
			// Fail-open — fall back to local in-memory window. Same posture
			// as the concurrency-backend fail-fast path (deny-on-error) but
			// debounce isn't a safety gate — better to admit the ping than
			// drop it on a transient broker outage.
			console.warn(
				`[blok][scheduling] debounce backend registerPing failed for ${bucketKey}: ${err instanceof Error ? err.message : String(err)}; falling back to in-memory window`,
			);
			return this.registerLocal(opts);
		}

		// === Leading mode ===
		if (opts.mode === "leading") {
			if (res.outcome === "owner-new") {
				// Caller fires synchronously; we don't keep a local timer for
				// leading mode (the backend's owner-lease IS the window).
				return { outcome: "fire-immediate", activeRunId: opts.runId, pingCount: res.pingCount };
			}
			return { outcome: "coalesce", activeRunId: res.activeRunId, pingCount: res.pingCount };
		}

		// === Trailing mode ===
		if (res.outcome === "owner-new") {
			// New trailing window owned by this process. Capture the closure +
			// start a local timer to fire at backend-decided scheduledAt.
			this.installOwnerTimer(bucketKey, opts, res.scheduledAt, now);
			return {
				outcome: "schedule-trailing",
				activeRunId: opts.runId,
				scheduledAt: res.scheduledAt,
				pingCount: res.pingCount,
			};
		}

		if (res.outcome === "owner-extend") {
			// We still own. Replace the captured closure (latest payload
			// wins within this process) + reschedule.
			this.installOwnerTimer(bucketKey, opts, res.scheduledAt, now);
			return {
				outcome: "coalesce",
				activeRunId: res.activeRunId,
				scheduledAt: res.scheduledAt,
				pingCount: res.pingCount,
			};
		}

		// outcome === "coalesce" — another process owns. Do not install a
		// local timer; the owning process drives the fire.
		return {
			outcome: "coalesce",
			activeRunId: res.activeRunId,
			scheduledAt: res.scheduledAt,
			pingCount: res.pingCount,
		};
	}

	private installOwnerTimer(bucketKey: string, opts: DebounceRegisterOpts, scheduledAt: number, now: number): void {
		const existing = this.states.get(bucketKey);
		if (existing?.timer) clearTimeout(existing.timer);

		const state: DebounceState = {
			bucketKey,
			mode: opts.mode,
			delayMs: opts.delayMs,
			maxDelayMs: opts.maxDelayMs,
			firstPingAt: existing?.firstPingAt ?? now,
			lastPingAt: now,
			pingCount: (existing?.pingCount ?? 0) + 1,
			activeRunId: opts.runId,
			maxDelayDeadline:
				existing?.maxDelayDeadline ?? (opts.maxDelayMs !== undefined ? now + opts.maxDelayMs : undefined),
			onFire: opts.onFire,
		};
		const wait = Math.max(0, scheduledAt - now);
		state.timer = setTimeout(() => {
			void this.fireTrailingCrossProcess(bucketKey, opts.workflowName, opts.debounceKey, opts.runId);
		}, wait);
		this.states.set(bucketKey, state);
	}

	private async fireTrailingCrossProcess(
		bucketKey: string,
		workflowName: string,
		debounceKey: string,
		runId: string,
	): Promise<void> {
		const backend = this.backend;
		const state = this.states.get(bucketKey);
		if (!backend || !state) return;

		const now = Date.now();
		let result: Awaited<ReturnType<DebounceBackend["finalize"]>>;
		try {
			result = await backend.finalize(workflowName, debounceKey, runId, now);
		} catch (err) {
			// Treat as abandoned — owner-lease will eventually expire and
			// another process can take over. Don't fire to avoid duplicate
			// dispatch.
			console.warn(
				`[blok][scheduling] debounce backend finalize failed for ${bucketKey}: ${err instanceof Error ? err.message : String(err)}; abandoning local owner state`,
			);
			this.states.delete(bucketKey);
			return;
		}

		if (result.finalize === "fire") {
			this.states.delete(bucketKey);
			if (state.onFire) {
				void state.onFire().catch((err: unknown) => {
					console.error(
						`[blok][scheduling] DebounceCoordinator cross-process fire failed for key ${bucketKey}:`,
						err instanceof Error ? err.stack || err.message : err,
					);
				});
			}
			return;
		}

		if (result.finalize === "reschedule") {
			// Coalesce pings from other processes pushed scheduledAt forward.
			// Reschedule local timer; closure stays.
			if (state.timer) clearTimeout(state.timer);
			const wait = Math.max(0, result.scheduledAt - now);
			state.timer = setTimeout(() => {
				void this.fireTrailingCrossProcess(bucketKey, workflowName, debounceKey, runId);
			}, wait);
			return;
		}

		// finalize === "abandoned" — lease expired; another process took
		// over. Drop the closure silently.
		this.states.delete(bucketKey);
	}

	/** Cancel an active window without firing. Returns true if cancelled. */
	async cancel(workflowName: string, debounceKey: string): Promise<boolean> {
		const bucketKey = this.bucket(workflowName, debounceKey);
		const state = this.states.get(bucketKey);
		if (state?.timer) clearTimeout(state.timer);
		const hadLocal = this.states.delete(bucketKey);

		if (this.backend) {
			try {
				const cancelled = await this.backend.cancel(workflowName, debounceKey);
				return cancelled || hadLocal;
			} catch (err) {
				console.warn(
					`[blok][scheduling] debounce backend cancel failed for ${bucketKey}: ${err instanceof Error ? err.message : String(err)}`,
				);
				return hadLocal;
			}
		}
		return hadLocal;
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
