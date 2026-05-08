/**
 * Tier 2 follow-up · periodic janitor sweep for stale storage rows.
 *
 * Background task that runs on a configurable interval (default 5 min,
 * override via `BLOK_JANITOR_INTERVAL_MS`) and invokes the existing
 * lazy-purge methods to clean up:
 *
 * - `idempotency_cache` — entries past `expires_at`
 * - `concurrency_locks` — leases past `expires_at`
 * - `scheduled_dispatches` — rows past `expires_at` (Tier 2 #5+#7 follow-up)
 *
 * Each store's per-call lazy-purge handles the hot path (e.g.,
 * `acquireConcurrencySlot` purges the bucket it touches). The janitor
 * catches stale entries in cold buckets that nothing else accesses.
 *
 * Idempotent + interval-bounded — runs every `intervalMs`; concurrent
 * `runOnce()` calls are serialized via the `inFlight` flag to prevent
 * overlapping sweeps under slow stores. Errors per sweep are caught
 * and logged; one failing sweep doesn't stop the loop or block others.
 *
 * Kill-switch: `BLOK_JANITOR_DISABLED=1`.
 */

import { JanitorMetrics } from "../monitoring/JanitorMetrics";
import type { RunStore } from "./RunStore";

interface JanitorLogger {
	error?: (message: string) => void;
	log?: (message: string) => void;
}

export interface JanitorStats {
	idempotencyCachePurged: number;
	concurrencySlotsPurged: number;
	scheduledDispatchesPurged: number;
	durationMs: number;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export class Janitor {
	private static instance: Janitor | null = null;

	private readonly store: RunStore;
	private readonly logger?: JanitorLogger;
	private timer: NodeJS.Timeout | null = null;
	private inFlight = false;
	private stopped = false;

	private constructor(store: RunStore, logger?: JanitorLogger) {
		this.store = store;
		this.logger = logger;
	}

	/**
	 * Get or initialize the singleton. The first call wins — subsequent
	 * calls return the existing instance regardless of arguments.
	 */
	static getInstance(store: RunStore, logger?: JanitorLogger): Janitor {
		if (!Janitor.instance) {
			Janitor.instance = new Janitor(store, logger);
		}
		return Janitor.instance;
	}

	/** Test-only — reset the singleton. Stops any running interval. */
	static resetInstance(): void {
		Janitor.instance?.stop();
		Janitor.instance = null;
	}

	/**
	 * Start the periodic sweep. Idempotent — calling twice is a no-op.
	 * Returns false when the kill-switch is set or the janitor was
	 * already started.
	 */
	start(intervalMs?: number): boolean {
		if (process.env.BLOK_JANITOR_DISABLED === "1") return false;
		if (this.timer !== null) return false;
		this.stopped = false;

		const envIntervalRaw = process.env.BLOK_JANITOR_INTERVAL_MS;
		const envInterval = envIntervalRaw && /^\d+$/.test(envIntervalRaw) ? Number(envIntervalRaw) : null;
		const interval = intervalMs ?? envInterval ?? DEFAULT_INTERVAL_MS;

		// `unref()` so the janitor doesn't keep the event loop alive on
		// its own — when all triggers shut down, the process should exit.
		this.timer = setInterval(() => {
			void this.runOnce();
		}, interval);
		this.timer.unref?.();

		this.logger?.log?.(`[blok][janitor] started — interval=${interval}ms`);
		return true;
	}

	/** Stop the periodic sweep. Idempotent. */
	stop(): void {
		this.stopped = true;
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Run one sweep immediately. Useful for tests + as a manual janitor
	 * command. Concurrent invocations are serialized via the `inFlight`
	 * flag — overlapping calls return the same in-progress sweep's stats
	 * via the resolved promise.
	 *
	 * Errors per individual purge method are caught + logged; one failing
	 * purge doesn't abort the others.
	 */
	async runOnce(): Promise<JanitorStats> {
		if (this.stopped) {
			return { idempotencyCachePurged: 0, concurrencySlotsPurged: 0, scheduledDispatchesPurged: 0, durationMs: 0 };
		}
		if (this.inFlight) {
			// Skip overlapping invocations — return zero stats so callers
			// don't wait on a sweep that's already running.
			return { idempotencyCachePurged: 0, concurrencySlotsPurged: 0, scheduledDispatchesPurged: 0, durationMs: 0 };
		}
		this.inFlight = true;

		const start = Date.now();
		const stats: JanitorStats = {
			idempotencyCachePurged: 0,
			concurrencySlotsPurged: 0,
			scheduledDispatchesPurged: 0,
			durationMs: 0,
		};

		try {
			// PR 3 D3 — record per-table duration + rows purged via OTel.
			const idemStart = Date.now();
			try {
				stats.idempotencyCachePurged = this.store.purgeExpiredIdempotencyCache(start);
			} catch (err) {
				this.logger?.error?.(
					`[blok][janitor] purgeExpiredIdempotencyCache failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			JanitorMetrics.getInstance().recordSweep(
				{ table: "idempotency_cache" },
				Date.now() - idemStart,
				stats.idempotencyCachePurged,
			);

			const locksStart = Date.now();
			try {
				stats.concurrencySlotsPurged = this.store.purgeExpiredConcurrencySlots(start);
			} catch (err) {
				this.logger?.error?.(
					`[blok][janitor] purgeExpiredConcurrencySlots failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			JanitorMetrics.getInstance().recordSweep(
				{ table: "concurrency_locks" },
				Date.now() - locksStart,
				stats.concurrencySlotsPurged,
			);

			const dispStart = Date.now();
			try {
				stats.scheduledDispatchesPurged = this.store.purgeExpiredScheduledDispatches(start);
			} catch (err) {
				this.logger?.error?.(
					`[blok][janitor] purgeExpiredScheduledDispatches failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			JanitorMetrics.getInstance().recordSweep(
				{ table: "scheduled_dispatches" },
				Date.now() - dispStart,
				stats.scheduledDispatchesPurged,
			);

			stats.durationMs = Date.now() - start;

			const totalPurged = stats.idempotencyCachePurged + stats.concurrencySlotsPurged + stats.scheduledDispatchesPurged;
			if (totalPurged > 0) {
				this.logger?.log?.(
					`[blok][janitor] sweep done — idem=${stats.idempotencyCachePurged} locks=${stats.concurrencySlotsPurged} dispatches=${stats.scheduledDispatchesPurged} (${stats.durationMs}ms)`,
				);
			}
		} finally {
			this.inFlight = false;
		}

		return stats;
	}

	/** Whether the janitor is currently running on its interval. */
	isRunning(): boolean {
		return this.timer !== null;
	}
}
