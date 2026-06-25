/**
 * OBS-06 T8 — OpenTelemetry counter for process-level fatal error events.
 *
 * `TriggerBase.installCrashHandlers` registers process-global
 * `uncaughtException` + `unhandledRejection` handlers that flip in-flight
 * runs to `"crashed"`. This counter surfaces HOW OFTEN those handlers fire
 * so operators can alert on crash/rejection rate independently of the
 * per-run `crashed` status.
 *
 * Labels:
 * - `trigger_type` — the firing context (`"process"` for the global handlers).
 * - `reason_class` — the error's constructor name (e.g. `"TypeError"`),
 *   bucketing rejections by class without leaking the (high-cardinality)
 *   message.
 *
 * Singleton; lazy-instantiated. No-ops cleanly when OTel isn't configured
 * (the meter API silently swallows recordings without an exporter).
 */

import { metrics } from "@opentelemetry/api";

interface ProcessErrorAttributes {
	trigger_type: string;
	reason_class: string;
}

export class ProcessErrorMetrics {
	private static instance: ProcessErrorMetrics | null = null;

	private readonly unhandledRejectionCounter = metrics
		.getMeter("blok")
		.createCounter("blok_unhandled_rejection_total", {
			description: "Total uncaughtException / unhandledRejection events caught by the crash handlers.",
			unit: "1",
		});

	private constructor() {}

	static getInstance(): ProcessErrorMetrics {
		if (!ProcessErrorMetrics.instance) {
			ProcessErrorMetrics.instance = new ProcessErrorMetrics();
		}
		return ProcessErrorMetrics.instance;
	}

	/** Test-only — drop the singleton so re-import gets fresh meters. */
	static resetInstance(): void {
		ProcessErrorMetrics.instance = null;
	}

	recordUnhandledRejection(attrs: ProcessErrorAttributes): void {
		this.unhandledRejectionCounter.add(1, attrs as unknown as Record<string, string>);
	}
}
