/**
 * OBS-06 (T9) — boot-error metric. A failure in `Configuration.init`
 * (workflow parse / node resolution) BEFORE the run starts must increment
 * `blok_boot_error_total{trigger_type, phase, error_class}` and still return the
 * existing 500 (the wrap re-throws, so behaviour is unchanged). Before this, a
 * boot failure surfaced only as a generic 500 with no distinct metric.
 */
import { metrics } from "@opentelemetry/api";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A trivial valid workflow so file-based routing registers POST /boot; the
// request-time Configuration.init is what we force to throw via a spy.
vi.mock("../../src/Workflows", () => {
	const boot = {
		_blokV2: true,
		_config: {
			name: "boot",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/boot" } },
			steps: [{ id: "out", use: "@blokjs/respond", inputs: { body: { ok: true } } }],
		},
	};
	return { default: { boot } };
});

vi.mock("../../src/AppRoutes", () => {
	const { Hono } = require("hono");
	return { default: new Hono() };
});

const mockServer = { close: vi.fn(), on: vi.fn() };
vi.mock("@hono/node-server", () => ({
	serve: vi.fn((_opts: unknown, cb?: () => void) => {
		cb?.();
		return mockServer;
	}),
}));
vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: () => vi.fn() }));
vi.mock("@hono/node-server/utils/response", () => ({ RESPONSE_ALREADY_SENT: new Response(null) }));
// Avoid the real Prometheus exporter binding a port + clobbering the global meter provider on import.
vi.mock("../../src/runner/metrics/opentelemetry_metrics", () => ({
	bootstrapMetrics: async () => ({ meter: {}, metricsHandler: () => {} }),
	resetBootstrap: () => {},
	metricsHandler: () => () => {},
	meter: {},
}));

import { WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger, { _resetBootErrorCounterForTests } from "../../src/runner/HttpTrigger";

describe("HttpTrigger — OBS-06 boot-error metric", () => {
	let reader: PeriodicExportingMetricReader;

	beforeAll(() => {
		reader = new PeriodicExportingMetricReader({
			exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
			exportIntervalMillis: 2 ** 31 - 1,
		});
		metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
		_resetBootErrorCounterForTests();
	});

	afterAll(async () => {
		await metrics.disable();
		_resetBootErrorCounterForTests();
	});

	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
	});

	async function metricByName(name: string) {
		const { resourceMetrics } = await reader.collect();
		return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
	}

	it("fires blok_boot_error_total when Configuration.init throws, and still returns 500", async () => {
		const trigger = new HttpTrigger();
		await trigger.listen();
		// Force a pre-run boot failure at request time (route building already done).
		vi.spyOn(trigger.configuration, "init").mockRejectedValue(new TypeError("kaboom config"));
		const app = trigger.getApp();

		const res = await app.fetch(
			new Request("http://localhost/boot", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);

		// The wrap re-throws, so the existing 500 path is preserved.
		expect(res.status).toBe(500);

		const counter = await metricByName("blok_boot_error_total");
		expect(counter).toBeDefined();
		const point = counter?.dataPoints.find(
			(p) => (p.attributes as Record<string, unknown>).phase === "configuration_init",
		);
		expect(point).toBeDefined();
		const attrs = point?.attributes as Record<string, unknown>;
		expect(attrs.trigger_type).toBe("http");
		expect(attrs.error_class).toBe("TypeError");
		expect((point?.value as number) ?? 0).toBeGreaterThanOrEqual(1);
	});
});
