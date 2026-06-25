/**
 * OBS-05 T2 + OBS-06 T8/T10 — error-observability metrics coverage.
 *
 * Asserts (via the InMemoryMetricExporter + PeriodicExportingMetricReader
 * + reader.collect() pattern) that:
 *   1. `blok_workflow_errors_total` carries the resolved terminal `status`
 *      label when `recordError` is given one, and omits it otherwise.
 *   2. `blok_unhandled_rejection_total` emits with {trigger_type, reason_class}.
 *   3. `blok_janitor_sweep_errors_total` emits with {table}.
 *
 * All three no-op cleanly when no exporter is registered (the meter API
 * swallows recordings) — these tests register one to observe the emission.
 */

import { metrics } from "@opentelemetry/api";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JanitorMetrics } from "../../../src/monitoring/JanitorMetrics";
import { ProcessErrorMetrics } from "../../../src/monitoring/ProcessErrorMetrics";
import { PrometheusMetricsBridge } from "../../../src/monitoring/PrometheusMetricsBridge";
import { TriggerMetricsCollector } from "../../../src/monitoring/TriggerMetricsCollector";

describe("error-observability metrics (OBS-05 T2 + OBS-06 T8/T10)", () => {
	let reader: PeriodicExportingMetricReader;

	beforeAll(() => {
		reader = new PeriodicExportingMetricReader({
			exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
			exportIntervalMillis: 2 ** 31 - 1,
		});
		metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
		JanitorMetrics.resetInstance();
		ProcessErrorMetrics.resetInstance();
	});

	afterAll(async () => {
		await metrics.disable();
		JanitorMetrics.resetInstance();
		ProcessErrorMetrics.resetInstance();
	});

	async function metricByName(name: string) {
		const { resourceMetrics } = await reader.collect();
		return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
	}

	describe("blok_workflow_errors_total status label (OBS-05 T2)", () => {
		// Construct lazily INSIDE beforeAll so the counter binds to the
		// MeterProvider registered by the outer beforeAll — a field
		// initializer would run during collection, before the provider
		// exists, binding to the no-op meter.
		let bridge: PrometheusMetricsBridge;
		beforeAll(() => {
			bridge = new PrometheusMetricsBridge(
				{ triggerType: "HttpTrigger", triggerName: "errors-test" },
				new TriggerMetricsCollector("HttpTrigger", "errors-test"),
			);
		});

		it("carries the resolved terminal status when provided", async () => {
			bridge.recordError("StepTimeoutError", { workflow_name: "wf-a", status: "timedOut" });
			bridge.recordError("Error", { workflow_name: "wf-a", status: "crashed" });

			const errs = await metricByName("blok_workflow_errors_total");
			expect(errs).toBeDefined();

			const timedOut = errs?.dataPoints.find((p) => (p.attributes as Record<string, unknown>).status === "timedOut");
			const crashed = errs?.dataPoints.find((p) => (p.attributes as Record<string, unknown>).status === "crashed");
			expect(timedOut).toBeDefined();
			expect(crashed).toBeDefined();
			expect((timedOut?.value as number) ?? 0).toBeGreaterThanOrEqual(1);
		});

		it("omits the status label when absent (back-compat)", async () => {
			bridge.recordError("network", { workflow_name: "wf-b" });

			const errs = await metricByName("blok_workflow_errors_total");
			const point = errs?.dataPoints.find(
				(p) =>
					(p.attributes as Record<string, unknown>).error_category === "network" &&
					(p.attributes as Record<string, unknown>).status === undefined,
			);
			expect(point).toBeDefined();
		});
	});

	describe("blok_unhandled_rejection_total (OBS-06 T8)", () => {
		it("emits with trigger_type + reason_class", async () => {
			ProcessErrorMetrics.getInstance().recordUnhandledRejection({
				trigger_type: "process",
				reason_class: "TypeError",
			});

			const counter = await metricByName("blok_unhandled_rejection_total");
			expect(counter).toBeDefined();
			const point = counter?.dataPoints.find(
				(p) => (p.attributes as Record<string, unknown>).reason_class === "TypeError",
			);
			expect(point).toBeDefined();
			expect((point?.attributes as Record<string, unknown>).trigger_type).toBe("process");
			expect((point?.value as number) ?? 0).toBeGreaterThanOrEqual(1);
		});
	});

	describe("blok_janitor_sweep_errors_total (OBS-06 T10)", () => {
		it("emits with the table label", async () => {
			JanitorMetrics.getInstance().recordSweepError({ table: "idempotency_cache" });
			JanitorMetrics.getInstance().recordSweepError({ table: "scheduled_dispatches" });

			const counter = await metricByName("blok_janitor_sweep_errors_total");
			expect(counter).toBeDefined();
			const idem = counter?.dataPoints.find(
				(p) => (p.attributes as Record<string, unknown>).table === "idempotency_cache",
			);
			expect(idem).toBeDefined();
			expect((idem?.value as number) ?? 0).toBeGreaterThanOrEqual(1);
		});
	});
});
