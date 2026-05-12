/**
 * Tier 2 #5 — in-memory scheduler for deferred workflow runs. Tier 2
 * #5+#7 follow-up adds optional sqlite-backed durability via the
 * {@link DeferredScheduleOptions.persist} parameter. Tier C #2 adds
 * cross-process claim heartbeats so multi-process deployments sharing
 * a PG store don't double-fire the same dispatch.
 *
 * Process-wide singleton; obtained via {@link DeferredRunScheduler.getInstance}.
 * Reset between tests via {@link DeferredRunScheduler.resetInstance}.
 */
import { randomUUID } from "node:crypto";
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

const DEFAULT_CLAIM_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

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

	/**
	 * Tier C #2 — stable per-process identity used for claim ownership.
	 * Generated once per scheduler instance; surviving across resets is
	 * intentional (a "process restart" in production gets a fresh
	 * scheduler singleton and therefore a fresh processId — peers' stale
	 * claims expire after the lease).
	 */
	private readonly processId: string = randomUUID();

	/** Tier C #2 — running heartbeat timer; one per scheduler instance. */
	private heartbeatTimer: NodeJS.Timeout | null = null;

	/** Tier C #2 — count of persisted entries currently registered. Heartbeat is only active when > 0. */
	private persistedEntryCount = 0;

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
			if (persisted) {
				this.deletePersistedRow(runId);
				this.persistedEntryCount = Math.max(0, this.persistedEntryCount - 1);
				this.maybeStopHeartbeat();
			}
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

		const wasPersisted = existing?.persisted === true;
		this.entries.set(runId, { runId, dispatchAt, timer, dispatchFn, persisted });

		// Tier C #2 — track persisted entry count + manage heartbeat
		// lifecycle. The heartbeat only runs while we have ≥1 persisted
		// entry (otherwise there's nothing to keep claimed). Replace doesn't
		// change the count.
		if (persisted && !wasPersisted) {
			this.persistedEntryCount++;
			this.maybeStartHeartbeat();
		} else if (!persisted && wasPersisted) {
			this.persistedEntryCount = Math.max(0, this.persistedEntryCount - 1);
			this.maybeStopHeartbeat();
		}
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
		if (entry.persisted) {
			this.deletePersistedRow(runId);
			this.persistedEntryCount = Math.max(0, this.persistedEntryCount - 1);
			this.maybeStopHeartbeat();
		}
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
		this.persistedEntryCount = 0;
		this.maybeStopHeartbeat();
	}

	// === Tier C #2 — cross-process claim heartbeat ===

	/**
	 * Stable per-process identity used for the claim API. Trigger boot
	 * recovery passes this to `RunStore.claimDispatches(processId, …)`
	 * so peers can recognize each other's claims.
	 */
	getProcessId(): string {
		return this.processId;
	}

	private maybeStartHeartbeat(): void {
		if (this.heartbeatTimer !== null) return;
		if (this.persistedEntryCount === 0) return;
		if (process.env.BLOK_SCHEDULER_CLAIM_DISABLED === "1") return;
		const intervalMs = readEnvInt("BLOK_SCHEDULER_HEARTBEAT_INTERVAL_MS", DEFAULT_HEARTBEAT_INTERVAL_MS);
		this.heartbeatTimer = setInterval(() => {
			this.runHeartbeat();
		}, intervalMs);
		// Don't keep the event loop alive solely for the heartbeat —
		// the persisted entries' timers already do that. `unref()`
		// avoids blocking shutdown when no entries are pending.
		this.heartbeatTimer.unref?.();
	}

	private maybeStopHeartbeat(): void {
		if (this.heartbeatTimer === null) return;
		if (this.persistedEntryCount > 0) return;
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
	}

	private runHeartbeat(): void {
		const tracker = RunTracker.getInstance();
		if (!tracker.active) return;
		try {
			tracker.getStore().heartbeatClaims(this.processId, Date.now());
		} catch (err) {
			// Heartbeat failures are non-fatal — the lease will expire if
			// they continue, and a peer will take over. Log + continue.
			console.warn(`[blok][scheduling] heartbeatClaims failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

function readEnvInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw && /^\d+$/.test(raw)) {
		const n = Number(raw);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return fallback;
}

/**
 * Public helper that returns the operator-configured claim-lease in
 * ms. Used by `HttpTrigger.recoverDispatches()` to pass the lease to
 * `RunStore.claimDispatches()`. Centralized so the env var name is
 * defined in one place.
 */
export function getSchedulerClaimLeaseMs(): number {
	return readEnvInt("BLOK_SCHEDULER_CLAIM_LEASE_MS", DEFAULT_CLAIM_LEASE_MS);
}
