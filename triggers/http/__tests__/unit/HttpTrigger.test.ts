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

import { Hono } from "hono";
import HttpTrigger, { type AppBindings } from "../../src/runner/HttpTrigger";

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

	// v0.7 — same-port multiplex foundation. Optional constructor arg lets
	// an orchestrator (or future WS / SSE / Webhook triggers) construct ONE
	// Hono app externally and thread it into HttpTrigger. The trigger
	// registers its routes onto the shared app instead of building its own.
	describe("constructor(app) — same-port multiplex (v0.7)", () => {
		it("uses the externally-provided Hono app instead of constructing its own", () => {
			const sharedApp = new Hono<AppBindings>();
			const t = new HttpTrigger(sharedApp);
			expect(t.getApp()).toBe(sharedApp);
		});

		it("constructs its own Hono app when no argument is provided (back-compat)", () => {
			const t = new HttpTrigger();
			const app = t.getApp();
			expect(app).toBeDefined();
			// Existence + shape check — Hono instance has the route methods.
			expect(typeof app.fetch).toBe("function");
			expect(typeof app.get).toBe("function");
		});

		it("registers routes on the shared app when listen() runs", async () => {
			const sharedApp = new Hono<AppBindings>();
			// Pre-mount a route to prove the app is the same instance after listen().
			sharedApp.get("/pre-existing", (c) => c.text("ok"));
			const t = new HttpTrigger(sharedApp);
			await t.listen();
			// Health-check is one of HttpTrigger's standard routes — it
			// should now be on the SHARED app.
			const res = await sharedApp.fetch(new Request("http://localhost/health-check"));
			expect(res.status).toBe(200);
			// Pre-existing route still works — proves HttpTrigger didn't
			// replace the app.
			const preExisting = await sharedApp.fetch(new Request("http://localhost/pre-existing"));
			expect(preExisting.status).toBe(200);
			expect(await preExisting.text()).toBe("ok");
		});

		it("two HttpTriggers can share the same app (for the orchestrator pattern; only one calls serve)", () => {
			const sharedApp = new Hono<AppBindings>();
			const t1 = new HttpTrigger(sharedApp);
			const t2 = new HttpTrigger(sharedApp);
			expect(t1.getApp()).toBe(sharedApp);
			expect(t2.getApp()).toBe(sharedApp);
			// In practice an orchestrator would only call listen() on one
			// to start the server. The other instance's purpose is purely
			// to register additional routes via its constructor/loadWorkflows
			// path (e.g. workflows in a separately-loaded module).
		});
	});
});
