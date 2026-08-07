/**
 * #693 — unknown-route diagnostics. Dev mode enriches the catch-all's
 * "Workflow not found" 404 with registration sources + a nearest-miss
 * suggestion; production keeps a terse body (no route enumeration). Both
 * modes emit a structured server-side log line. Mirrors the boot pattern in
 * `HttpTrigger.nameCollision.test.ts` — a real trigger boot with one
 * manually-registered TS workflow, driven via `app.fetch(...)`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// One manually-registered TS workflow at `GET /orders` — the "registered
// route" a one-character-typo request (`GET /orers`) should be measured
// against.
vi.mock("../../src/Workflows", () => {
	const orders = {
		_blokV2: true,
		_config: {
			name: "orders.list",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/orders" } },
			steps: [{ id: "out", use: "@blokjs/respond", inputs: { body: { ok: true } } }],
		},
	};
	return { default: { orders } };
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

import { RoutingDiagnostics, WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger";

async function bootApp(): Promise<{ fetch: (req: Request) => Promise<Response> }> {
	const trigger = new HttpTrigger();
	await trigger.listen();
	return trigger.getApp();
}

describe("HttpTrigger — unknown-route diagnostics (#693)", () => {
	const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
	const ORIGINAL_WORKFLOWS_PATH = process.env.WORKFLOWS_PATH;
	const ORIGINAL_HMR = process.env.BLOK_HMR;

	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		RoutingDiagnostics.resetInstance();
		// No JSON workflows on disk — only the manually-registered `orders` TS
		// workflow above is in play.
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		process.env.BLOK_HMR = "";
	});

	afterEach(() => {
		process.env.NODE_ENV = ORIGINAL_NODE_ENV ?? "test";
		process.env.WORKFLOWS_PATH = ORIGINAL_WORKFLOWS_PATH;
		process.env.BLOK_HMR = ORIGINAL_HMR ?? "";
	});

	it("dev mode: suggests the registered route for a one-character typo", async () => {
		process.env.NODE_ENV = "development";
		const app = await bootApp();

		const res = await app.fetch(new Request("http://localhost/orers")); // typo of /orders
		expect(res.status).toBe(404);

		const body = (await res.json()) as {
			error: string;
			requested: { method: string; path: string };
			registrationSources: {
				fileScanRoots: Array<{ dir: string; kind: string; filesScanned: number; routesRegistered: number }>;
				manualMap: { count: number };
			};
			suggestions: Array<{ route: string; source?: string; distance: number }>;
			docs: string;
		};

		expect(body.error).toBe("Workflow not found");
		expect(body.requested).toEqual({ method: "GET", path: "/orers" });
		// The manual `orders` workflow is one of the registration sources.
		expect(body.registrationSources.manualMap.count).toBeGreaterThanOrEqual(1);
		expect(body.registrationSources.fileScanRoots.length).toBeGreaterThan(0);
		// Nearest-miss: "GET /orders" is a 1-edit-distance match for "GET /orers".
		expect(body.suggestions[0].route).toBe("GET /orders");
		expect(body.suggestions[0].distance).toBe(1);
		expect(typeof body.docs).toBe("string");
		expect(body.docs.length).toBeGreaterThan(0);
	});

	it("production mode: does not leak the route list, but the body IS a 404", async () => {
		process.env.NODE_ENV = "production";
		const app = await bootApp();

		const res = await app.fetch(new Request("http://localhost/orers"));
		expect(res.status).toBe(404);

		const text = await res.text();
		// No route enumeration, no suggestion, no scan-root paths in the wire body.
		expect(text).not.toContain("/orders");
		expect(text).not.toContain("registrationSources");
		expect(text).not.toContain("suggestions");

		const body = JSON.parse(text) as { error: string };
		expect(body.error).toMatch(/Workflow not found/);
	});

	it("logs the diagnostic server-side even in production (structured log stays in both modes)", async () => {
		process.env.NODE_ENV = "production";
		const app = await bootApp();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await app.fetch(new Request("http://localhost/orers"));

		const logged = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(logged).toContain("[blok][routing]");
		expect(logged).toContain("did you mean");
		expect(logged).toContain("/orders");

		errorSpy.mockRestore();
	});
});

describe("HttpTrigger — boot-time route table (#693)", () => {
	const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
	const ORIGINAL_WORKFLOWS_PATH = process.env.WORKFLOWS_PATH;
	const ORIGINAL_HMR = process.env.BLOK_HMR;
	const ORIGINAL_ROUTE_TABLE = process.env.BLOK_ROUTE_TABLE;

	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		RoutingDiagnostics.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		process.env.BLOK_HMR = "";
		process.env.BLOK_ROUTE_TABLE = "";
	});

	afterEach(() => {
		process.env.NODE_ENV = ORIGINAL_NODE_ENV ?? "test";
		process.env.WORKFLOWS_PATH = ORIGINAL_WORKFLOWS_PATH;
		process.env.BLOK_HMR = ORIGINAL_HMR ?? "";
		process.env.BLOK_ROUTE_TABLE = ORIGINAL_ROUTE_TABLE ?? "";
	});

	it("dev mode: prints the route table and the zero-route TS-file info line", async () => {
		process.env.NODE_ENV = "development";
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await bootApp();

		const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(logged).toContain("file-based routing — 1 route(s) registered");
		expect(logged).toContain("GET     /orders  ←  orders");
		// `src/workflows/countries-helper.ts` (a real fixture in this package)
		// declares `trigger: http.get("/countries-helper")` but is NOT in the
		// mocked `Workflows.ts` map — so it should surface as a zero-route
		// info line instead of silently producing nothing.
		expect(logged).toContain("declares an HTTP trigger but produced no route");
		expect(logged).toContain("countries-helper.ts");

		logSpy.mockRestore();
	});

	it("production mode: the route table is suppressed by default", async () => {
		process.env.NODE_ENV = "production";
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await bootApp();

		const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(logged).not.toContain("route(s) registered");

		logSpy.mockRestore();
	});

	it("production mode: BLOK_ROUTE_TABLE=true forces the table on", async () => {
		process.env.NODE_ENV = "production";
		process.env.BLOK_ROUTE_TABLE = "true";
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await bootApp();

		const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(logged).toContain("file-based routing — 1 route(s) registered");

		logSpy.mockRestore();
	});
});
