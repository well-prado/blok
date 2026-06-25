/**
 * OBS-05 T5 — OTel counter for fire-and-forget (`wait: false`) sub-workflow
 * dispatch failures. Today those failures are caught + `console.error`-ed +
 * routed to `tracker.failRun` but emit no metric, so an ops dashboard can't
 * alert on a spike of silently-failing async children. This counter surfaces
 * them.
 *
 * Wired into `SubworkflowNode`'s two fire-and-forget failure paths:
 * - the in-process `dispatchAsync` catch (`dispatch: "in-process"`)
 * - the `http-self` `wait: false` `.catch` (`dispatch: "http-self"`)
 *
 * Singleton, lazy-instantiated. No-ops cleanly when OTel isn't configured
 * (the meter API silently swallows recordings without an exporter).
 */

import { type Attributes, metrics } from "@opentelemetry/api";

export class SubworkflowMetrics {
	private static instance: SubworkflowMetrics | null = null;

	private readonly asyncFailureCounter = metrics
		.getMeter("blok")
		.createCounter("blok_subworkflow_async_failure_total", {
			description:
				"Fire-and-forget (wait:false) sub-workflow dispatch failures, by parent workflow + dispatch strategy.",
			unit: "1",
		});

	static getInstance(): SubworkflowMetrics {
		if (!SubworkflowMetrics.instance) {
			SubworkflowMetrics.instance = new SubworkflowMetrics();
		}
		return SubworkflowMetrics.instance;
	}

	/** Test-only — drop the singleton so re-import gets fresh meters. */
	static resetInstance(): void {
		SubworkflowMetrics.instance = null;
	}

	recordAsyncFailure(attrs: { workflow_name: string; dispatch: "in-process" | "http-self" }): void {
		this.asyncFailureCounter.add(1, attrs as Attributes);
	}
}
