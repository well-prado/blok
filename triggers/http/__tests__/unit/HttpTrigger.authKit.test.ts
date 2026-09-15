/**
 * #1018 integration tests 1–5 — the auth starter kit over a REAL `HttpTrigger`.
 *
 * Nothing here is simulated. The workflows are `authWorkflows()` from
 * `@blokjs/auth/examples` verbatim; the middleware chain is
 * `authKitMiddleware()` registered through `Workflows.ts` and
 * `setGlobalMiddleware`, exactly as an app would; the nodes are
 * `SESSION_NODES` + `AUTH_NODES`. Requests go through `app.fetch` with a cookie
 * jar that behaves like a browser — it honours `Max-Age=0` — so the CSRF
 * double-submit, the session cookie and the one-shot flash cookie are all
 * exercised for real.
 *
 * Harness mirrors `HttpTrigger.inertiaMiddleware.test.ts` (#996): same OTel /
 * metrics / server mocks, same "import a workspace package that is not a
 * manifest dependency" arrangement (a dependency on a package that is not yet
 * on npm would break `blokctl create`; the workspace link is what resolves it
 * here).
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
	const { AUTH_NODES } = await import("@blokjs/auth");
	const { SESSION_NODES } = await import("@blokjs/session");
	return { default: { ...actual.default, ...SESSION_NODES, ...AUTH_NODES } };
});

vi.mock("../../src/Workflows", async () => {
	const { authKitMiddleware } = await import("@blokjs/auth");
	const { authWorkflows } = await import("@blokjs/auth/examples");
	return { default: { ...(await authKitMiddleware()), ...(await authWorkflows()) } };
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

import { AUTH_KIT_CHAIN, MemoryUserStore, _resetAuth, _resetThrottle, configureAuth, hashPassword } from "@blokjs/auth";
import { WorkflowRegistry } from "@blokjs/runner";
import { MemorySessionStore, SESSION_COOKIE, _resetSession, configureSession } from "@blokjs/session";
import HttpTrigger from "../../src/runner/HttpTrigger.js";

const SESSION_SECRET = "integration-session-secret-value";
const FLASH_SECRET = "integration-flash-secret";
const INERTIA = { "x-inertia": "true" };

type App = ReturnType<HttpTrigger["getApp"]>;

/**
 * A browser-ish cookie jar: absorbs every `Set-Cookie`, drops the ones sent
 * with `Max-Age=0`, and replays the rest. Without the expiry rule the one-shot
 * flash and the logout clear would be invisible.
 */
class Jar {
	private readonly cookies = new Map<string, string>();

	absorb(res: Response): void {
		for (const raw of res.headers.getSetCookie()) {
			const pair = raw.split(";")[0] as string;
			const eq = pair.indexOf("=");
			const name = pair.slice(0, eq);
			if (/max-age=0\b/i.test(raw)) this.cookies.delete(name);
			else this.cookies.set(name, pair.slice(eq + 1));
		}
	}

	get(name: string): string | undefined {
		return this.cookies.get(name);
	}

	header(): string {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
	}
}

let users: MemoryUserStore;
let sent: { email: string; token: string; url: string }[];

async function buildApp(): Promise<App> {
	const trigger = new HttpTrigger();
	await trigger.listen();
	// After listen(): the route-table rebuild calls registry.clear().
	WorkflowRegistry.getInstance().setGlobalMiddleware([...AUTH_KIT_CHAIN]);
	return trigger.getApp();
}

function get(app: App, path: string, jar: Jar, headers: Record<string, string> = {}): Promise<Response> {
	const cookie = jar.header();
	return app
		.fetch(new Request(`http://localhost${path}`, { headers: { ...headers, ...(cookie ? { cookie } : {}) } }))
		.then((res: Response) => {
			jar.absorb(res);
			return res;
		});
}

/** A real double-submit POST: the `XSRF-TOKEN` cookie echoed in `X-XSRF-TOKEN`. */
function post(
	app: App,
	path: string,
	body: unknown,
	jar: Jar,
	headers: Record<string, string> = {},
): Promise<Response> {
	const token = jar.get("XSRF-TOKEN");
	return app
		.fetch(
			new Request(`http://localhost${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(token ? { "x-xsrf-token": token } : {}),
					...headers,
					cookie: jar.header(),
				},
				body: JSON.stringify(body),
			}),
		)
		.then((res: Response) => {
			jar.absorb(res);
			return res;
		});
}

/** Prime a jar with the CSRF cookie the guard issues on the first visit. */
async function visitorAt(app: App, path: string): Promise<Jar> {
	const jar = new Jar();
	await get(app, path, jar, INERTIA);
	return jar;
}

interface PageObject {
	component: string;
	props: { auth: { user: { id: string; name: string; email: string } | null }; errors: Record<string, string> };
	flash?: Record<string, unknown>;
	clearHistory?: boolean;
	encryptHistory?: boolean;
}

async function page(res: Response): Promise<PageObject> {
	return (await res.json()) as PageObject;
}

describe("HttpTrigger — auth starter kit (#1018)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		process.env.BLOK_SESSION_SECRET = SESSION_SECRET;
		process.env.BLOK_FLASH_SECRET = FLASH_SECRET;

		_resetAuth();
		_resetSession();
		_resetThrottle();
		users = new MemoryUserStore();
		sent = [];
		configureAuth({
			users,
			secret: SESSION_SECRET,
			sendResetLink: (link) => {
				sent.push(link);
			},
		});
		configureSession({ store: new MemorySessionStore(), secret: SESSION_SECRET });
	});

	afterEach(() => {
		_resetAuth();
		_resetSession();
		_resetThrottle();
		// biome-ignore lint/performance/noDelete: the vars must be ABSENT afterwards.
		delete process.env.BLOK_SESSION_SECRET;
		// biome-ignore lint/performance/noDelete: the vars must be ABSENT afterwards.
		delete process.env.BLOK_FLASH_SECRET;
	});

	// ── Test 1 ────────────────────────────────────────────────────────────────
	it("1 — register → 303 to the dashboard, a session cookie, and auth.user on the next page", async () => {
		const app = await buildApp();
		const jar = await visitorAt(app, "/register");

		const registered = await post(
			app,
			"/register",
			{ name: "Ada", email: "ada@example.com", password: "lovelace-1843", passwordConfirmation: "lovelace-1843" },
			jar,
			{ ...INERTIA, referer: "/register" },
		);

		expect(registered.status).toBe(303);
		expect(registered.headers.get("location")).toBe("/dashboard");
		const sessionCookie = registered.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
		expect(sessionCookie).toBeTruthy();
		expect(sessionCookie).toContain("HttpOnly");
		expect(sessionCookie).toContain("SameSite=Lax");
		expect(await users.findByEmail("ada@example.com")).toBeTruthy();

		const dashboard = await get(app, "/dashboard", jar, INERTIA);
		expect(dashboard.status).toBe(200);
		const body = await page(dashboard);
		expect(body.component).toBe("Dashboard");
		expect(body.props.auth.user).toMatchObject({ name: "Ada", email: "ada@example.com" });
	});

	// ── Test 2 ────────────────────────────────────────────────────────────────
	it("2 — wrong password → 303 back with props.errors.email; the 6th attempt in a minute is throttled", async () => {
		await users.create({ name: "Ada", email: "ada@example.com", passwordHash: await hashPassword("lovelace-1843") });
		const app = await buildApp();
		const jar = await visitorAt(app, "/login");

		const bad = await post(app, "/login", { email: "ada@example.com", password: "wrong-password" }, jar, {
			...INERTIA,
			referer: "/login",
		});
		expect(bad.status).toBe(303);
		expect(bad.headers.get("location")).toBe("/login");

		const shown = await page(await get(app, "/login", jar, INERTIA));
		expect(shown.props.errors.email).toBe("These credentials do not match our records.");

		// Attempts 2–5 still reach the credential check; the 6th does not.
		for (let attempt = 2; attempt <= 5; attempt += 1) {
			const res = await post(app, "/login", { email: "ada@example.com", password: "wrong-password" }, jar, {
				...INERTIA,
				referer: "/login",
			});
			expect(res.status).toBe(303);
		}

		const throttled = await post(app, "/login", { email: "ada@example.com", password: "lovelace-1843" }, jar, {
			...INERTIA,
			referer: "/login",
		});
		expect(throttled.status).toBe(303);
		expect(throttled.headers.get("retry-after")).toBeTruthy();
		const after = await page(await get(app, "/login", jar, INERTIA));
		expect(String(after.flash?.error)).toMatch(/Too many login attempts/);
		expect(after.props.errors.email).toMatch(/Too many login attempts/);
		// Even the RIGHT password did not sign anyone in.
		expect(after.props.auth.user).toBeNull();
	});

	// ── Test 3 ────────────────────────────────────────────────────────────────
	it("3 — logout → 303, the session is gone, the next page carries clearHistory, and the CSRF token changed", async () => {
		await users.create({ name: "Ada", email: "ada@example.com", passwordHash: await hashPassword("lovelace-1843") });
		const app = await buildApp();
		const jar = await visitorAt(app, "/login");

		const loggedIn = await post(app, "/login", { email: "ada@example.com", password: "lovelace-1843" }, jar, {
			...INERTIA,
			referer: "/login",
		});
		expect(loggedIn.status).toBe(303);
		expect(loggedIn.headers.get("location")).toBe("/dashboard");
		const sessionBefore = jar.get(SESSION_COOKIE);
		const csrfBefore = jar.get("XSRF-TOKEN");
		expect(sessionBefore).toBeTruthy();
		expect((await page(await get(app, "/dashboard", jar, INERTIA))).props.auth.user).toBeTruthy();

		const out = await post(app, "/logout", {}, jar, { ...INERTIA, referer: "/dashboard" });
		expect(out.status).toBe(303);
		expect(out.headers.get("location")).toBe("/login");
		// The jar dropped the session cookie because the response expired it.
		expect(jar.get(SESSION_COOKIE)).toBeUndefined();
		// Session fixation: the pre-logout token must not still be accepted.
		expect(jar.get("XSRF-TOKEN")).toBeTruthy();
		expect(jar.get("XSRF-TOKEN")).not.toBe(csrfBefore);

		const landing = await page(await get(app, "/login", jar, INERTIA));
		expect(landing.clearHistory).toBe(true);
		expect(landing.props.auth.user).toBeNull();
	});

	// ── Test 4 ────────────────────────────────────────────────────────────────
	it("4 — /dashboard while signed out redirects to /login and the page never runs", async () => {
		const app = await buildApp();
		const res = await get(app, "/dashboard", new Jar(), INERTIA);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/login");
		// The guard short-circuits the chain: no page object, so nothing the
		// dashboard would have rendered is on the wire.
		expect(await res.text()).not.toContain("Dashboard");
	});

	// ── Test 5 ────────────────────────────────────────────────────────────────
	it("5 — forgot password issues a single-use token; the reset works once and the replay is refused", async () => {
		const originalHash = await hashPassword("lovelace-1843");
		const user = await users.create({ name: "Ada", email: "ada@example.com", passwordHash: originalHash });
		const app = await buildApp();
		const jar = await visitorAt(app, "/forgot-password");

		const asked = await post(app, "/forgot-password", { email: "ada@example.com" }, jar, {
			...INERTIA,
			referer: "/forgot-password",
		});
		expect(asked.status).toBe(303);
		expect(sent).toHaveLength(1);
		const token = sent[0]?.token as string;
		expect(token).toBeTruthy();
		// The status message is deliberately identical for an unknown address.
		const notified = await page(await get(app, "/forgot-password", jar, INERTIA));
		expect(String(notified.flash?.status)).toMatch(/password reset link/i);

		const unknown = await post(app, "/forgot-password", { email: "nobody@example.com" }, jar, {
			...INERTIA,
			referer: "/forgot-password",
		});
		expect(unknown.status).toBe(303);
		expect(sent).toHaveLength(1);

		// The reset page echoes the token so the form can post it back.
		const resetJar = await visitorAt(app, `/reset-password/${encodeURIComponent(token)}`);
		const body = {
			token,
			email: "ada@example.com",
			password: "new-password-9000",
			passwordConfirmation: "new-password-9000",
		};
		const reset = await post(app, `/reset-password/${encodeURIComponent(token)}`, body, resetJar, {
			...INERTIA,
			referer: "/reset-password",
		});
		expect(reset.status).toBe(303);
		expect(reset.headers.get("location")).toBe("/login");
		const stored = await users.findById(user.id);
		expect(stored?.passwordHash).not.toBe(originalHash);

		// The new password works…
		const fresh = await visitorAt(app, "/login");
		const signedIn = await post(app, "/login", { email: "ada@example.com", password: "new-password-9000" }, fresh, {
			...INERTIA,
			referer: "/login",
		});
		expect(signedIn.status).toBe(303);
		expect(signedIn.headers.get("location")).toBe("/dashboard");

		// …and the token is spent: a replay bounces with an error, not a reset.
		const replayJar = await visitorAt(app, `/reset-password/${encodeURIComponent(token)}`);
		const replay = await post(
			app,
			`/reset-password/${encodeURIComponent(token)}`,
			{ ...body, password: "attacker-chosen-1", passwordConfirmation: "attacker-chosen-1" },
			replayJar,
			{ ...INERTIA, referer: "/reset-password" },
		);
		expect(replay.status).toBe(303);
		const bounced = await page(await get(app, "/forgot-password", replayJar, INERTIA));
		expect(bounced.props.errors.email).toMatch(/invalid or has expired/);
		// The attacker's password was NOT set.
		const afterReplay = await visitorAt(app, "/login");
		const denied = await post(app, "/login", { email: "ada@example.com", password: "attacker-chosen-1" }, afterReplay, {
			...INERTIA,
			referer: "/login",
		});
		expect(denied.headers.get("location")).toBe("/login");
	});

	// ── CSRF + validation, from the issue's security checklist ────────────────
	it("6 — a POST without the CSRF header is bounced, and the page workflow never runs", async () => {
		await users.create({ name: "Ada", email: "ada@example.com", passwordHash: await hashPassword("lovelace-1843") });
		const app = await buildApp();
		const jar = await visitorAt(app, "/login");

		const res = await app.fetch(
			new Request("http://localhost/login", {
				method: "POST",
				// The cookie rides along (a cross-site form can make the browser send
				// it); the HEADER is what the attacker cannot produce.
				headers: { "content-type": "application/json", cookie: jar.header(), referer: "/login", ...INERTIA },
				body: JSON.stringify({ email: "ada@example.com", password: "lovelace-1843" }),
			}),
		);
		expect(res.status).toBe(303);
		expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
	});

	it("7 — an invalid body never reaches the auth node: 303 back with per-field errors", async () => {
		const app = await buildApp();
		const jar = await visitorAt(app, "/register");
		const res = await post(
			app,
			"/register",
			{ name: "", email: "not-an-email", password: "short", passwordConfirmation: "other" },
			jar,
			{ ...INERTIA, referer: "/register" },
		);
		expect(res.status).toBe(303);
		const shown = await page(await get(app, "/register", jar, INERTIA));
		expect(shown.props.errors.name).toBeTruthy();
		expect(shown.props.errors.email).toMatch(/valid email/);
		expect(shown.props.errors.password).toMatch(/at least 8/);
		expect(shown.props.errors.passwordConfirmation).toMatch(/do not match/);
		expect(await users.findByEmail("not-an-email")).toBeUndefined();
	});

	// ── #1018 security review: B3 / H1 / L3 ───────────────────────────────────

	/** Sign `ada@example.com` in and return her jar. */
	async function signIn(app: App): Promise<Jar> {
		await users.create({ name: "Ada", email: "ada@example.com", passwordHash: await hashPassword("lovelace-1843") });
		const jar = await visitorAt(app, "/login");
		const res = await post(app, "/login", { email: "ada@example.com", password: "lovelace-1843" }, jar, INERTIA);
		expect(res.status).toBe(303);
		return jar;
	}

	/**
	 * B3 — `inertia.encryptHistory` was never in the chain, so no page object
	 * carried `encryptHistory` and logout's `clearHistory` rotated a key that
	 * was protecting nothing.
	 */
	it("B3 — every page the kit serves carries encryptHistory: true", async () => {
		const app = await buildApp();
		const guest = await visitorAt(app, "/login");
		expect((await page(await get(app, "/login", guest, INERTIA))).encryptHistory).toBe(true);

		const jar = await signIn(app);
		const dashboard = await page(await get(app, "/dashboard", jar, INERTIA));
		expect(dashboard.encryptHistory).toBe(true);
		expect(dashboard.props.auth.user).toBeTruthy();
	});

	/**
	 * H1 — a guarded page is per-user. Without `no-store` a shared cache may
	 * keep it, and the browser may re-render it from its own cache when the user
	 * presses Back after signing out.
	 */
	it("H1 — a guarded page answers no-store and varies on Cookie", async () => {
		const app = await buildApp();
		const jar = await signIn(app);

		const res = await get(app, "/dashboard", jar, INERTIA);
		expect(res.headers.get("cache-control")).toContain("no-store");
		expect(res.headers.get("vary")?.toLowerCase()).toContain("cookie");

		// The HTML first load, not just the Inertia XHR.
		const html = await get(app, "/dashboard", jar);
		expect(html.headers.get("cache-control")).toContain("no-store");

		// ...and an UNGUARDED page is untouched: the mark belongs to the guard,
		// it is not something every response now carries.
		expect((await get(app, "/login", jar, INERTIA)).headers.get("cache-control")).toBeNull();
	});

	/**
	 * L3 — the scaffold smoke's CSRF claim was overstated: every POST it sends
	 * carries a valid token. THIS is the guard — a cross-site-shaped POST with
	 * the cookie present and the header absent.
	 */
	it("L3 — a POST without the CSRF header is bounced and no session is issued", async () => {
		const app = await buildApp();
		await users.create({ name: "Ada", email: "ada@example.com", passwordHash: await hashPassword("lovelace-1843") });
		const jar = await visitorAt(app, "/login");

		const res = await app.fetch(
			new Request("http://localhost/login", {
				method: "POST",
				headers: { "content-type": "application/json", cookie: jar.header() },
				body: JSON.stringify({ email: "ada@example.com", password: "lovelace-1843" }),
			}),
		);
		expect(res.status).toBe(303);
		const issued = res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !/max-age=0/i.test(c));
		expect(issued).toBe(false);
	});
});
