/**
 * Tier 2 #5 — in-memory scheduler for deferred workflow runs. Tier 2
 * #5+#7 follow-up adds optional sqlite-backed durability via the
 * {@link DeferredScheduleOptions.persist} parameter.
 *
 * Process-wide singleton; obtained via {@link DeferredRunScheduler.getInstance}.
 * Reset between tests via {@link DeferredRunScheduler.resetInstance}.
 */
import { RunTracker } from "../tracing/RunTracker";
import type { ScheduledDispatchRow } from "../tracing/types";

export type DeferredDispatchFn = () => Promise<void>;

interface ScheduledEntry {
	runId: string;
	dispatchAt: number;
	timer: NodeJS.Timeout;
	dispatchFn: DeferredDispatchFn;
	/** When set, persistence cleanup runs on cancel/fire. */
	persisted: boolean;
}

/**
 * Optional persistence payload — when supplied to `schedule()`, the
 * scheduler writes a `scheduled_dispatches` row before registering the
 * timer, and deletes it on cancel or fire. Trigger boot recovery
 * (e.g. `HttpTrigger.recoverDispatches`) reads these rows to re-register
 * timers across process restarts.
 */
export interface DeferredScheduleOptions {
	workflowName: string;
	/** Trigger type — `"http"` for v1; future triggers can opt in. */
	triggerType: string;
	/** TTL deadline (ms since epoch). When set, expired rows get marked `expired` on boot recovery. */
	expiresAt?: number;
	/** Mirrors the run record's status. */
	dispatchStatus: ScheduledDispatchRow["dispatchStatus"];
	/**
	 * JSON-serializable trigger-defined payload sufficient to reconstruct
	 * dispatch on boot. Trigger packages choose what to put here.
	 */
	payload: unknown;
}

export class DeferredRunScheduler {
	private static instance: DeferredRunScheduler | null = null;

	private entries: Map<string, ScheduledEntry> = new Map();

	static getInstance(): DeferredRunScheduler {
		if (!DeferredRunScheduler.instance) {
			DeferredRunScheduler.instance = new DeferredRunScheduler();
		}
		return DeferredRunScheduler.instance;
	}

	/** Test-only — reset the singleton. Cancels all pending timers. */
	static resetInstance(): void {
		DeferredRunScheduler.instance?.clear();
		DeferredRunScheduler.instance = null;
	}

	/**
	 * Register a deferred dispatch. The timer fires at `dispatchAt`
	 * (clamped to ≥ now); when it fires, the entry is removed from the
	 * map and `dispatchFn` is invoked. Errors thrown by `dispatchFn` are
	 * swallowed and logged — the scheduler is fire-and-forget by design.
	 *
	 * Re-scheduling the same `runId` cancels the previous timer and
	 * replaces it (used by the debounce coordinator's "reset on ping").
	 *
	 * When `persist` is provided, the scheduler also writes a
	 * `scheduled_dispatches` row before registering the timer (so a
	 * crash leaves the dispatch recoverable), and deletes the row on
	 * cancel or fire.
	 */
	schedule(runId: string, dispatchAt: number, dispatchFn: DeferredDispatchFn, persist?: DeferredScheduleOptions): void {
		// Persist BEFORE the timer so a crash between persist + setTimeout
		// still leaves the row recoverable.
		const persisted = persist !== undefined;
		if (persisted) {
			const tracker = RunTracker.getInstance();
			if (tracker.active) {
				try {
					tracker.getStore().upsertScheduledDispatch({
						runId,
						workflowName: persist.workflowName,
						triggerType: persist.triggerType,
						scheduledAt: dispatchAt,
						expiresAt: persist.expiresAt,
						dispatchStatus: persist.dispatchStatus,
						payload: persist.payload,
						createdAt: Date.now(),
					});
				} catch (err) {
					// Don't block the dispatch on persistence failure — log and continue.
					console.error(
						`[blok][scheduling] persist failed for run ${runId}; continuing in-memory only:`,
						err instanceof Error ? err.stack || err.message : err,
					);
				}
			}
		}

		// Replace any existing entry for this runId.
		const existing = this.entries.get(runId);
		if (existing) clearTimeout(existing.timer);

		const delay = Math.max(0, dispatchAt - Date.now());
		const timer = setTimeout(() => {
			this.entries.delete(runId);
			// Best-effort delete the persisted row before invoking dispatchFn —
			// dispatch will write the run's terminal status separately.
			if (persisted) this.deletePersistedRow(runId);
			void dispatchFn().catch((err: unknown) => {
				console.error(
					`[blok][scheduling] DeferredRunScheduler dispatch failed for run ${runId}:`,
					err instanceof Error ? err.stack || err.message : err,
				);
			});
		}, delay);

		// `Node` will keep the event loop alive for pending timers — that's
		// the desired behavior for delayed runs in long-running services.
		// `unref()` would be wrong here.

		this.entries.set(runId, { runId, dispatchAt, timer, dispatchFn, persisted });
	}

	/**
	 * Cancel a pending dispatch. Returns true if the entry existed and
	 * was cancelled; false otherwise. Idempotent. When the entry was
	 * persisted, also deletes the `scheduled_dispatches` row.
	 *
	 * `cancelPersistedOnly` (default false) lets callers force the
	 * persistence-row delete even when the in-memory timer is gone (e.g.
	 * recovery cleanup that knows about a row but never had a timer).
	 */
	cancel(runId: string, cancelPersistedOnly = false): boolean {
		const entry = this.entries.get(runId);
		if (!entry) {
			if (cancelPersistedOnly) {
				return this.deletePersistedRow(runId);
			}
			return false;
		}
		clearTimeout(entry.timer);
		this.entries.delete(runId);
		if (entry.persisted) this.deletePersistedRow(runId);
		return true;
	}

	private deletePersistedRow(runId: string): boolean {
		const tracker = RunTracker.getInstance();
		if (!tracker.active) return false;
		try {
			return tracker.getStore().deleteScheduledDispatch(runId);
		} catch (err) {
			console.error(
				`[blok][scheduling] persist-cleanup failed for run ${runId}:`,
				err instanceof Error ? err.stack || err.message : err,
			);
			return false;
		}
	}

	/** True if `runId` has a pending timer. */
	has(runId: string): boolean {
		return this.entries.has(runId);
	}

	/** Number of pending timers. Useful for tests + observability. */
	size(): number {
		return this.entries.size;
	}

	/**
	 * Fire ALL pending dispatches immediately and clear the queue.
	 * Awaits each `dispatchFn` so the caller knows when the queue is
	 * drained. Useful for graceful shutdown.
	 */
	async drainAll(): Promise<void> {
		const toFire = Array.from(this.entries.values());
		// Cancel all timers first so we don't double-dispatch.
		for (const entry of toFire) clearTimeout(entry.timer);
		this.entries.clear();
		// Sequential dispatch — preserves intended order if it matters.
		for (const entry of toFire) {
			try {
				await entry.dispatchFn();
			} catch (err) {
				console.error(
					`[blok][scheduling] drainAll dispatch failed for run ${entry.runId}:`,
					err instanceof Error ? err.stack || err.message : err,
				);
			}
		}
	}

	/** Cancel everything without dispatching. */
	clear(): void {
		for (const entry of this.entries.values()) clearTimeout(entry.timer);
		this.entries.clear();
	}
}
