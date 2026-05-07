/**
 * Tier 2 #6 follow-up · cross-process concurrency backend.
 *
 * Optional capability layer that lets `RunTracker.acquireConcurrencySlot`
 * delegate to a backend with cross-process semantics (NATS KV, future
 * Redis) instead of the local sync `RunStore` impl.
 *
 * Default behavior is unchanged — when no backend is set, the tracker
 * uses the existing `store.acquireConcurrencySlot` (single-process via
 * SQLite locks or in-memory Map). The backend is opt-in via
 * `BLOK_CONCURRENCY_BACKEND=nats-kv` and installed by trigger packages
 * during `listen()`.
 *
 * Async-only — NATS KV operations require network round-trips. The
 * sync `RunStore` interface remains untouched (no breaking change to
 * existing extension points); the tracker bridges async + sync via
 * `Promise.resolve()` when no backend is set.
 */

import type { ConcurrencySlotResult } from "../tracing/types";

export interface ConcurrencyBackend {
	/**
	 * Identifying string for logs/metrics. e.g. `"nats-kv"`, `"redis"`.
	 */
	readonly name: string;

	/**
	 * Lifecycle — open the underlying connection. Idempotent. Called
	 * once when the trigger installs the backend during `listen()`.
	 */
	connect(): Promise<void>;

	/**
	 * Lifecycle — close the underlying connection. Idempotent. Called
	 * on graceful process shutdown (when wired).
	 */
	disconnect(): Promise<void>;

	/**
	 * Atomically attempt to acquire a slot for the
	 * `(workflowName, concurrencyKey)` bucket against the given limit.
	 *
	 * Contract — must match {@link RunStore.acquireConcurrencySlot}:
	 * - Lazy-purge expired leases on the bucket before counting.
	 * - Idempotent re-acquire: same `runId` refreshes the lease,
	 *   does NOT grow the count.
	 * - On count >= limit: return `{acquired: false, currentInFlight}`
	 *   without inserting.
	 * - On grant: return `{acquired: true, currentInFlight}` where
	 *   `currentInFlight` includes the just-acquired slot.
	 */
	acquireSlot(
		workflowName: string,
		concurrencyKey: string,
		concurrencyLimit: number,
		runId: string,
		leaseExpiresAt: number,
	): Promise<ConcurrencySlotResult>;

	/**
	 * Release a slot. Idempotent. Safe to call on `runId`s that don't
	 * hold a slot (e.g. crash + restart releases via lease expiry).
	 */
	releaseSlot(workflowName: string, concurrencyKey: string, runId: string): Promise<void>;

	/**
	 * Janitor sweep — purge every lease whose `expiresAt <= now` across
	 * all buckets. Returns the count of purged leases. Cheap per-bucket
	 * lazy-purge happens on every acquire; this method is for global
	 * cleanup (e.g., periodic background task).
	 */
	purgeExpired(now: number): Promise<number>;
}
