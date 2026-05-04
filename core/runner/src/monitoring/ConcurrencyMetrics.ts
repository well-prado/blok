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

export class ConcurrencyMetrics {
	private static instance: ConcurrencyMetrics | null = null;

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
		this.acquiredCounter.add(1, attrs as unknown as Record<string, string>);
	}

	recordDenied(attrs: ConcurrencyAttributes & { mode: "throw" | "queue" }): void {
		this.deniedCounter.add(1, attrs as unknown as Record<string, string>);
	}

	recordReleased(attrs: ConcurrencyAttributes): void {
		this.releasedCounter.add(1, attrs as unknown as Record<string, string>);
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
}
