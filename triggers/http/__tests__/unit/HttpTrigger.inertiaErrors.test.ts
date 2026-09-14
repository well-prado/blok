/**
 * Issue #1014 over a REAL `HttpTrigger` — production error pages as Inertia
 * responses.
 *
 * Same harness as `HttpTrigger.inertia-security.test.ts` (#1013): real
 * workflows booted through the trigger and driven with
 * `app.fetch(new Request(...))`, so the whole shipped path runs — route table
 * -> runner -> a step that throws -> the trigger's error branch -> the
 * `@blokjs/inertia` error-page hook -> HTTP.
 *
 * Tests 1-6 of the issue. NODE_ENV is toggled per test; the adapter reads it
 * (and `BLOK_INERTIA_ERROR_PAGES`) at render time, so nothing is cached.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { makeOtelApiMock } = await vi.hoisted(() => import("../helpers/otel-api-mock.js"));
vi.mock("@opentelemetry/api", () => makeOtelApiMock());

vi.mock("../../src/runner/metrics/opentelemetry_metrics", () => ({
	bootstrapMetrics: async () => ({ meter: {}, metricsHandler: () => {} }),
	resetBootstrap: () => {},
	metricsHandler: vi.fn(),
}));

vi.mock("../../src/AppRoutes", () => {
	const { Hono } = require("hono");
	return { default: new Hono() };
});

vi.mock("../../src/Nodes", async () => {
	const [{ HELPER_NODES }, inertia, { defineNode }, { z }] = await Promise.all([
		import("@blokjs/helpers"),
		import("@blokjs/inertia"),
		import("@blokjs/core"),
		import("zod"),
	]);
	// A step that throws a REAL Error (not a `GlobalError`), the way an app's
	// own node fails: `defineNode` wraps it with code 500 AND a stack, which is
	// exactly what must never reach the wire in production.
	const boom = defineNode({
		name: "test.boom",
		description: "Throw a plain Error, stack and all.",
		input: z.object({}),
		output: z.object({}),
		async execute() {
			throw new Error("kaboom: connection to postgres://user:hunter2@db/app refused");
		},
	});
	return {
		default: {
			...HELPER_NODES,
			"@blokjs/inertia": inertia.default,
			"@blokjs/inertia.authorize": inertia.authorizeNode,
			"test.boom": boom,
		},
	};
});

vi.mock("../../src/Workflows", () => {
	const wf = (name: string, path: string, steps: unknown[]) => ({
		_blokV2: true,
		_config: { name, version: "1.0.0", trigger: { http: { method: "GET", path } }, steps },
	});
	return {
		default: {
			// 500 — a step that throws.
			boom: wf("boom", "/boom", [{ id: "boom", use: "test.boom", inputs: {} }]),
			// 403 — authorize() denies.
			guarded: wf("guarded", "/posts/1/edit", [
				{ id: "guard", use: "@blokjs/inertia.authorize", inputs: { ability: "edit", allowed: false } },
			]),
			// 503 — a maintenance short-circuit.
			maintenance: wf("maintenance", "/maintenance", [
				{ id: "down", use: "@blokjs/throw", inputs: { message: "Down for maintenance", code: 503 } },
			]),
		},
	};
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

import {
	_resetErrorPages,
	_resetShared,
	configureErrorPages,
	handleExceptionsUsing,
	render,
	share,
} from "@blokjs/inertia";
import { WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger.js";

const INERTIA = { "x-inertia": "true" };
const BROWSER = { accept: "text/html,application/xhtml+xml" };

async function buildApp() {
	const trigger = new HttpTrigger();
	await trigger.listen();
	return trigger.getApp();
}

function fetchIt(app: Awaited<ReturnType<typeof buildApp>>, path: string, init?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, init));
}

/** Run `fn` with `NODE_ENV=production`, restoring whatever was there. */
async function inProduction<T>(fn: () => Promise<T>): Promise<T> {
	const previous = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	try {
		return await fn();
	} finally {
		process.env.NODE_ENV = previous;
	}
}

describe("HttpTrigger — production Inertia error pages (#1014)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		process.env.NODE_ENV = "test";
		// biome-ignore lint/performance/noDelete: must unset, not store "undefined"
		delete process.env.BLOK_INERTIA_ERROR_PAGES;
		_resetErrorPages();
		_resetShared();
	});

	it("1 — dev is untouched: a thrown step is still the JSON error shape", async () => {
		const res = await fetchIt(await buildApp(), "/boom", { headers: INERTIA });

		expect(res.status).toBe(500);
		expect(res.headers.get("x-inertia")).toBeNull();
		expect(await res.json()).toMatchObject({ error: expect.stringContaining("kaboom") });
	});

	it("2 — prod + X-Inertia: a thrown step is a 500 page object, with no stack and no message leak", async () => {
		const res = await inProduction(async () => fetchIt(await buildApp(), "/boom", { headers: INERTIA }));

		expect(res.status).toBe(500);
		expect(res.headers.get("x-inertia")).toBe("true");
		expect(res.headers.get("content-type")).toContain("application/json");

		const body = await res.text();
		expect(JSON.parse(body)).toMatchObject({
			component: "Errors/Error",
			props: { status: 500, message: "Server Error" },
			url: "/boom",
		});
		expect(body).not.toContain("stack");
		expect(body).not.toContain("kaboom");
		expect(body).not.toContain("hunter2");
	});

	it("3 — prod, no X-Inertia: the same 500 as an HTML shell with the boot script", async () => {
		const res = await inProduction(async () => fetchIt(await buildApp(), "/boom", { headers: BROWSER }));

		expect(res.status).toBe(500);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain('<script type="application/json" data-page="app">');
		expect(html).toContain("Errors\\/Error");
		expect(html).not.toContain("kaboom");
	});

	it("4 — an unmatched route is a 404 page for a browser, and unchanged JSON for an API client", async () => {
		configureErrorPages({ pages: { 404: "Errors/NotFound", default: "Errors/Error" } });
		const app = await buildApp();

		const page = await inProduction(() => fetchIt(app, "/nope", { headers: INERTIA }));
		expect(page.status).toBe(404);
		expect(page.headers.get("x-inertia")).toBe("true");
		expect(await page.json()).toMatchObject({
			component: "Errors/NotFound",
			props: { status: 404, message: "Not Found" },
			url: "/nope",
		});

		const html = await inProduction(() => fetchIt(app, "/nope", { headers: BROWSER }));
		expect(html.status).toBe(404);
		expect(html.headers.get("content-type")).toContain("text/html");
		expect(await html.text()).toContain("Errors\\/NotFound");

		// Not an Inertia visit and not asking for HTML -> the trigger's own 404.
		const json = await inProduction(() => fetchIt(app, "/nope", { headers: { accept: "application/json" } }));
		expect(json.status).toBe(404);
		expect(json.headers.get("x-inertia")).toBeNull();
		expect(await json.json()).toMatchObject({ error: expect.stringContaining("Workflow not found") });
	});

	it("5 — shared props are resolved on the error page", async () => {
		share("auth", () => ({ user: { id: "u-1", name: "Ada" } }));
		const res = await inProduction(async () => fetchIt(await buildApp(), "/nope", { headers: INERTIA }));

		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({
			component: "Errors/Error",
			props: { status: 404, auth: { user: { id: "u-1", name: "Ada" } } },
			sharedProps: ["auth"],
		});
	});

	it("6 — handleExceptionsUsing: a custom page, and null falls back to the trigger's own 404", async () => {
		handleExceptionsUsing(({ status }) => (status === 404 ? null : render("Errors/Boom", { status, custom: true })));
		const app = await buildApp();

		const notFound = await inProduction(() => fetchIt(app, "/nope", { headers: INERTIA }));
		expect(notFound.status).toBe(404);
		expect(notFound.headers.get("x-inertia")).toBeNull();
		expect(await notFound.json()).toMatchObject({ error: expect.stringContaining("Workflow not found") });

		const boom = await inProduction(() => fetchIt(app, "/boom", { headers: INERTIA }));
		expect(boom.status).toBe(500);
		expect(await boom.json()).toMatchObject({
			component: "Errors/Boom",
			props: { status: 500, custom: true },
		});
	});

	it("7 — 403 from authorize() and 503 from a maintenance throw render their own pages", async () => {
		configureErrorPages({ pages: { 403: "Errors/Forbidden", 503: "Errors/Maintenance", default: "Errors/Error" } });
		const app = await buildApp();

		const forbidden = await inProduction(() => fetchIt(app, "/posts/1/edit", { headers: INERTIA }));
		expect(forbidden.status).toBe(403);
		expect(await forbidden.json()).toMatchObject({
			component: "Errors/Forbidden",
			props: { status: 403, message: "Forbidden" },
		});

		const down = await inProduction(() => fetchIt(app, "/maintenance", { headers: INERTIA }));
		expect(down.status).toBe(503);
		expect(await down.json()).toMatchObject({
			component: "Errors/Maintenance",
			props: { status: 503, message: "Service Unavailable" },
		});
	});

	it("8 — BLOK_INERTIA_ERROR_PAGES=1 turns the pages on outside production, and =0 off inside it", async () => {
		process.env.BLOK_INERTIA_ERROR_PAGES = "1";
		const on = await fetchIt(await buildApp(), "/boom", { headers: INERTIA });
		expect(on.status).toBe(500);
		expect(await on.json()).toMatchObject({ component: "Errors/Error" });

		process.env.BLOK_INERTIA_ERROR_PAGES = "0";
		const off = await inProduction(async () => fetchIt(await buildApp(), "/boom", { headers: INERTIA }));
		expect(off.status).toBe(500);
		expect(await off.json()).toMatchObject({ error: expect.stringContaining("kaboom") });
	});

	it("9 — a status outside the configured set keeps the trigger's own body", async () => {
		configureErrorPages({ statuses: [404] });
		const res = await inProduction(async () => fetchIt(await buildApp(), "/boom", { headers: INERTIA }));

		expect(res.status).toBe(500);
		expect(res.headers.get("x-inertia")).toBeNull();
		expect(await res.json()).toMatchObject({ error: expect.stringContaining("kaboom") });
	});
});
