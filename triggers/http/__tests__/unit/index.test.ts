import { beforeAll, describe, expect, it, vi } from "vitest";

// Prevent auto-run
process.env.DISABLE_TRIGGER_RUN = "true";

// Mock OpenTelemetry
vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (name: string, fn: (span: any) => any) =>
				fn({
					setAttribute: vi.fn(),
					setStatus: vi.fn(),
					end: vi.fn(),
				}),
		}),
	},
	metrics: {
		getMeter: () => ({
			createCounter: () => ({ add: vi.fn() }),
			createGauge: () => ({ record: vi.fn() }),
		}),
	},
	SpanStatusCode: { OK: 0, ERROR: 1 },
}));

vi.mock("../../src/runner/metrics/opentelemetry_metrics", () => ({
	metricsHandler: vi.fn(),
}));

vi.mock("../../src/Nodes", () => ({ default: {} }));
vi.mock("../../src/Workflows", () => ({ default: {} }));
vi.mock("../../src/AppRoutes", () => {
	const { Router } = require("express");
	return { default: Router() };
});

import App from "../../src/index";

describe("App", () => {
	describe("constructor()", () => {
		it("should create App instance", () => {
			const app = new App();
			expect(app).toBeDefined();
		});
	});

	describe("getHttpApp()", () => {
		it("should return Express app from trigger", () => {
			const app = new App();
			const httpApp = app.getHttpApp();
			expect(httpApp).toBeDefined();
			expect(typeof httpApp.use).toBe("function");
		});
	});

	describe("run()", () => {
		it("should call listen on the trigger", async () => {
			const app = new App();
			const httpApp = app.getHttpApp();

			// Mock listen to resolve immediately
			vi.spyOn(httpApp, "listen").mockImplementation(((port: number, cb: () => void) => {
				cb();
				return { close: vi.fn() };
			}) as any);

			// run() doesn't return anything meaningful, just verify no throw
			await app.run();
		});
	});
});
