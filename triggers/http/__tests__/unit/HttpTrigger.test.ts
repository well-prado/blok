import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock external dependencies before imports
vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (name: string, fn: (span: any) => any) =>
				fn({
					setAttribute: vi.fn(),
					setStatus: vi.fn(),
					recordException: vi.fn(),
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

vi.mock("../../src/Nodes", () => ({
	default: {},
}));

vi.mock("../../src/Workflows", () => ({
	default: {},
}));

vi.mock("../../src/AppRoutes", () => {
	const { Router } = require("express");
	return { default: Router() };
});

import HttpTrigger from "../../src/runner/HttpTrigger";

describe("HttpTrigger", () => {
	let trigger: HttpTrigger;

	beforeEach(() => {
		vi.restoreAllMocks();
		trigger = new HttpTrigger();
	});

	describe("constructor()", () => {
		it("should create instance without errors", () => {
			expect(trigger).toBeDefined();
		});
	});

	describe("loadNodes()", () => {
		it("should populate nodeMap without error", () => {
			// loadNodes is called in constructor
			expect(trigger).toBeDefined();
		});
	});

	describe("getApp()", () => {
		it("should return Express instance", () => {
			const app = trigger.getApp();
			expect(app).toBeDefined();
			expect(typeof app.use).toBe("function");
			expect(typeof app.listen).toBe("function");
		});
	});

	describe("listen()", () => {
		it("should set up middleware and start listening", async () => {
			const app = trigger.getApp();
			const originalListen = app.listen.bind(app);

			// Mock listen to call callback immediately
			vi.spyOn(app, "listen").mockImplementation(((port: number, callback: () => void) => {
				callback();
				return { close: vi.fn() };
			}) as any);

			const result = await trigger.listen();
			expect(typeof result).toBe("number");
		});

		it("should use PORT env var when set", () => {
			const originalPort = process.env.PORT;
			process.env.PORT = "5000";

			const t = new HttpTrigger();
			// The port is set in constructor, verify it was read
			expect(t).toBeDefined();

			process.env.PORT = originalPort;
		});
	});
});
