/**
 * Tier 2 #5 — in-memory scheduler for deferred workflow runs.
 *
 * Trade-off: setTimeout-based, in-process, lost on crash. The plan
 * documents this as the v1 trade-off. Crash-safety: pre-Tier-2-#5 runs
 * with status `"delayed"` are persisted to sqlite via `RunTracker`, and
 * `RunTracker.recoverScheduledRuns()` re-schedules them on boot via this
 * class.
 *
 * Process-wide singleton; obtained via {@link DeferredRunScheduler.getInstance}.
 * Reset between tests via {@link DeferredRunScheduler.resetInstance}.
 */
export type DeferredDispatchFn = () => Promise<void>;

interface ScheduledEntry {
	runId: string;
	dispatchAt: number;
	timer: NodeJS.Timeout;
	dispatchFn: DeferredDispatchFn;
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
	 */
	schedule(runId: string, dispatchAt: number, dispatchFn: DeferredDispatchFn): void {
		// Replace any existing entry for this runId.
		const existing = this.entries.get(runId);
		if (existing) clearTimeout(existing.timer);

		const delay = Math.max(0, dispatchAt - Date.now());
		const timer = setTimeout(() => {
			this.entries.delete(runId);
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

		this.entries.set(runId, { runId, dispatchAt, timer, dispatchFn });
	}

	/**
	 * Cancel a pending dispatch. Returns true if the entry existed and
	 * was cancelled; false otherwise. Idempotent.
	 */
	cancel(runId: string): boolean {
		const entry = this.entries.get(runId);
		if (!entry) return false;
		clearTimeout(entry.timer);
		this.entries.delete(runId);
		return true;
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
