import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock external dependencies before imports (mirrors HttpTrigger.test.ts).
// Shared complete OTel double (OBS-02 B2 propagation surface).
const { makeOtelApiMock } = await vi.hoisted(() => import("../helpers/otel-api-mock"));
vi.mock("@opentelemetry/api", () => makeOtelApiMock());

vi.mock("../../src/runner/metrics/opentelemetry_metrics", () => ({
	bootstrapMetrics: async () => ({ meter: {}, metricsHandler: () => {} }),
	resetBootstrap: () => {},
	metricsHandler: vi.fn(),
}));

vi.mock("../../src/Nodes", () => ({ default: {} }));

vi.mock("../../src/AppRoutes", () => {
	const { Hono } = require("hono");
	return { default: new Hono() };
});

// Bug 01 — a TS middleware authored with the v2 `workflow({ middleware: true })`
// helper, exported from `Workflows.ts`. The flag lives on `_config` (the builder
// shape). We use plain object literals matching that shape — `readMiddlewareFlag`
// + `readWorkflowName` read `_config.middleware` / `_config.name` — to keep the
// mock isolated from the helper package's runtime.
vi.mock("../../src/Workflows", () => {
	const requestId = {
		_blokV2: true,
		_config: {
			name: "request-id",
			version: "1.0.0",
			middleware: true,
			trigger: {},
			steps: [{ id: "tag", use: "@blokjs/respond", inputs: {} }],
		},
	};
	// A normal routed workflow alongside it — should be RPC-callable, not middleware.
	const echo = {
		_blokV2: true,
		_config: {
			name: "echo",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/echo" } },
			steps: [{ id: "out", use: "@blokjs/respond", inputs: {} }],
		},
	};
	return { default: { "request-id": requestId, echo } };
});

const mockServer = { close: vi.fn(), on: vi.fn() };
vi.mock("@hono/node-server", () => ({
	serve: vi.fn((_opts: any, cb: any) => {
		if (cb) cb();
		return mockServer;
	}),
}));

vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: () => vi.fn() }));
vi.mock("@hono/node-server/utils/response", () => ({ RESPONSE_ALREADY_SENT: new Response(null) }));

import { WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger";

describe("HttpTrigger — TS middleware registration (Bug 01 / F8)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		// Point the JSON scan at a non-existent dir so only the manual
		// (Workflows.ts) path contributes — deterministic and isolated.
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
	});

	for (const fileBasedRouting of ["true", "false"] as const) {
		describe(`with BLOK_FILE_BASED_ROUTING=${fileBasedRouting}`, () => {
			beforeEach(() => {
				process.env.BLOK_FILE_BASED_ROUTING = fileBasedRouting;
			});

			it("registers the trigger-less TS middleware with isMiddleware: true", async () => {
				const trigger = new HttpTrigger();
				await trigger.listen();
				const registry = WorkflowRegistry.getInstance();
				const entry = registry.getMiddleware("request-id");
				expect(entry).toBeDefined();
				expect(entry?.isMiddleware).toBe(true);
			});

			it("does NOT expose the middleware as a public HTTP route", async () => {
				const trigger = new HttpTrigger();
				await trigger.listen();
				const app = trigger.getApp();
				const res = await app.fetch(new Request("http://localhost/__mw/request-id", { method: "POST" }));
				// No middleware route was registered — the catch-all / 404 path
				// handles it, never a 2xx middleware execution.
				expect(res.status).not.toBe(200);
			});
		});
	}

	it("RPC mount rejects a non-http (worker-only) registered workflow (F8)", async () => {
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		const trigger = new HttpTrigger();
		await trigger.listen();
		const app = trigger.getApp();
		const registry = WorkflowRegistry.getInstance();

		// Simulate what `scanAndRegisterMiddleware` does for a scanned JSON
		// worker-only workflow: register it for sub-workflow lookup (no
		// `isMiddleware`, no http trigger). Done AFTER listen() so the
		// route-table's `registry.clear()` doesn't wipe it.
		registry.register({
			name: "worker-only-sub",
			source: "json/worker-only.json",
			workflow: { name: "worker-only-sub", version: "1.0.0", trigger: { worker: { queue: "jobs" } } },
		});

		// Even though it's registered, the RPC mount must reject it: it has no
		// `trigger.http` block, so it isn't http-callable.
		const workerRes = await app.fetch(
			new Request("http://localhost/__blok/rpc/worker-only-sub", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(workerRes.status).toBe(404);

		// A middleware is never RPC-callable either.
		const mwRes = await app.fetch(
			new Request("http://localhost/__blok/rpc/request-id", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(mwRes.status).toBe(404);
	});

	it("RPC mount accepts an http-triggered registered workflow (F8 — does not over-reject)", async () => {
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		const trigger = new HttpTrigger();
		await trigger.listen();
		const app = trigger.getApp();

		// `echo` declares a `trigger.http` block, so the RPC gate lets it through.
		// We only assert the gate doesn't 404 it — execution may still fail (no
		// real node runtime), so any non-404 status proves the gate passed.
		const res = await app.fetch(
			new Request("http://localhost/__blok/rpc/echo", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(res.status).not.toBe(404);
	});
});
