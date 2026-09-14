/**
 * #1012 tests 1–8 — the `inertia.csrf` middleware over a REAL `HttpTrigger`.
 *
 * The middleware is the actual `createCsrfMiddleware()` export from
 * `@blokjs/inertia`, registered by name through `Workflows.ts` exactly as an
 * app would and driven with `app.request(...)`: the cookie is really issued by
 * a middleware that runs before the page workflow, the rejection really comes
 * out of the trigger's error branch as a redirect, and the flash the client
 * sees on the bounce-back GET is really read back off the signed cookie.
 *
 * Harness mirrors `HttpTrigger.inertiaMiddleware.test.ts` (#996) — same OTel /
 * metrics / server mocks, same `@blokjs/inertia` workspace-link caveat.
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

vi.mock("../../src/Nodes", async (importActual) => {
	const actual = (await importActual()) as { default: Record<string, unknown> };
	const { defineNode } = await import("@blokjs/runner");
	const { RESPOND_BRAND } = await import("@blokjs/shared");
	const { rotateCsrf } = await import("@blokjs/inertia");
	const { z } = await import("zod");

	/** The app's own "who is signed in" node — the #996 middleware's `auth` step. */
	const currentUser = defineNode({
		name: "test/current-user",
		description: "Resolve the signed-in user from the request cookie.",
		input: z.object({ headers: z.record(z.unknown()).optional() }),
		output: z.object({ id: z.string().optional() }),
		async execute() {
			return { id: "u-1" };
		},
	});

	/** Test 8 — the session boundary that rotates the token. */
	const login = defineNode({
		name: "test/login",
		description: "Log in: rotate the CSRF token and answer 200.",
		input: z.object({}),
		output: z.object({
			[RESPOND_BRAND]: z.literal(true),
			body: z.unknown().optional(),
			status: z.number().optional(),
		}),
		async execute(ctx) {
			rotateCsrf(ctx);
			return { [RESPOND_BRAND]: true as const, status: 200, body: { ok: true } };
		},
	});

	return { default: { ...actual.default, "test/current-user": currentUser, "test/login": login } };
});

vi.mock("../../src/Workflows", async () => {
	const { createCsrfMiddleware, createSharedMiddleware } = await import("@blokjs/inertia");

	const ref = (step: string, ...path: string[]) => ({ $ref: { step, path } });

	/** A page route — the response that ISSUES the cookie. */
	const page = (name: string, path: string) => ({
		_blokV2: true,
		_config: {
			name,
			version: "1.0.0",
			trigger: { http: { method: "GET", path } },
			steps: [
				{
					id: "render",
					use: "@blokjs/inertia",
					inputs: {
						component: "Home",
						version: "v1",
						url: path,
						props: {},
						errors: ref("flash", "errors"),
						flash: ref("flash", "flash"),
						cookies: [ref("flash", "cookie")],
					},
				},
			],
		},
	});

	/** A write route that simply succeeds — what a verified token unlocks. */
	const write = (name: string, path: string, middleware?: string[]) => ({
		_blokV2: true,
		_config: {
			name,
			version: "1.0.0",
			trigger: { http: { method: "POST", path, ...(middleware ? { middleware } : {}) } },
			steps: [{ id: "ok", use: "@blokjs/respond", inputs: { body: { ok: true } } }],
		},
	});

	return {
		default: {
			home: page("home", "/"),
			orders: write("orders", "/orders"),
			webhook: write("webhook", "/webhooks/stripe"),
			// Per-ROUTE registration, with nothing in the global chain.
			guarded: write("guarded", "/guarded", ["inertia.csrf"]),
			login: {
				_blokV2: true,
				_config: {
					name: "login",
					version: "1.0.0",
					trigger: { http: { method: "POST", path: "/login" } },
					steps: [{ id: "in", use: "test/login", inputs: {} }],
				},
			},
			"inertia.shared": await createSharedMiddleware({ currentUser: { name: "test/current-user" } }),
			"inertia.csrf": await createCsrfMiddleware({ except: ["webhooks/*"] }),
			"inertia.csrf419": await createCsrfMiddleware({ name: "inertia.csrf419", onMismatch: "419" }),
			"inertia.csrfApi": await createCsrfMiddleware({ name: "inertia.csrfApi", apiExempt: true }),
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
import { csrfTokensMatch } from "@blokjs/shared";
import HttpTrigger from "../../src/runner/HttpTrigger.js";

const INERTIA = { "x-inertia": "true" };
const EXPIRED = "The page expired, please try again.";
let previousSecret: string | undefined;

type App = ReturnType<HttpTrigger["getApp"]>;

async function buildApp(globalMiddleware: string[] = ["inertia.shared", "inertia.csrf"]): Promise<App> {
	const trigger = new HttpTrigger();
	await trigger.listen();
	// After listen(): the route-table rebuild calls registry.clear().
	WorkflowRegistry.getInstance().setGlobalMiddleware(globalMiddleware);
	return trigger.getApp();
}

function fetchIt(app: App, path: string, init?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, init));
}

/** Every `Set-Cookie` on a response — the header legitimately repeats. */
function setCookies(res: Response): string[] {
	const all = res.headers.getSetCookie?.();
	if (all && all.length > 0) return all;
	const single = res.headers.get("set-cookie");
	return single ? [single] : [];
}

function cookieNamed(res: Response, name: string): string | undefined {
	return setCookies(res).find((cookie) => cookie.startsWith(`${name}=`));
}

/** `XSRF-TOKEN=abc; Path=/; …` -> `abc`. */
function cookieValue(raw: string | undefined): string {
	expect(raw).toBeTruthy();
	return (raw as string).split(";")[0]?.split("=").slice(1).join("=") as string;
}

/** A fresh token for the browser side of the double submit. */
async function issuedToken(app: App): Promise<string> {
	const res = await fetchIt(app, "/", { headers: INERTIA });
	return cookieValue(cookieNamed(res, "XSRF-TOKEN"));
}

describe("HttpTrigger — inertia.csrf (#1012)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		previousSecret = process.env.BLOK_FLASH_SECRET;
		process.env.BLOK_FLASH_SECRET = "integration-csrf-secret";
	});

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: the var must be ABSENT afterwards, not the string "undefined".
		if (previousSecret === undefined) delete process.env.BLOK_FLASH_SECRET;
		else process.env.BLOK_FLASH_SECRET = previousSecret;
	});

	// Test 1
	it("1 — a page response issues the XSRF-TOKEN cookie: 32 base64url bytes, readable by the client", async () => {
		const app = await buildApp();
		const res = await fetchIt(app, "/", { headers: INERTIA });
		expect(res.status).toBe(200);

		const cookie = cookieNamed(res, "XSRF-TOKEN");
		expect(cookie).toBeTruthy();
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain("SameSite=Lax");
		// NOT HttpOnly: the stock client has to read it back out of document.cookie.
		expect(cookie).not.toContain("HttpOnly");
		// Plain HTTP request → no Secure (it would make the cookie invisible).
		expect(cookie).not.toContain("Secure");
		expect(Buffer.from(cookieValue(cookie), "base64url")).toHaveLength(32);

		// …and the token reached the page as a shared prop, for the legacy
		// `<input name="_token">` pattern.
		const page = (await res.json()) as { props: { csrfToken?: string } };
		expect(page.props.csrfToken).toBe(cookieValue(cookie));

		// A request that already HAS the cookie is not re-issued one.
		const second = await fetchIt(app, "/", {
			headers: { ...INERTIA, cookie: `XSRF-TOKEN=${cookieValue(cookie)}` },
		});
		expect(cookieNamed(second, "XSRF-TOKEN")).toBeUndefined();
	});

	// Test 2
	it("2 — POST with a matching cookie + header passes through to the workflow", async () => {
		const app = await buildApp();
		const token = await issuedToken(app);

		const res = await fetchIt(app, "/orders", {
			method: "POST",
			headers: { ...INERTIA, "content-type": "application/json", cookie: `XSRF-TOKEN=${token}`, "x-xsrf-token": token },
			body: "{}",
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	// Test 3
	it("3 — a missing header bounces back 303 and the next GET shows the expiry flash", async () => {
		const app = await buildApp();
		const token = await issuedToken(app);

		const rejected = await fetchIt(app, "/orders", {
			method: "POST",
			headers: {
				...INERTIA,
				"content-type": "application/json",
				referer: "/orders/new",
				cookie: `XSRF-TOKEN=${token}`,
			},
			body: "{}",
		});
		expect(rejected.status).toBe(303);
		expect(rejected.headers.get("location")).toBe("/orders/new");
		const flash = cookieNamed(rejected, "blok_flash");
		expect(flash).toBeTruthy();

		const shown = await fetchIt(app, "/", {
			headers: { ...INERTIA, cookie: `XSRF-TOKEN=${token}; blok_flash=${cookieValue(flash)}` },
		});
		const page = (await shown.json()) as { flash?: { message?: string } };
		expect(page.flash?.message).toBe(EXPIRED);
	});

	// Test 4
	it("4 — a WRONG header is rejected the same way, and the compare is constant-time", async () => {
		const app = await buildApp();
		const token = await issuedToken(app);
		const wrong = `${"A".repeat(token.length - 1)}B`;
		expect(wrong).toHaveLength(token.length);

		const res = await fetchIt(app, "/orders", {
			method: "POST",
			headers: {
				...INERTIA,
				"content-type": "application/json",
				referer: "/orders/new",
				cookie: `XSRF-TOKEN=${token}`,
				"x-xsrf-token": wrong,
			},
			body: "{}",
		});
		expect(res.status).toBe(303);
		expect(cookieNamed(res, "blok_flash")).toBeTruthy();

		// Timing sanity check on the comparison itself rather than on 1000 HTTP
		// round-trips: the request path is dominated by routing, tracing and JSON,
		// which would bury the very difference this is looking for. A leaky
		// compare (`===` / byte loop) returns on the FIRST differing byte, so a
		// mismatch in byte 0 is orders of magnitude faster than a full match —
		// the bound is deliberately loose enough to survive a noisy CI box.
		const almost = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
		const firstByteOff = `${token.startsWith("A") ? "B" : "A"}${token.slice(1)}`;
		const round = (a: string, b: string) => {
			const started = process.hrtime.bigint();
			for (let i = 0; i < 20_000; i += 1) csrfTokensMatch(a, b);
			return Number(process.hrtime.bigint() - started);
		};
		// The MINIMUM of several rounds, not one sample: the loop is ~2ms and a
		// vitest worker shares the box with 45 other suites, so an average would
		// measure the scheduler. The cleanest round is the one that got the CPU.
		const best = (a: string, b: string) => {
			let fastest = Number.POSITIVE_INFINITY;
			for (let r = 0; r < 7; r += 1) fastest = Math.min(fastest, round(a, b));
			return fastest;
		};
		best(token, token); // warm the JIT before measuring
		const matches = best(token, token);
		for (const mismatch of [best(token, almost), best(token, firstByteOff)]) {
			expect(mismatch / matches).toBeGreaterThan(0.3);
			expect(mismatch / matches).toBeLessThan(3);
		}
	});

	// Test 5
	it("5 — a legacy form post is accepted on the `_token` field (and is NOT exempt for lacking X-Inertia)", async () => {
		const app = await buildApp();
		const token = await issuedToken(app);

		const accepted = await fetchIt(app, "/orders", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", cookie: `XSRF-TOKEN=${token}` },
			body: new URLSearchParams({ _token: token, sku: "abc" }).toString(),
		});
		expect(accepted.status).toBe(200);

		// Same request without the field: a non-Inertia request is only exempt
		// when the app opts in with `apiExempt`.
		const rejected = await fetchIt(app, "/orders", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", cookie: `XSRF-TOKEN=${token}` },
			body: new URLSearchParams({ sku: "abc" }).toString(),
		});
		expect(rejected.status).toBe(303);

		// …and with `apiExempt: true` that same request sails through.
		const api = await buildApp(["inertia.shared", "inertia.csrfApi"]);
		const exempted = await fetchIt(api, "/orders", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", cookie: `XSRF-TOKEN=${token}` },
			body: new URLSearchParams({ sku: "abc" }).toString(),
		});
		expect(exempted.status).toBe(200);
	});

	// Test 6
	it("6 — `onMismatch: '419'` answers a 419 JSON body instead of redirecting", async () => {
		const app = await buildApp(["inertia.shared", "inertia.csrf419"]);
		const token = await issuedToken(app);

		const res = await fetchIt(app, "/orders", {
			method: "POST",
			headers: { ...INERTIA, "content-type": "application/json", cookie: `XSRF-TOKEN=${token}` },
			body: "{}",
		});
		expect(res.status).toBe(419);
		expect(res.headers.get("location")).toBeNull();
		expect(await res.json()).toEqual({ error: EXPIRED, code: "csrf_token_mismatch" });
	});

	// Test 7
	it("7 — an `except` glob exempts the webhook route from verification", async () => {
		const app = await buildApp();
		const res = await fetchIt(app, "/webhooks/stripe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "evt_1" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		// The glob is a rule, not a blanket pass: a sibling route is still guarded.
		const guarded = await fetchIt(app, "/orders", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(guarded.status).toBe(303);
	});

	// Test 8
	it("8 — `rotateCsrf()` issues a new cookie and the old token stops working", async () => {
		const app = await buildApp();
		const token = await issuedToken(app);

		const loggedIn = await fetchIt(app, "/login", {
			method: "POST",
			headers: { ...INERTIA, "content-type": "application/json", cookie: `XSRF-TOKEN=${token}`, "x-xsrf-token": token },
			body: "{}",
		});
		expect(loggedIn.status).toBe(200);
		const rotated = cookieValue(cookieNamed(loggedIn, "XSRF-TOKEN"));
		expect(rotated).not.toBe(token);
		expect(Buffer.from(rotated, "base64url")).toHaveLength(32);

		// The browser now holds the rotated cookie; a replay of the OLD token is
		// no longer the other half of the double submit.
		const replay = await fetchIt(app, "/orders", {
			method: "POST",
			headers: {
				...INERTIA,
				"content-type": "application/json",
				cookie: `XSRF-TOKEN=${rotated}`,
				"x-xsrf-token": token,
			},
			body: "{}",
		});
		expect(replay.status).toBe(303);

		const accepted = await fetchIt(app, "/orders", {
			method: "POST",
			headers: {
				...INERTIA,
				"content-type": "application/json",
				cookie: `XSRF-TOKEN=${rotated}`,
				"x-xsrf-token": rotated,
			},
			body: "{}",
		});
		expect(accepted.status).toBe(200);
	});

	it("guards a route registered PER ROUTE, with nothing in the global chain", async () => {
		const app = await buildApp(["inertia.shared"]);

		// No cookie at all: the guard rejects AND issues one, so the retry has
		// the other half of the double submit.
		const rejected = await fetchIt(app, "/guarded", {
			method: "POST",
			headers: { ...INERTIA, "content-type": "application/json" },
			body: "{}",
		});
		expect(rejected.status).toBe(303);
		const token = cookieValue(cookieNamed(rejected, "XSRF-TOKEN"));

		const accepted = await fetchIt(app, "/guarded", {
			method: "POST",
			headers: { ...INERTIA, "content-type": "application/json", cookie: `XSRF-TOKEN=${token}`, "x-xsrf-token": token },
			body: "{}",
		});
		expect(accepted.status).toBe(200);

		// The unguarded twin proves the 303 above came from the ROUTE's chain.
		const unguarded = await fetchIt(app, "/orders", {
			method: "POST",
			headers: { ...INERTIA, "content-type": "application/json" },
			body: "{}",
		});
		expect(unguarded.status).toBe(200);
	});
});
