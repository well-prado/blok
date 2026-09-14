/**
 * #1015 test 5 — `inertia.page()`, the controller-less route, over a REAL
 * `HttpTrigger`.
 *
 * The route exists only because `inertia.page("/about", "About")` generated a
 * workflow in `Workflows.ts`: there is no workflow file and no node of the
 * app's own anywhere in this test. Driving it with `app.fetch` proves the
 * generated workflow is routed, executed and serialized like any other — and
 * that adapter-wide `share()` data reaches it, since the registry is resolved
 * by the serializer these routes use.
 *
 * `@blokjs/inertia` is imported without being a manifest dependency of this
 * package, for the same reason `HttpTrigger.inertiaMiddleware.test.ts` does it:
 * the scaffold copies this package.json into generated projects, and a
 * dependency on a package that is not on npm breaks `blokctl create`. The
 * workspace link is what resolves it here.
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

vi.mock("../../src/Workflows", async () => {
	const { inertia, share } = await import("@blokjs/inertia");

	// Adapter bootstrap, exactly where an app would put it.
	share("appName", "Blok");
	share("auth", (req: unknown) => {
		const cookie = String((req as { headers?: Record<string, unknown> })?.headers?.cookie ?? "");
		return cookie.includes("session=ada") ? { id: "u-1", name: "Ada" } : null;
	});

	return {
		default: {
			about: await inertia.page("/about", "About", { team: "Blok" }, { inputs: { version: "v1" } }),
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

type App = ReturnType<HttpTrigger["getApp"]>;

async function buildApp(): Promise<App> {
	const trigger = new HttpTrigger();
	await trigger.listen();
	return trigger.getApp();
}

function fetchIt(app: App, path: string, init?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, init));
}

interface PageBody {
	component: string;
	props: Record<string, unknown>;
	url: string;
	version: string;
	sharedProps?: string[];
}

describe("#1015 — inertia.page(): a route with no controller", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
	});

	// Test 5
	it("5 — GET /about renders the About component with its static props", async () => {
		const res = await fetchIt(await buildApp(), "/about", { headers: INERTIA });
		expect(res.status).toBe(200);
		expect(res.headers.get("x-inertia")).toBe("true");

		const page = (await res.json()) as PageBody;
		expect(page.component).toBe("About");
		expect(page.url).toBe("/about");
		expect(page.version).toBe("v1");
		expect(page.props.team).toBe("Blok");
		expect(page.props.errors).toEqual({});
	});

	it("5 — the same route answers a browser GET with the HTML shell", async () => {
		const res = await fetchIt(await buildApp(), "/about");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		const raw = html.match(/<script type="application\/json" data-page="app">([\s\S]*?)<\/script>/)?.[1];
		expect(JSON.parse(raw as string).component).toBe("About");
	});

	// Tests 1 + 2, end-to-end: the registry is adapter-wide, so a
	// controller-less route gets shared data with no wiring at all.
	it("1/2 — shared data reaches a controller-less route, lazily and per request", async () => {
		const app = await buildApp();

		const guest = (await (await fetchIt(app, "/about", { headers: INERTIA })).json()) as PageBody;
		expect(guest.props.appName).toBe("Blok");
		expect(guest.props.auth).toBeNull();
		expect(guest.sharedProps).toEqual(["appName", "auth"]);

		const signedIn = (await (
			await fetchIt(app, "/about", { headers: { ...INERTIA, cookie: "session=ada" } })
		).json()) as PageBody;
		expect(signedIn.props.auth).toEqual({ id: "u-1", name: "Ada" });
	});
});
