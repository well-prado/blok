/**
 * Issue #1013 over a REAL `HttpTrigger` — the wire half of the Inertia
 * security surface: the `inertia.encryptHistory` MIDDLEWARE marking a route
 * group, the logout `303`, the `clearHistory` flag on the page that follows,
 * and `authorize()`'s `403` body actually reaching the response.
 *
 * Same shape as `HttpTrigger.inertia.test.ts` (#994): workflows are booted
 * through the trigger and driven with `app.fetch(new Request(...))`, so the
 * whole shipped path runs — route table -> middleware chain -> runner -> node
 * -> `RespondEnvelope` / `GlobalError` -> `emitWorkflowResponse` -> HTTP.
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

// The #1013 nodes ship in `@blokjs/inertia` but are NOT in `HELPER_NODES` —
// that map is `@blokjs/helpers`' to extend, and the typed DSL passes the node
// OBJECT to `step()` anyway. Register them here the way a project's `Nodes.ts`
// would, on top of the real registry.
vi.mock("../../src/Nodes", async () => {
	const [{ HELPER_NODES }, inertia] = await Promise.all([import("@blokjs/helpers"), import("@blokjs/inertia")]);
	return {
		default: {
			...HELPER_NODES,
			"@blokjs/inertia": inertia.default,
			"@blokjs/inertia.history": inertia.historyNode,
			"@blokjs/inertia.logout": inertia.logoutNode,
			"@blokjs/inertia.authorize": inertia.authorizeNode,
		},
	};
});

vi.mock("../../src/Workflows", async () => {
	const { encryptHistoryMiddleware } = await import("@blokjs/inertia");
	const wf = (name: string, trigger: unknown, steps: unknown[]) => ({
		_blokV2: true,
		_config: { name, version: "1.0.0", trigger, steps },
	});
	const page = (component: string) => ({
		id: "page",
		use: "@blokjs/inertia",
		inputs: { component, version: "v1" },
	});
	return {
		default: {
			// The middleware itself — a trigger-less `middleware: true` workflow.
			"inertia.encryptHistory": await encryptHistoryMiddleware(),
			// A route group that opted into encrypted history.
			"secret-page": wf(
				"secret-page",
				{ http: { method: "GET", path: "/secret", middleware: ["inertia.encryptHistory"] } },
				[page("Secret")],
			),
			// The same page WITHOUT the middleware — the control. NOT mounted at
			// `/public`: that prefix belongs to the static-asset handler, which
			// this file mocks into a handler that returns nothing.
			"public-page": wf("public-page", { http: { method: "GET", path: "/plain" } }, [page("Public")]),
			// Logout: the redirect leaves as the response.
			logout: wf("logout", { http: { method: "POST", path: "/logout" } }, [
				{ id: "out", use: "@blokjs/inertia.logout", inputs: { redirectTo: "/login" } },
			]),
			// Logout that renders the next page in the same request: the page
			// picks the clearHistory mark up.
			"logout-render": wf("logout-render", { http: { method: "POST", path: "/logout-render" } }, [
				{ id: "out", use: "@blokjs/inertia.logout", inputs: {} },
				page("Auth/Login"),
			]),
			// A guarded route: authorize() denies, and the 403 body is the response.
			"guarded-page": wf("guarded-page", { http: { method: "GET", path: "/posts/1/edit" } }, [
				{ id: "guard", use: "@blokjs/inertia.authorize", inputs: { ability: "edit", allowed: false } },
				page("Posts/Edit"),
			]),
			"allowed-page": wf("allowed-page", { http: { method: "GET", path: "/posts/2/edit" } }, [
				{ id: "guard", use: "@blokjs/inertia.authorize", inputs: { ability: "edit", allowed: true } },
				page("Posts/Edit"),
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

describe("HttpTrigger — @blokjs/inertia security (#1013)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
	});

	it("1 — the inertia.encryptHistory middleware puts encryptHistory on the route's page", async () => {
		const app = await buildApp();
		const guarded = await fetchIt(app, "/secret", { headers: INERTIA });
		expect(guarded.status).toBe(200);
		expect(await guarded.json()).toMatchObject({ component: "Secret", encryptHistory: true });

		// No middleware on this route -> the field is absent, never `false`.
		const plain = await fetchIt(app, "/plain", { headers: INERTIA });
		expect(await plain.json()).not.toHaveProperty("encryptHistory");
	});

	it("2 — logout answers 303 to /login", async () => {
		const res = await fetchIt(await buildApp(), "/logout", { method: "POST", headers: INERTIA });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/login");
	});

	it("2 — a page rendered after logout carries clearHistory: true", async () => {
		const res = await fetchIt(await buildApp(), "/logout-render", { method: "POST", headers: INERTIA });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ component: "Auth/Login", clearHistory: true });
	});

	it("3 — authorize() denies with 403 and { error: 'forbidden', ability }", async () => {
		const res = await fetchIt(await buildApp(), "/posts/1/edit", { headers: INERTIA });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "forbidden", ability: "edit" });
	});

	it("3 — authorize() lets an allowed ability through to the page", async () => {
		const res = await fetchIt(await buildApp(), "/posts/2/edit", { headers: INERTIA });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ component: "Posts/Edit" });
	});
});
