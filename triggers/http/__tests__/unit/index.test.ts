import { describe, expect, it, vi } from "vitest";

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

vi.mock("../../src/Nodes", () => ({ default: {} }));
vi.mock("../../src/Workflows", () => ({ default: {} }));
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

// v0.7 PR 2 — App now instantiates WebSocketTrigger alongside HttpTrigger.
// Mock it so the test doesn't have to wire @hono/node-ws + ws through the
// HTTP package's test setup.
vi.mock("@blokjs/trigger-websocket", () => ({
	default: class MockWebSocketTrigger {
		setNodeMap(_nodeMap: unknown) {}
		async listen() {
			return 0;
		}
		async stop() {}
	},
}));

vi.mock("@blokjs/trigger-sse", () => ({
	default: class MockSSETrigger {
		setNodeMap(_nodeMap: unknown) {}
		async listen() {
			return 0;
		}
		async stop() {}
	},
}));

vi.mock("@blokjs/trigger-webhook", () => ({
	default: class MockWebhookTrigger {
		setNodeMap(_nodeMap: unknown) {}
		async listen() {
			return 0;
		}
		async stop() {}
	},
}));

import App from "../../src/index";

describe("App", () => {
	describe("constructor()", () => {
		it("should create App instance", () => {
			const app = new App();
			expect(app).toBeDefined();
		});
	});

	describe("getHttpApp()", () => {
		it("should return Hono app from trigger", () => {
			const app = new App();
			const httpApp = app.getHttpApp();
			expect(httpApp).toBeDefined();
			expect(typeof httpApp.use).toBe("function");
			expect(typeof httpApp.fetch).toBe("function");
		});
	});

	describe("run()", () => {
		it("should call serve and initialize the server", async () => {
			const app = new App();
			const { serve } = await import("@hono/node-server");

			// run() doesn't return anything meaningful, just verify no throw
			await app.run();
			expect(serve).toHaveBeenCalled();
		});
	});
});
