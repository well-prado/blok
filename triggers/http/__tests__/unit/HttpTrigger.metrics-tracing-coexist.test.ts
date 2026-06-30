/**
 * Regression: enabling OTLP distributed tracing must NOT disable the Prometheus
 * `/metrics` exporter. `metrics.setGlobalMeterProvider` is first-registration-
 * wins, and bootstrapping the OTel trace SDK (`provider.register()`) touches the
 * global meter provider — so if tracing bootstraps BEFORE metrics, the
 * Prometheus MeterProvider never wins the global slot and every `blok_*`
 * instrument (created via `metrics.getMeter(...)`) records into a no-op meter,
 * making `/metrics` show "# no registered metrics". `HttpTrigger.listen()` was
 * fixed to bootstrap metrics FIRST; this test locks the coexistence at the
 * bootstrap level (console trace exporter — no Tempo needed; it still calls the
 * `register()` that caused the bug).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { bootstrapTracing, resetTracingBootstrap } from "@blokjs/runner";
import { metrics } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapMetrics, resetBootstrap } from "../../src/runner/metrics/opentelemetry_metrics";

/** Invoke the Prometheus exporter's Node req/res handler and capture the body. */
function scrape(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
	return new Promise((resolve) => {
		let body = "";
		const res = {
			statusCode: 200,
			setHeader() {},
			write(chunk: unknown) {
				if (chunk) body += String(chunk);
				return true;
			},
			end(chunk?: unknown) {
				if (chunk) body += String(chunk);
				resolve(body);
			},
		} as unknown as ServerResponse;
		handler({ url: "/metrics", method: "GET" } as IncomingMessage, res);
	});
}

describe("metrics + OTLP tracing coexistence (HttpTrigger boot order)", () => {
	const origDisabled = process.env.BLOK_METRICS_DISABLED;

	beforeEach(() => {
		// biome-ignore lint/performance/noDelete: must unset, not store "undefined"
		delete process.env.BLOK_METRICS_DISABLED;
		metrics.disable(); // clear any global meter provider from a prior test
		resetBootstrap();
		resetTracingBootstrap();
	});
	afterEach(() => {
		metrics.disable();
		resetBootstrap();
		resetTracingBootstrap();
		if (origDisabled === undefined) {
			// biome-ignore lint/performance/noDelete: restore literal absence
			delete process.env.BLOK_METRICS_DISABLED;
		} else process.env.BLOK_METRICS_DISABLED = origDisabled;
	});

	it("a blok_* instrument is still exported after OTLP tracing bootstraps (metrics-first, the fixed order)", async () => {
		// Fixed order mirrors HttpTrigger.listen(): metrics FIRST, then tracing.
		const mb = await bootstrapMetrics();
		expect(mb).not.toBeNull();
		const tracing = await bootstrapTracing({ serviceName: "coexist-test", exporter: "console" });
		// (console exporter still calls provider.register() — the global-meter-touching step)

		// Create an instrument exactly the way the runner does — via the GLOBAL meter.
		metrics.getMeter("blok").createCounter("blok_coexist_probe_total").add(1);

		const out = await scrape(mb!.metricsHandler);
		// The bug produced "# no registered metrics" here; the fix keeps the
		// Prometheus provider global so the instrument is exported.
		expect(out).toContain("blok_coexist_probe_total");

		await tracing?.shutdown();
	});
});
