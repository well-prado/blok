/**
 * PR 3 D3 — OpenTelemetry metrics for the Janitor sweep.
 *
 * Operators tuning `BLOK_JANITOR_INTERVAL_MS` need real numbers per
 * sweep: how long does each table's purge take, how many rows did it
 * remove? This singleton exposes a histogram for sweep duration and a
 * counter for purged rows, both labeled by the table being swept.
 *
 * Wired into `Janitor.runOnce` per-table after each purge call.
 *
 * No-op cleanly when OTel isn't configured (the meter API silently
 * swallows recordings without an exporter).
 */

import { metrics } from "@opentelemetry/api";

interface JanitorAttributes {
	table: "idempotency_cache" | "concurrency_locks" | "scheduled_dispatches";
}

export class JanitorMetrics {
	private static instance: JanitorMetrics | null = null;

	private readonly sweepDurationHistogram = metrics.getMeter("blok").createHistogram("blok_janitor_sweep_duration_ms", {
		description: "Janitor sweep duration per table.",
		unit: "ms",
		advice: { explicitBucketBoundaries: [1, 5, 10, 50, 100, 500, 1000, 5000, 30000] },
	});

	private readonly purgedCounter = metrics.getMeter("blok").createCounter("blok_janitor_purged_total", {
		description: "Total rows purged by the Janitor per table.",
		unit: "1",
	});

	// OBS-06 T10 — per-table sweep failures. A purge that throws is caught +
	// logged but otherwise invisible to metrics; this counter lets operators
	// alert on a store that's failing to sweep (disk full, locked, etc.).
	private readonly sweepErrorsCounter = metrics.getMeter("blok").createCounter("blok_janitor_sweep_errors_total", {
		description: "Total Janitor per-table sweep failures.",
		unit: "1",
	});

	private constructor() {}

	static getInstance(): JanitorMetrics {
		if (!JanitorMetrics.instance) {
			JanitorMetrics.instance = new JanitorMetrics();
		}
		return JanitorMetrics.instance;
	}

	/** Test-only — drop the singleton so re-import gets fresh meters. */
	static resetInstance(): void {
		JanitorMetrics.instance = null;
	}

	recordSweep(attrs: JanitorAttributes, durationMs: number, rowsPurged: number): void {
		this.sweepDurationHistogram.record(durationMs, attrs as unknown as Record<string, string>);
		// Review fix-up · GAP-2. Always record the counter, even when zero.
		// Without zero-row recordings, operators can't distinguish
		// "Janitor running, table clean" from "Janitor not running" by
		// looking at the counter alone. The duration histogram captures
		// liveness too, but pairing them under the same emit cadence
		// keeps dashboards consistent.
		this.purgedCounter.add(rowsPurged, attrs as unknown as Record<string, string>);
	}

	/** OBS-06 T10 — increment on a per-table sweep failure. */
	recordSweepError(attrs: JanitorAttributes): void {
		this.sweepErrorsCounter.add(1, attrs as unknown as Record<string, string>);
	}
}
