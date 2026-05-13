/**
 * Tier 2 follow-up · OpenTelemetry counters for concurrency + scheduling
 * resource lifecycle events.
 *
 * Wired into:
 * - `TriggerBase.run`'s concurrency gate — `recordAcquired` /
 *   `recordDenied` / `recordReleased` per slot operation.
 * - `HttpTrigger.recoverDispatches` — `recordDispatchRecovered` /
 *   `recordDispatchExpired` for boot-recovery observability.
 * - The scheduler / debounce coordinator — `recordDispatchFired`
 *   when a deferred timer fires successfully.
 *
 * Singleton; lazy-instantiated. No-ops cleanly when OTel isn't
 * configured (the meter API silently swallows recordings without
 * an exporter).
 */

import { metrics } from "@opentelemetry/api";

interface ConcurrencyAttributes {
	workflow_name: string;
	concurrency_key?: string;
}

interface SchedulingAttributes {
	workflow_name: string;
	trigger_type: string;
	dispatch_status?: string;
}

/**
 * D6 (v0.6) — read the per-key opt-in env var. `concurrency_key` is
 * potentially high-cardinality (per-user, per-tenant, …); emitting it as
 * a metric label by default risks a cardinality explosion in any
 * non-trivial deployment. Default OFF: strip the key before emission so
 * counters stay bucketed by `workflow_name` alone. Opt in to per-key
 * granularity with `BLOK_METRICS_PER_KEY=1` (or `=true`).
 *
 * Exported for test reuse (the strip helper below).
 */
export function isPerKeyMetricsEnabled(): boolean {
	const raw = process.env.BLOK_METRICS_PER_KEY;
	return raw === "1" || raw === "true";
}

/**
 * Pure helper — strips `concurrency_key` from a copy of `attrs` when
 * per-key emission is disabled. Returns the original reference when
 * enabled (no allocation on the hot path).
 */
export function filterPerKeyAttrs<T extends { concurrency_key?: string }>(attrs: T, enabled: boolean): T {
	if (enabled || attrs.concurrency_key === undefined) return attrs;
	const { concurrency_key: _omitted, ...rest } = attrs;
	return rest as T;
}

export class ConcurrencyMetrics {
	private static instance: ConcurrencyMetrics | null = null;

	/**
	 * Captured at construction time — the constructor is private + the
	 * singleton is only reset in tests, so this stays stable for the
	 * lifetime of a process. Tests that toggle the env var call
	 * `resetInstance()` before re-`getInstance()` to pick up the flip.
	 */
	private readonly perKeyEnabled: boolean = isPerKeyMetricsEnabled();

	private readonly acquiredCounter = metrics.getMeter("blok").createCounter("blok_concurrency_acquired_total", {
		description: "Total concurrency slots acquired (per workflow + key).",
		unit: "1",
	});

	private readonly deniedCounter = metrics.getMeter("blok").createCounter("blok_concurrency_denied_total", {
		description: "Total concurrency slot denials (limit hit; throttled or queued).",
		unit: "1",
	});

	private readonly releasedCounter = metrics.getMeter("blok").createCounter("blok_concurrency_released_total", {
		description: "Total concurrency slots released (run reached terminal state).",
		unit: "1",
	});

	private readonly dispatchRecoveredCounter = metrics
		.getMeter("blok")
		.createCounter("blok_scheduling_dispatch_recovered_total", {
			description: "Scheduled dispatches re-registered on boot recovery (HttpTrigger).",
			unit: "1",
		});

	private readonly dispatchExpiredCounter = metrics
		.getMeter("blok")
		.createCounter("blok_scheduling_dispatch_expired_total", {
			description: "Scheduled dispatches marked expired on boot recovery (TTL elapsed).",
			unit: "1",
		});

	private readonly dispatchFiredCounter = metrics
		.getMeter("blok")
		.createCounter("blok_scheduling_dispatch_fired_total", {
			description: "Scheduled dispatches fired by the in-process scheduler.",
			unit: "1",
		});

	// PR 3 D1 — backend install observability. Operators who misconfigure
	// the cross-process backend (NATS KV unreachable / auth failure) get a
	// silent fallback to the in-process backend. This counter surfaces
	// install attempts so misconfiguration is visible in metrics.
	private readonly backendInstallCounter = metrics
		.getMeter("blok")
		.createCounter("blok_concurrency_backend_install_total", {
			description: "Concurrency backend install attempts (success / failure).",
			unit: "1",
		});

	// PR 3 D2 — OCC retry depth histogram. The 95% fail-close rate at
	// 200-way contention seen in LOAD-TESTS.md is invisible without a
	// histogram. Recorded per acquireSlot exit point with bucket
	// boundaries [0, 1, 2, 3, 5, 10] — OCC retry budget caps at 10.
	private readonly occRetriesHistogram = metrics.getMeter("blok").createHistogram("blok_concurrency_occ_retries", {
		description: "OCC retry attempts on cross-process concurrency backends.",
		unit: "{retries}",
		advice: { explicitBucketBoundaries: [0, 1, 2, 3, 5, 10] },
	});

	private constructor() {}

	static getInstance(): ConcurrencyMetrics {
		if (!ConcurrencyMetrics.instance) {
			ConcurrencyMetrics.instance = new ConcurrencyMetrics();
		}
		return ConcurrencyMetrics.instance;
	}

	/** Test-only — drop the singleton so re-import gets fresh meters. */
	static resetInstance(): void {
		ConcurrencyMetrics.instance = null;
	}

	recordAcquired(attrs: ConcurrencyAttributes): void {
		this.acquiredCounter.add(1, filterPerKeyAttrs(attrs, this.perKeyEnabled) as unknown as Record<string, string>);
	}

	recordDenied(attrs: ConcurrencyAttributes & { mode: "throw" | "queue" }): void {
		this.deniedCounter.add(1, filterPerKeyAttrs(attrs, this.perKeyEnabled) as unknown as Record<string, string>);
	}

	recordReleased(attrs: ConcurrencyAttributes): void {
		this.releasedCounter.add(1, filterPerKeyAttrs(attrs, this.perKeyEnabled) as unknown as Record<string, string>);
	}

	recordDispatchRecovered(attrs: SchedulingAttributes): void {
		this.dispatchRecoveredCounter.add(1, attrs as unknown as Record<string, string>);
	}

	recordDispatchExpired(attrs: SchedulingAttributes): void {
		this.dispatchExpiredCounter.add(1, attrs as unknown as Record<string, string>);
	}

	recordDispatchFired(attrs: SchedulingAttributes): void {
		this.dispatchFiredCounter.add(1, attrs as unknown as Record<string, string>);
	}

	// PR 3 D1 — backend install attempt outcome.
	recordBackendInstall(attrs: { backend: string; status: "success" | "failure" }): void {
		this.backendInstallCounter.add(1, attrs as unknown as Record<string, string>);
	}

	// PR 3 D2 — OCC retry depth + outcome (success | denied | fail-closed).
	recordOccRetries(
		attrs: ConcurrencyAttributes & { outcome: "success" | "denied" | "fail-closed" },
		attempts: number,
	): void {
		this.occRetriesHistogram.record(
			attempts,
			filterPerKeyAttrs(attrs, this.perKeyEnabled) as unknown as Record<string, string>,
		);
	}
}
