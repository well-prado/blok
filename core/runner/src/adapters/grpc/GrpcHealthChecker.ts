/**
 * Background health probe + circuit breaker for a single gRPC adapter.
 *
 * Per the master plan §9: each {@link GrpcRuntimeAdapter} polls
 * `Health/Check` on a fixed interval; after `failureThreshold` consecutive
 * failures, the circuit opens and `execute()` / `executeStream()` fail fast
 * with a typed `BlokError(category=DEPENDENCY)` instead of dialing the SDK.
 * The first successful probe closes the circuit again.
 *
 * Design notes
 * - Pure logic + a `setInterval` timer — no transport coupling. The
 *   `probe` callback abstracts over `adapter.checkHealth()` so this class
 *   can be unit-tested without spawning a real gRPC server.
 * - State transitions go through `setAvailable()` so the (optional)
 *   `onStateChange` hook fires exactly once per transition. Useful for
 *   structured logging + future observability counters.
 * - Stops cleanly via {@link stop} which is idempotent and unrefs the
 *   timer so it never blocks process shutdown in tests.
 *
 * Single Responsibility: track availability based on Health probes; expose
 * `isAvailable()` for callers to gate work. Nothing else.
 */
export interface HealthCheckerOptions {
	/** Polling interval in ms. Must be > 0. */
	readonly intervalMs: number;
	/** Consecutive failures that open the circuit. Must be ≥ 1. */
	readonly failureThreshold: number;
	/** Optional hook fired exactly once per `available` state transition. */
	readonly onStateChange?: (available: boolean) => void;
}

/**
 * The probe function the checker calls on each tick. Returns `true` when
 * the adapter is reachable + reports SERVING; `false` for any other
 * outcome (network error, NOT_SERVING, deadline). The checker NEVER
 * receives an exception — adapters MUST resolve `false` on failure so
 * the polling loop is stable.
 */
export type HealthProbe = () => Promise<boolean>;

export class GrpcHealthChecker {
	private timer: NodeJS.Timeout | null = null;
	private inflight = false;
	private failures = 0;
	private available = true;
	private started = false;

	constructor(
		private readonly probe: HealthProbe,
		private readonly options: HealthCheckerOptions,
	) {
		if (options.intervalMs <= 0) {
			throw new Error("GrpcHealthChecker: intervalMs must be > 0 (use start/stop to toggle polling)");
		}
		if (options.failureThreshold < 1) {
			throw new Error("GrpcHealthChecker: failureThreshold must be ≥ 1");
		}
	}

	/**
	 * Begin polling. Idempotent — calling `start()` twice is a no-op. Does
	 * NOT run an immediate probe; the first tick fires after `intervalMs`.
	 */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.timer = setInterval(() => {
			void this.tick();
		}, this.options.intervalMs);
		// Don't keep the event loop alive just for this timer — important
		// for tests that don't explicitly call `stop()`.
		if (typeof this.timer.unref === "function") this.timer.unref();
	}

	/** Stop polling. Idempotent. Resets internal state for a future restart. */
	stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.started = false;
	}

	/**
	 * True when the circuit is closed (calls allowed). False after enough
	 * consecutive failures to trip the breaker.
	 */
	isAvailable(): boolean {
		return this.available;
	}

	/** Current consecutive-failure count. Useful for diagnostics + tests. */
	getFailureCount(): number {
		return this.failures;
	}

	/**
	 * Run a single probe round. Exposed so tests can drive the state
	 * machine deterministically without waiting for the interval timer.
	 * Concurrent ticks are coalesced (a slow probe doesn't queue more).
	 */
	async tick(): Promise<void> {
		if (this.inflight) return;
		this.inflight = true;
		try {
			const healthy = await this.probe();
			if (healthy) {
				this.failures = 0;
				this.setAvailable(true);
			} else {
				this.failures += 1;
				if (this.failures >= this.options.failureThreshold) {
					this.setAvailable(false);
				}
			}
		} catch {
			// Defensive: probe failures must already resolve `false`. If a
			// probe throws anyway, treat it as a failure and never let the
			// exception escape (would crash the timer callback).
			this.failures += 1;
			if (this.failures >= this.options.failureThreshold) {
				this.setAvailable(false);
			}
		} finally {
			this.inflight = false;
		}
	}

	private setAvailable(next: boolean): void {
		if (next === this.available) return;
		this.available = next;
		this.options.onStateChange?.(next);
	}
}
