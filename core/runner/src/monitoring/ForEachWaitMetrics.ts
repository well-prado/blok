/**
 * v0.6 Phase 3 — OTel counter for parallel forEach + wait observability.
 * Incremented at cursor-write time with the count of iterations
 * cancelled because a peer fired a wait. Lets ops dashboards spot
 * workflows that frequently waste work on cancel + re-launch — usually
 * a signal that the author should switch to sequential forEach OR add
 * `idempotencyKey` to inner steps so the re-launches are cache hits.
 *
 * Singleton, lazy-instantiated. No-ops cleanly when OTel isn't
 * configured (the meter API silently swallows recordings without an
 * exporter).
 */

import { type Attributes, metrics } from "@opentelemetry/api";

export class ForEachWaitMetrics {
	private static instance: ForEachWaitMetrics | null = null;

	private readonly cancelledCounter = metrics.getMeter("blok").createCounter("blok_foreach_wait_cancelled_total", {
		description:
			"Iterations cancelled because a peer fired a wait inside a parallel forEach. High values signal authors should add idempotencyKey to inner steps.",
		unit: "1",
	});

	static getInstance(): ForEachWaitMetrics {
		if (!ForEachWaitMetrics.instance) {
			ForEachWaitMetrics.instance = new ForEachWaitMetrics();
		}
		return ForEachWaitMetrics.instance;
	}

	static resetInstance(): void {
		ForEachWaitMetrics.instance = null;
	}

	recordCancellation(opts: { workflowName: string; cancelledCount: number }): void {
		if (opts.cancelledCount <= 0) return;
		const attrs: Attributes = { workflow_name: opts.workflowName };
		this.cancelledCounter.add(opts.cancelledCount, attrs);
	}
}
