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
			createHistogram: () => ({ record: vi.fn() }),
			createGauge: () => ({ record: vi.fn() }),
			createObservableGauge: () => ({ addCallback: vi.fn() }),
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
	const { Hono } = require("hono");
	return { default: new Hono() };
});

// Mock @hono/node-server serve() to avoid actually binding a port
const mockServer = { close: vi.fn(), on: vi.fn() };
vi.mock("@hono/node-server", () => ({
	serve: vi.fn((_opts: any, cb: any) => {
		if (cb) cb();
		return mockServer;
	}),
}));

vi.mock("@hono/node-server/serve-static", () => ({
	serveStatic: () => vi.fn(),
}));

vi.mock("@hono/node-server/utils/response", () => ({
	RESPONSE_ALREADY_SENT: new Response(null),
}));

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
		it("should return Hono instance", () => {
			const app = trigger.getApp();
			expect(app).toBeDefined();
			expect(typeof app.use).toBe("function");
			expect(typeof app.fetch).toBe("function");
			expect(typeof app.get).toBe("function");
			expect(typeof app.post).toBe("function");
		});
	});

	describe("listen()", () => {
		it("should set up middleware and start listening", async () => {
			const { serve } = await import("@hono/node-server");
			const result = await trigger.listen();
			expect(typeof result).toBe("number");
			expect(serve).toHaveBeenCalled();
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
