/**
 * Inertia v3 over a REAL `HttpTrigger` — workflows that use `@blokjs/inertia`
 * are booted through the trigger and driven with `app.fetch(new Request(...))`,
 * so these assertions cover the whole shipped path: route table → runner →
 * node → `RespondEnvelope` → `emitWorkflowResponse` → HTTP.
 *
 * Covers issue #994's tests 1, 3, 10, 11, 12, 13 and 14 end-to-end.
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

// `../../src/Nodes` is deliberately NOT mocked — `@blokjs/inertia` has to
// resolve through the real HELPER_NODES registry for these to pass.
vi.mock("../../src/Workflows", () => {
	const wf = (name: string, trigger: unknown, steps: unknown[]) => ({
		_blokV2: true,
		_config: { name, version: "1.0.0", trigger, steps },
	});
	return {
		default: {
			"inertia-page": wf("inertia-page", { http: { method: "GET", path: "/users" } }, [
				{
					id: "page",
					use: "@blokjs/inertia",
					inputs: { component: "Users/Index", props: { path: "a/b" }, version: "v1" },
				},
			]),
			"inertia-control": wf("inertia-control", { http: { method: "ANY", path: "/items" } }, [
				{ id: "go", use: "@blokjs/inertia", inputs: { redirect: "/items" } },
			]),
			"inertia-fragment": wf("inertia-fragment", { http: { method: "GET", path: "/frag" } }, [
				{ id: "go", use: "@blokjs/inertia", inputs: { redirect: "/a#b" } },
			]),
			"inertia-external": wf("inertia-external", { http: { method: "GET", path: "/ext" } }, [
				{ id: "go", use: "@blokjs/inertia", inputs: { location: "https://x.example/login" } },
			]),
			// A 302 thrown by MIDDLEWARE never reaches the response emitter — it
			// leaves through the trigger's error branch. That is the leak the
			// safety net closes.
			"redirect-302": {
				_blokV2: true,
				_config: {
					name: "redirect-302",
					version: "1.0.0",
					middleware: true,
					trigger: {},
					steps: [{ id: "bounce", use: "@blokjs/throw", inputs: { message: "moved", code: 302 } }],
				},
			},
			"inertia-guarded": wf(
				"inertia-guarded",
				{ http: { method: "PUT", path: "/guarded", middleware: ["redirect-302"] } },
				[{ id: "page", use: "@blokjs/inertia", inputs: { component: "Home" } }],
			),
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

import { WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger.js";

const INERTIA = { "x-inertia": "true" };

async function buildApp() {
	const trigger = new HttpTrigger();
	await trigger.listen();
	return trigger.getApp();
}

function fetchIt(app: Awaited<ReturnType<typeof buildApp>>, path: string, init?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, init));
}

describe("HttpTrigger — @blokjs/inertia (v3)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
	});

	it("1 — a plain browser GET gets the HTML shell with the boot script", async () => {
		const res = await fetchIt(await buildApp(), "/users");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(res.headers.get("vary")).toBe("X-Inertia");
		expect(res.headers.get("x-inertia")).toBeNull();

		const html = await res.text();
		const raw = html.match(/<script type="application\/json" data-page="app">([\s\S]*?)<\/script>/)?.[1];
		expect(raw).toBeDefined();
		expect(raw).toContain("a\\/b");
		expect(JSON.parse(raw as string)).toEqual({
			component: "Users/Index",
			props: { path: "a/b", errors: {} },
			url: "/users",
			version: "v1",
		});
	});

	it("3 — the same route answers an Inertia visit with the page object", async () => {
		const res = await fetchIt(await buildApp(), "/users", { headers: INERTIA });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(res.headers.get("x-inertia")).toBe("true");
		expect(res.headers.get("vary")).toBe("X-Inertia");
		expect(await res.json()).toEqual({
			component: "Users/Index",
			props: { path: "a/b", errors: {} },
			url: "/users",
			version: "v1",
		});
	});

	it("10 — a stale asset version gets a 409 with no X-Inertia header", async () => {
		const app = await buildApp();
		const res = await fetchIt(app, "/users", { headers: { ...INERTIA, "x-inertia-version": "v0" } });
		expect(res.status).toBe(409);
		expect(res.headers.get("x-inertia-location")).toBe("/users");
		expect(res.headers.get("x-inertia-version")).toBe("v1");
		expect(res.headers.get("x-inertia")).toBeNull();
		expect(await res.text()).toBe("");
	});

	it("11 — location() leaves the trigger as 409 + X-Inertia-Location", async () => {
		const res = await fetchIt(await buildApp(), "/ext", { headers: INERTIA });
		expect(res.status).toBe(409);
		expect(res.headers.get("x-inertia-location")).toBe("https://x.example/login");
	});

	it("12 — a fragment redirect is a 409 + X-Inertia-Redirect, unless prefetching", async () => {
		const app = await buildApp();
		const res = await fetchIt(app, "/frag", { headers: INERTIA });
		expect(res.status).toBe(409);
		expect(res.headers.get("x-inertia-redirect")).toBe("/a#b");

		const prefetch = await fetchIt(app, "/frag", { headers: { ...INERTIA, purpose: "prefetch" } });
		expect(prefetch.status).toBe(302);
		expect(prefetch.headers.get("location")).toBe("/a#b");
	});

	it("13 — redirect() is 303 after DELETE and 302 after GET", async () => {
		const app = await buildApp();
		const del = await fetchIt(app, "/items", { method: "DELETE", headers: INERTIA });
		expect(del.status).toBe(303);
		expect(del.headers.get("location")).toBe("/items");

		const get = await fetchIt(app, "/items", { headers: INERTIA });
		expect(get.status).toBe(302);
	});

	it("14 — the safety net rewrites a middleware 302 to 303 on a PUT Inertia request", async () => {
		const app = await buildApp();
		const res = await fetchIt(app, "/guarded", {
			method: "PUT",
			headers: { ...INERTIA, "content-type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(303);
		// The body and Content-Type of the original 302 survive the rewrite.
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(await res.json()).toEqual({ error: "moved" });
	});

	it("14 — the safety net leaves a non-Inertia 302, and a GET 302, alone", async () => {
		const app = await buildApp();
		const noHeader = await fetchIt(app, "/guarded", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(noHeader.status).toBe(302);

		const get = await fetchIt(app, "/items", { headers: INERTIA });
		expect(get.status).toBe(302);
	});
});
