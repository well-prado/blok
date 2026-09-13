/**
 * #996 tests 7–12 and 14 — the Inertia middleware pack over a REAL
 * `HttpTrigger`.
 *
 * The middleware workflows are the actual `createSharedMiddleware()` /
 * `createAuthMiddleware()` exports from `@blokjs/inertia`, registered by name
 * through `Workflows.ts` exactly as an app would, and driven with
 * `app.request(...)`. Nothing about the chain is simulated: the guest guard
 * really short-circuits before the page workflow, and the flash cookie really
 * survives a redirect and gets cleared by the render that consumes it.
 *
 * Harness mirrors `HttpTrigger.inertia.test.ts` (#994) — same OTel/metrics/
 * server mocks — plus `../../src/Nodes` extended with the app-side nodes an
 * Inertia project supplies itself (`currentUser`, the failing POST handler and
 * a run probe).
 *
 * `@blokjs/inertia` is imported here WITHOUT being a manifest dependency of
 * this package, deliberately and for the same reason `src/Nodes.ts` reaches it
 * through a non-literal specifier: the scaffold copies this package.json into
 * generated projects, and a dependency on a package that is not yet on npm
 * breaks `blokctl create` (only the scaffold E2E catches it). The workspace
 * link is what resolves it here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/** Cross-boundary recorder: written by the probe node, read by the tests. */
const probe = vi.hoisted(() => ({ ran: [] as string[] }));

vi.mock("../../src/Nodes", async (importActual) => {
	const actual = (await importActual()) as { default: Record<string, unknown> };
	const { defineNode } = await import("@blokjs/runner");
	const { redirectBack } = await import("@blokjs/inertia");
	const { z } = await import("zod");

	/** The app's own "who is signed in" node — `session=ada` means Ada. */
	const currentUser = defineNode({
		name: "test/current-user",
		description: "Resolve the signed-in user from the request cookie.",
		input: z.object({ headers: z.record(z.unknown()).optional() }),
		output: z.object({ id: z.string().optional(), name: z.string().optional() }),
		async execute(_ctx, input) {
			const cookie = String(input.headers?.cookie ?? "");
			return cookie.includes("session=ada") ? { id: "u-1", name: "Ada" } : {};
		},
	});

	/** Records that a PAGE workflow step actually executed. */
	const probeNode = defineNode({
		name: "test/probe",
		description: "Record that a page workflow ran.",
		input: z.object({ tag: z.string() }),
		output: z.object({ tag: z.string() }),
		async execute(_ctx, input) {
			probe.ran.push(input.tag);
			return { tag: input.tag };
		},
	});

	/** A write that fails validation and bounces back with errors + flash. */
	const createOrder = defineNode({
		name: "test/create-order",
		description: "Reject an order without a sku by redirecting back with errors.",
		input: z.object({ body: z.record(z.unknown()).optional() }),
		output: z.unknown(),
		async execute(ctx, input) {
			const body = input.body ?? {};
			const request = ctx.request as unknown as { headers?: Record<string, unknown>; method?: string };
			return redirectBack(
				{ headers: request?.headers, method: request?.method },
				{
					errors: { sku: "Required." },
					...(typeof body.bag === "string" ? { bag: body.bag } : {}),
					flash: { toast: "Check the form." },
					fallback: "/orders",
				},
			);
		},
	});

	return {
		default: {
			...actual.default,
			"test/current-user": currentUser,
			"test/probe": probeNode,
			"test/create-order": createOrder,
		},
	};
});

vi.mock("../../src/Workflows", async () => {
	const { createAuthMiddleware, createSharedMiddleware } = await import("@blokjs/inertia");

	const ref = (step: string, ...path: string[]) => ({ $ref: { step, path } });
	/** A page route: probe first (so "did it run?" is observable), then render. */
	const page = (name: string, path: string, middleware?: string[]) => ({
		_blokV2: true,
		_config: {
			name,
			version: "1.0.0",
			trigger: { http: { method: "GET", path, ...(middleware ? { middleware } : {}) } },
			steps: [
				{ id: "probe", use: "test/probe", inputs: { tag: name } },
				{
					id: "render",
					use: "@blokjs/inertia",
					inputs: {
						component: "Orders/Index",
						version: "v1",
						url: path,
						props: { auth: ref("auth") },
						errors: ref("flash", "errors"),
						errorBag: ref("flash", "bag"),
						flash: ref("flash", "flash"),
						// #1013 via #996 — `logoutResponse()` flashed the mark; the
						// page after the redirect is where the client acts on it.
						clearHistory: ref("flash", "clearHistory"),
						// One-shot: the render that consumed the flash expires it.
						cookies: [ref("flash", "cookie")],
					},
				},
			],
		},
	});

	return {
		default: {
			"inertia.shared": await createSharedMiddleware({ currentUser: { name: "test/current-user" } }),
			"inertia.auth": await createAuthMiddleware(),
			orders: page("orders", "/orders", ["inertia.auth"]),
			"orders-open": page("orders-open", "/orders/open"),
			broken: page("broken", "/broken", ["nope"]),
			"orders-create": {
				_blokV2: true,
				_config: {
					name: "orders-create",
					version: "1.0.0",
					trigger: { http: { method: "POST", path: "/orders" } },
					steps: [{ id: "create", use: "test/create-order", inputs: { body: ref("@trigger", "body") } }],
				},
			},
			// #1013's logout node, straight out of HELPER_NODES by its ref.
			logout: {
				_blokV2: true,
				_config: {
					name: "logout",
					version: "1.0.0",
					trigger: { http: { method: "POST", path: "/logout" } },
					steps: [{ id: "out", use: "@blokjs/inertia.logout", inputs: { redirectTo: "/orders/open" } }],
				},
			},
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
const SIGNED_IN = { cookie: "session=ada" };
let previousSecret: string | undefined;

type App = ReturnType<HttpTrigger["getApp"]>;

/** Boot the trigger and put `inertia.shared` in the PROCESS-GLOBAL chain. */
async function buildApp(globalMiddleware: string[] = ["inertia.shared"]): Promise<App> {
	const trigger = new HttpTrigger();
	await trigger.listen();
	// After listen(): the route-table rebuild calls registry.clear().
	WorkflowRegistry.getInstance().setGlobalMiddleware(globalMiddleware);
	return trigger.getApp();
}

function fetchIt(app: App, path: string, init?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, init));
}

/** `blok_flash=<token>; Path=/; …` -> `blok_flash=<token>` for a Cookie header. */
function cookiePair(setCookie: string | null): string {
	expect(setCookie).toBeTruthy();
	return (setCookie as string).split(";")[0];
}

describe("HttpTrigger — Inertia middleware pack (#996)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		previousSecret = process.env.BLOK_FLASH_SECRET;
		process.env.BLOK_FLASH_SECRET = "integration-flash-secret";
		probe.ran.length = 0;
	});

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: the var must be ABSENT afterwards, not the string "undefined".
		if (previousSecret === undefined) delete process.env.BLOK_FLASH_SECRET;
		else process.env.BLOK_FLASH_SECRET = previousSecret;
	});

	// Test 7
	it("7 — a guest hitting an `inertia.auth` route gets 302 /login and the page never runs", async () => {
		const res = await fetchIt(await buildApp(), "/orders", { headers: INERTIA });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/login");
		expect(probe.ran).toEqual([]);
	});

	// Test 8
	it("8 — the same route with a session renders, with props.auth.id", async () => {
		const res = await fetchIt(await buildApp(), "/orders", { headers: { ...INERTIA, ...SIGNED_IN } });
		expect(res.status).toBe(200);
		const page = (await res.json()) as { props: { auth: { id: string; name: string }; errors: unknown } };
		expect(page.props.auth).toEqual({ id: "u-1", name: "Ada" });
		expect(page.props.errors).toEqual({});
		expect(probe.ran).toEqual(["orders"]);
	});

	// Test 9 + 10
	it("9/10 — POST invalid → 303 + flash cookie; the next GET shows the errors and clears it", async () => {
		const app = await buildApp();

		const posted = await fetchIt(app, "/orders", {
			method: "POST",
			headers: { ...INERTIA, "content-type": "application/json", referer: "/orders" },
			body: "{}",
		});
		expect(posted.status).toBe(303);
		expect(posted.headers.get("location")).toBe("/orders");
		const flashCookie = posted.headers.get("set-cookie");
		expect(flashCookie).toContain("blok_flash=");
		expect(flashCookie).toContain("HttpOnly");

		// The bounce-back GET: errors land in props.errors, flash on the page
		// object, and the response expires the cookie it just consumed.
		const shown = await fetchIt(app, "/orders", {
			headers: { ...INERTIA, ...SIGNED_IN, cookie: `session=ada; ${cookiePair(flashCookie)}` },
		});
		expect(shown.status).toBe(200);
		const page = (await shown.json()) as { props: { errors: Record<string, string> }; flash?: unknown };
		expect(page.props.errors.sku).toBe("Required.");
		expect(page.flash).toEqual({ toast: "Check the form." });
		expect(shown.headers.get("set-cookie")).toContain("Max-Age=0");

		// One-shot: a second GET (the browser dropped the cookie) has nothing.
		const again = await fetchIt(app, "/orders", { headers: { ...INERTIA, ...SIGNED_IN } });
		const secondPage = (await again.json()) as { props: { errors: Record<string, string> }; flash?: unknown };
		expect(secondPage.props.errors).toEqual({});
		expect(secondPage.flash).toBeUndefined();
	});

	// Test 14
	it("14 — an error BAG survives the redirect and nests the errors on the next GET", async () => {
		const app = await buildApp();
		const posted = await fetchIt(app, "/orders", {
			method: "POST",
			headers: { ...INERTIA, "content-type": "application/json", referer: "/orders" },
			body: JSON.stringify({ bag: "createOrder" }),
		});
		expect(posted.status).toBe(303);

		const shown = await fetchIt(app, "/orders", {
			headers: { ...INERTIA, ...SIGNED_IN, cookie: `session=ada; ${cookiePair(posted.headers.get("set-cookie"))}` },
		});
		const page = (await shown.json()) as { props: { errors: Record<string, Record<string, string>> } };
		expect(page.props.errors).toEqual({ createOrder: { sku: "Required." } });
	});

	// Test 11
	it("11 — the global chain runs on every page route, including one with no chain of its own", async () => {
		const app = await buildApp();
		const res = await fetchIt(app, "/orders/open", { headers: { ...INERTIA, ...SIGNED_IN } });
		expect(res.status).toBe(200);
		const page = (await res.json()) as { props: { auth: { id: string } } };
		expect(page.props.auth.id).toBe("u-1");
		expect(probe.ran).toEqual(["orders-open"]);

		// …and with NO global chain the same route cannot resolve `auth`/`flash`
		// at all — proof those props came from the middleware, not the page.
		const bare = await buildApp([]);
		const without = await fetchIt(bare, "/orders/open", { headers: { ...INERTIA, ...SIGNED_IN } });
		expect(without.status).toBeGreaterThanOrEqual(400);
		expect(await without.text()).toContain("flash");
	});

	// Test 12
	it("12 — an unknown middleware name fails loudly, naming the missing middleware", async () => {
		const res = await fetchIt(await buildApp(), "/broken", { headers: INERTIA });
		expect(res.status).toBeGreaterThanOrEqual(400);
		const body = await res.text();
		expect(body).toContain("nope");
		expect(probe.ran).toEqual([]);
	});

	// #1013's `TODO(#996)`, resolved: the clearHistory mark is request-scoped,
	// and logout is a redirect, so without the flash cookie the page the user
	// actually lands on never learns to rotate the client's history key.
	it("carries clearHistory across the logout redirect, once", async () => {
		const app = await buildApp();

		const loggedOut = await fetchIt(app, "/logout", { method: "POST", headers: INERTIA });
		expect(loggedOut.status).toBe(303);
		expect(loggedOut.headers.get("location")).toBe("/orders/open");
		const flashCookie = loggedOut.headers.get("set-cookie");
		expect(flashCookie).toContain("blok_flash=");

		const landed = await fetchIt(app, "/orders/open", {
			headers: { ...INERTIA, ...SIGNED_IN, cookie: `session=ada; ${cookiePair(flashCookie)}` },
		});
		expect(((await landed.json()) as { clearHistory?: true }).clearHistory).toBe(true);
		expect(landed.headers.get("set-cookie")).toContain("Max-Age=0");

		// One-shot here too: the very next page must not re-clear the history.
		const after = await fetchIt(app, "/orders/open", { headers: { ...INERTIA, ...SIGNED_IN } });
		expect(((await after.json()) as { clearHistory?: true }).clearHistory).toBeUndefined();
	});

	it("a guest POST redirect is a 303, so the safety net never has to rewrite it", async () => {
		const app = await buildApp();
		const res = await fetchIt(app, "/orders", {
			method: "POST",
			headers: { ...INERTIA, "content-type": "application/json" },
			body: "{}",
		});
		// No Referer → the fallback, still a 303 after a POST.
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/orders");
	});
});
