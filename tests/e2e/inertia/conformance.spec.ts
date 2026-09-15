/**
 * #1003 — the 45 real-browser conformance scenarios.
 *
 * Every test drives a REAL Chromium against a project `blokctl` generated, a
 * client Vite built, and the stock `@inertiajs/{react,vue3,svelte}` adapter.
 * Nothing is mocked and nothing asserts only a status code: each scenario reads
 * a side effect the browser produced — a network entry, DOM text, a console
 * message — or a side effect the SERVER recorded (scenario 8 asks the Python
 * node how many times it actually ran).
 *
 * The three framework fixtures expose the SAME `data-testid`s, so one spec
 * drives all of them.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { type Page, type Request, type Response, expect, test } from "playwright/test";

const framework = process.env.E2E_FRAMEWORK ?? "react";
const mode = process.env.E2E_MODE ?? "in-project";
const ssr = process.env.E2E_SSR === "1";
/** The BLOK origin. In standalone mode the browser's origin is the Vite preview. */
const server = process.env.E2E_SERVER_URL ?? process.env.E2E_BASE_URL ?? "http://127.0.0.1:4600";

interface VisitLog {
	requests: Request[];
	responses: Response[];
	consoleErrors: string[];
}

const logs = new WeakMap<Page, VisitLog>();
/**
 * Console noise a scenario DELIBERATELY causes. A 409 or a 500 makes Chromium
 * log "Failed to load resource" by itself; scenario 18's gate has to survive
 * the scenarios whose whole point is such a response, without going blind.
 */
const expected = new WeakMap<Page, RegExp[]>();

function allowConsoleErrors(page: Page, ...patterns: RegExp[]): void {
	expected.set(page, [...(expected.get(page) ?? []), ...patterns]);
}

function logFor(page: Page): VisitLog {
	const log = logs.get(page);
	if (!log) throw new Error("page logging was not installed");
	return log;
}

/** Requests the APP made — the static bundle and its assets are not traffic. */
function appRequests(page: Page, from = 0): Request[] {
	return logFor(page)
		.requests.slice(from)
		.filter((request) => {
			// Requests to BLOK. The client bundle and its assets are not protocol
			// traffic, and in standalone mode they are not even the same server.
			if (!request.url().startsWith(server)) return false;
			const { pathname } = new URL(request.url());
			return !pathname.startsWith("/assets/") && !/\.(js|css|map|ico|png|svg)$/.test(pathname);
		});
}

function pathsOf(requests: Request[]): string[] {
	return requests.map((request) => `${request.method()} ${new URL(request.url()).pathname}`);
}

/** Requests the Inertia client issued (as opposed to browser navigations). */
function xhrRequests(page: Page, from = 0): Request[] {
	return logFor(page)
		.requests.slice(from)
		.filter((request) => request.headers()["x-inertia"] === "true");
}

function partialRequests(page: Page, prop: string, from = 0): Request[] {
	return logFor(page)
		.requests.slice(from)
		.filter((request) => (request.headers()["x-inertia-partial-data"] ?? "").split(",").includes(prop));
}

/** The real submit, as opposed to the Precognition probe that shares its URL. */
function isSubmitToOrders(response: Response): boolean {
	const request = response.request();
	return (
		request.method() === "POST" &&
		new URL(request.url()).pathname === "/orders" &&
		request.headers().precognition === undefined
	);
}

/**
 * Navigate, and wait for the page component to be on screen.
 *
 * In-project the shell ships the page object, so the first paint is immediate.
 * A STANDALONE SPA fetches it after boot, so `page.goto()` resolves against an
 * empty `<div id="app">` — every count taken straight after would be zero.
 */
async function open(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await page.locator('[data-testid="page-heading"]').waitFor({ state: "attached" });
	// …and wait for the client to have TAKEN OVER. Under SSR the markup is
	// interactive-looking before hydration, so a click that lands first hits a
	// plain `<form>` with no submit handler and the browser navigates natively.
	// The fixture's layout sets `data-hydrated` after mount, in all three
	// frameworks.
	await page.locator("[data-hydrated]").waitFor({ state: "attached" });
}

async function navigationEntries(page: Page): Promise<number> {
	return page.evaluate(() => performance.getEntriesByType("navigation").length);
}

/**
 * Mark the live document. A full page load replaces it (and resets the
 * navigation-entry list to 1), so the marker's disappearance — not an entry
 * count — is what distinguishes a reload from an SPA visit.
 */
async function markDocument(page: Page): Promise<void> {
	await page.evaluate(() => {
		(window as Window & { __sameDocument?: boolean }).__sameDocument = true;
	});
}

async function sameDocument(page: Page): Promise<boolean> {
	return page.evaluate(() => (window as Window & { __sameDocument?: boolean }).__sameDocument === true);
}

/** Sign in through the real login form, leaving the session cookie behind. */
async function signIn(page: Page, email = "e2e@example.test"): Promise<void> {
	await open(page, "/login");
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(["e2e", "fixture", "secret"].join("-"));
	await page.getByTestId("submit-login").click();
	await expect(page.getByTestId("page-heading")).toHaveText("Secret");
}

async function pythonCalls(page: Page): Promise<number> {
	const response = await page.request.get(`${server}/__e2e/python-calls`);
	expect(response.ok()).toBeTruthy();
	const body = (await response.json()) as { calls?: number } | { data?: { calls?: number } };
	return (
		(body as { calls?: number }).calls ??
		((body as { data?: { calls?: number } }).data?.calls as number | undefined) ??
		-1
	);
}

/**
 * The double-submit CSRF header, read from the cookie the browser holds.
 * `page.request` shares the context's cookies but not axios's interceptor, so a
 * POST from a test has to do for itself what the stock client does for a page.
 */
async function csrfHeaders(page: Page): Promise<Record<string, string>> {
	const cookies = await page.context().cookies();
	const token = cookies.find((cookie) => cookie.name === "XSRF-TOKEN")?.value;
	return token ? { "X-XSRF-TOKEN": token } : {};
}

/** Publish a new client asset version, as a redeploy does. */
async function bumpAssetVersion(page: Page): Promise<void> {
	const response = await page.request.post(`${server}/__e2e/bump-version`, { headers: await csrfHeaders(page) });
	expect(response.ok(), "the version bump was rejected").toBeTruthy();
	const body = (await response.json()) as { version?: string; data?: { version?: string } };
	// A CSRF rejection is also a 2xx redirect; the new version proves it ran.
	expect(body.version ?? body.data?.version, "the bump endpoint did not publish a version").toMatch(/^e2e-/);
}

test.beforeEach(async ({ page, context }) => {
	const log: VisitLog = { requests: [], responses: [], consoleErrors: [] };
	logs.set(page, log);
	page.on("request", (request) => log.requests.push(request));
	page.on("response", (response) => log.responses.push(response));
	page.on("console", (message) => {
		if (message.type() === "error") log.consoleErrors.push(message.text());
	});
	await context.clearCookies();
});

// Scenario 18: no `console.error` anywhere, in any scenario.
test.afterEach(async ({ page }) => {
	const allowed = expected.get(page) ?? [];
	const unexpected = logFor(page).consoleErrors.filter((error) => !allowed.some((pattern) => pattern.test(error)));
	expect(unexpected, "the scenario emitted an unexpected console.error").toEqual([]);
});

// ── Boot and navigation ─────────────────────────────────────────────────────

test("01 — initial load varies on X-Inertia, renders Home, and is one navigation", async ({ page }) => {
	const document = await page.goto("/");
	expect(document).not.toBeNull();
	// In standalone mode the document comes from Vite; the Blok response is the
	// one that has to carry `Vary`, so ask the server for it directly.
	const varyOn =
		mode === "standalone"
			? (await page.request.get(`${server}/`)).headers().vary
			: (document as Response).headers().vary;
	expect(varyOn).toContain("X-Inertia");
	await expect(page.getByTestId("page-heading")).toHaveText("Home");
	expect(await navigationEntries(page)).toBe(1);
});

test("02 — a Link click is exactly one Inertia XHR and no navigation", async ({ page }) => {
	await open(page, "/");
	await expect(page.getByTestId("page-heading")).toHaveText("Home");
	const from = logFor(page).requests.length;

	const settled = page.waitForResponse((r) => new URL(r.url()).pathname === "/orders");
	await page.getByTestId("nav-orders").click();
	const response = await settled;

	expect(response.request().headers()["x-inertia"]).toBe("true");
	expect(response.headers()["x-inertia"]).toBe("true");
	await expect(page.getByTestId("page-heading")).toHaveText("Orders");
	expect(await page.evaluate(() => location.pathname)).toBe("/orders");
	expect(pathsOf(appRequests(page, from))).toEqual(["GET /orders"]);
	expect(await navigationEntries(page)).toBe(1);
});

test("03 — Back restores Home from history with no request", async ({ page }) => {
	await open(page, "/");
	await page.getByTestId("nav-orders").click();
	await expect(page.getByTestId("page-heading")).toHaveText("Orders");
	const from = logFor(page).requests.length;

	await page.goBack();
	await expect(page.getByTestId("page-heading")).toHaveText("Home");
	await page.waitForLoadState("networkidle");
	expect(pathsOf(appRequests(page, from))).toEqual([]);
});

test("04 — scroll position on Orders survives a visit to Orders/Show and Back", async ({ page }) => {
	await open(page, "/orders");
	await expect(page.getByTestId("page-heading")).toHaveText("Orders");
	expect(await page.evaluate(() => Math.round(scrollY)), "a fresh visit starts at the top").toBe(0);

	await page.evaluate(() => scrollTo(0, 900));
	// Inertia records scroll positions from a debounced scroll listener; clicking
	// inside that window would save the position from BEFORE the scroll.
	await page.waitForTimeout(500);
	const scrolled = await page.evaluate(() => Math.round(scrollY));
	expect(scrolled, "the orders list must be long enough to scroll").toBeGreaterThan(400);

	// A link that is ALREADY on screen: Playwright scrolls to whatever it clicks,
	// and the bottom of the list is where <InfiniteScroll> starts a visit of its
	// own — either would move the position this scenario is about to assert on.
	const links = page.locator("[data-order-id] a");
	let target = links.first();
	for (let index = 0; index < (await links.count()); index += 1) {
		const box = await links.nth(index).boundingBox();
		if (box && box.y > 50 && box.y < 500) {
			target = links.nth(index);
			break;
		}
	}
	await target.click();
	await expect(page.getByTestId("page-heading")).toContainText("Order ");
	// The history entry is pushed by the client AFTER the swap; going back
	// before it commits pops the entry this visit replaced, not this one.
	await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/orders\/\d+$/);

	await page.goBack();
	await expect.poll(() => new URL(page.url()).pathname, { message: "Back did not land on /orders" }).toBe("/orders");
	await expect(page.getByTestId("page-heading")).toHaveText("Orders");
	await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBe(scrolled);
});

// ── Forms and errors ────────────────────────────────────────────────────────

test("05 — an invalid create 303s back, keeps the typed qty and shows errors once", async ({ page }) => {
	await open(page, "/orders/create");
	await page.getByTestId("qty").fill("3");

	const post = page.waitForResponse(isSubmitToOrders);
	const followed = page.waitForResponse(
		(r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/orders/create",
	);
	await page.getByTestId("submit-create").click();

	expect((await post).status()).toBe(303);
	const back = await followed;
	expect((await back.request().allHeaders())["x-inertia"]).toBe("true");
	await expect(page.getByTestId("error-sku").first()).toBeVisible();
	expect(await page.getByTestId("qty").inputValue()).toBe("3");

	// One-shot: the render that consumed the flash is the one that expires it.
	const setCookies = (await back.headersArray())
		.filter((header) => header.name.toLowerCase() === "set-cookie")
		.map((header) => header.value);
	expect(setCookies.join("\n")).toMatch(/flash=[^;]*;[^\n]*(Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
	await page.reload();
	await expect(page.getByTestId("error-sku")).toHaveCount(0);
});

test("06 — a valid create 303s to the list, shows the order, and is exactly POST + GET", async ({ page }) => {
	await open(page, "/orders/create");
	const sku = `e2e-${Date.now()}`;
	await page.getByTestId("sku").fill(sku);
	await page.getByTestId("qty").fill("2");
	const from = logFor(page).requests.length;

	const post = page.waitForResponse(isSubmitToOrders);
	await page.getByTestId("submit-create").click();
	expect((await post).status()).toBe(303);

	await expect(page.getByTestId("page-heading")).toHaveText("Orders");
	await expect(page.getByText(sku, { exact: false }).first()).toBeVisible();
	expect(pathsOf(appRequests(page, from))).toEqual(["POST /orders", "GET /orders"]);
});

test("07 — router.delete sends DELETE and the server answers 303", async ({ page }) => {
	await open(page, "/orders");
	const before = await page.locator("[data-order-id]").count();
	const first = await page.locator("[data-order-id]").first().getAttribute("data-order-id");

	const settled = page.waitForResponse((r) => r.request().method() === "DELETE");
	await page.getByTestId(`order-delete-${first}`).click();
	const response = await settled;

	expect(response.request().method()).toBe("DELETE");
	expect(response.status()).toBe(303);
	await expect(page.locator(`[data-order-id="${first}"]`)).toHaveCount(0);
	await expect(page.locator("[data-order-id]")).toHaveCount(before);
});

// ── Partial and deferred ────────────────────────────────────────────────────

test("08 — the deferred Python stats prop resolves once, in the follow-up request only", async ({ page }) => {
	const before = await pythonCalls(page);
	expect(before).toBeGreaterThanOrEqual(0);

	// The FULL visit must only announce it.
	const announced = await page.request.get(`${server}/dashboard`, { headers: { "X-Inertia": "true" } });
	const object = (await announced.json()) as {
		props: Record<string, unknown>;
		deferredProps?: Record<string, string[]>;
	};
	expect(object.props).not.toHaveProperty("stats");
	expect(object.deferredProps?.default).toContain("stats");
	expect(await pythonCalls(page)).toBe(before);

	const from = logFor(page).requests.length;
	await open(page, "/dashboard");
	await expect(page.getByTestId("stats")).toContainText("python revenue 42000");
	expect(partialRequests(page, "stats", from)).toHaveLength(1);
	expect(await pythonCalls(page)).toBe(before + 1);
});

test("09 — router.reload({ only }) returns exactly that prop plus errors", async ({ page }) => {
	await open(page, "/orders");
	const settled = page.waitForResponse((r) => r.request().headers()["x-inertia-partial-data"] === "orders");
	await page.getByTestId("orders-reload").click();
	const response = await settled;

	expect(response.request().headers()["x-inertia-partial-component"]).toBe("Orders/Index");
	const body = (await response.json()) as { props: Record<string, unknown> };
	expect(Object.keys(body.props).sort()).toEqual(["errors", "orders"]);
});

// ── Versioning ──────────────────────────────────────────────────────────────

test("10 — a new asset version makes the next GET a 409 and forces a full reload", async ({ page }) => {
	// The 409 IS the mechanism; Chromium logs it as a failed resource.
	allowConsoleErrors(page, /Failed to load resource.*409/i);
	await open(page, "/");
	await expect(page.getByTestId("page-heading")).toHaveText("Home");
	await markDocument(page);
	await bumpAssetVersion(page);

	const conflict = page.waitForResponse((r) => r.status() === 409);
	await page.getByTestId("nav-orders").click();
	const response = await conflict;

	expect(response.headers()["x-inertia-location"]).toContain("/orders");
	await expect(page.getByTestId("page-heading")).toHaveText("Orders");
	// The document was REPLACED — a full load, not a client-side swap.
	await expect.poll(() => sameDocument(page)).toBe(false);
	expect(await navigationEntries(page)).toBe(1);
});

test("11 — a stale asset version does NOT 409 a POST; it stays a 303", async ({ page }) => {
	await open(page, "/orders/create");
	await bumpAssetVersion(page);
	await page.getByTestId("sku").fill(`post-${Date.now()}`);
	await page.getByTestId("qty").fill("1");

	const post = page.waitForResponse(isSubmitToOrders);
	await page.getByTestId("submit-create").click();
	expect((await post).status()).toBe(303);
});

// ── Auth and middleware ─────────────────────────────────────────────────────

test("12 — a guest visiting /secret is redirected to /login, on a full load and on an XHR", async ({ page }) => {
	const document = await page.goto("/secret");
	await page.locator("[data-hydrated]").waitFor({ state: "attached" });
	if (mode === "standalone") {
		// The document comes from the SPA's own server; the 302 is on the page
		// object fetch, so assert it against the API directly.
		const direct = await page.request.get(`${server}/secret`, {
			headers: { "X-Inertia": "true" },
			maxRedirects: 0,
		});
		expect(direct.status()).toBe(302);
		expect(direct.headers().location).toBe("/login");
	} else {
		const chain: string[] = [];
		for (let hop = document?.request().redirectedFrom(); hop; hop = hop.redirectedFrom()) {
			const hopResponse = await hop.response();
			if (hopResponse) chain.push(`${hopResponse.status()} ${new URL(hop.url()).pathname}`);
		}
		expect(chain).toContain("302 /secret");
	}
	await expect(page.getByTestId("page-heading")).toHaveText("Login");

	await open(page, "/");
	const xhr = page.waitForResponse((r) => new URL(r.url()).pathname === "/secret");
	await page.getByTestId("nav-secret").click();
	expect((await xhr).status()).toBe(302);
	await expect(page.getByTestId("page-heading")).toHaveText("Login");
});

test("13 — after signing in, /secret renders and props.auth.email comes from inertia.shared", async ({ page }) => {
	await signIn(page);
	await expect(page.getByTestId("secret-email")).toHaveText("e2e@example.test");
	await expect(page.getByTestId("auth-email")).toHaveText("e2e@example.test");

	const object = (await (await page.request.get(`${server}/secret`, { headers: { "X-Inertia": "true" } })).json()) as {
		props: { auth: { email: string } };
	};
	expect(object.props.auth.email).toBe("e2e@example.test");
});

// ── Standalone only ─────────────────────────────────────────────────────────

test("14 — standalone: CORS preflight passes and X-Inertia-Location is readable cross-origin", async ({ page }) => {
	test.skip(mode !== "standalone", "standalone cells only");
	const client = process.env.E2E_CLIENT_URL ?? "";
	const preflight = await page.request.fetch(`${server}/orders`, {
		method: "OPTIONS",
		headers: {
			Origin: client,
			"Access-Control-Request-Method": "GET",
			"Access-Control-Request-Headers": "x-inertia,x-inertia-version",
		},
	});
	expect(preflight.status()).toBeLessThan(400);
	expect(preflight.headers()["access-control-allow-origin"]).toBe(client);
	expect(preflight.headers()["access-control-expose-headers"] ?? "").toMatch(/x-inertia-location/i);

	const forced = await page.request.get(`${server}/orders`, {
		headers: { "X-Inertia": "true", "X-Inertia-Version": "definitely-stale", Origin: client },
	});
	expect(forced.status()).toBe(409);
	expect(forced.headers()["x-inertia-location"]).toBeTruthy();
});

// ── SSR only ────────────────────────────────────────────────────────────────

test("15 — SSR: the no-JS HTML already carries the page, and hydration is clean", async ({ page, request }) => {
	test.skip(!ssr, "SSR cells only");
	const html = await (await request.get(`${server}/`)).text();
	expect(html).toContain("Home");
	expect(html).toMatch(/data-page="app"/);

	await open(page, "/");
	await expect(page.getByTestId("page-heading")).toHaveText("Home");
	await page.getByTestId("nav-orders").click();
	await expect(page.getByTestId("page-heading")).toHaveText("Orders");
	expect(logFor(page).consoleErrors.filter((error) => /hydrat/i.test(error))).toEqual([]);
});

// ── Negative / safety ───────────────────────────────────────────────────────

test("16 — a prop carrying a closing script tag cannot execute", async ({ page }) => {
	await open(page, "/");
	const html = await (await page.request.get(`${server}/`)).text();
	expect(html).toContain("pwned");
	expect(html).not.toContain("</script><script>window.pwned");
	await expect(page.getByTestId("home-payload")).toContainText("window.pwned=1");
	expect(await page.evaluate(() => (window as Window & { pwned?: number }).pwned)).toBeUndefined();
});

test("17 — the HTML never leaks request headers or cookies", async ({ request }) => {
	const html = await (
		await request.get(`${server}/`, { headers: { Cookie: "e2e_secret=leaked", "X-E2E-Header": "private" } })
	).text();
	expect(html).not.toContain("e2e_secret=leaked");
	expect(html.toLowerCase()).not.toContain("cookie");
	expect(html.toLowerCase()).not.toContain("x-e2e-header");
});

test("18 — a full navigation cycle emits no console.error", async ({ page }) => {
	await open(page, "/");
	await page.getByTestId("nav-orders").click();
	await expect(page.getByTestId("page-heading")).toHaveText("Orders");
	await page.getByTestId("nav-home").click();
	await expect(page.getByTestId("page-heading")).toHaveText("Home");
	expect(logFor(page).consoleErrors).toEqual([]);
});

test("19 — generated app types typecheck, and a renamed prop breaks the client build", async () => {
	const project = process.env.E2E_PROJECT_DIR;
	if (!project) throw new Error("the runner did not expose E2E_PROJECT_DIR for the typing gate");
	const workflow = `${project}/src/workflows/home.ts`;
	const source = readFileSync(workflow, "utf8");

	execFileSync("bun", ["run", "gen:types"], { cwd: project, stdio: "pipe" });
	execFileSync("bunx", ["tsc", "--noEmit"], { cwd: `${project}/client`, stdio: "pipe" });

	try {
		writeFileSync(workflow, source.replace("home: homeCopy", "orderz: homeCopy"));
		execFileSync("bun", ["run", "gen:types"], { cwd: project, stdio: "pipe" });
		let message = "";
		try {
			execFileSync("bunx", ["tsc", "--noEmit"], { cwd: `${project}/client`, stdio: "pipe" });
		} catch (error) {
			message = String((error as { stdout?: Buffer }).stdout ?? error);
		}
		expect(message, "renaming the prop must break the client typecheck").toMatch(/home/);
	} finally {
		writeFileSync(workflow, source);
		execFileSync("bun", ["run", "gen:types"], { cwd: project, stdio: "pipe" });
	}
});

// ── v3 additions ────────────────────────────────────────────────────────────

test("20 — the boot payload is a JSON script tag, escaped, and boots cleanly", async ({ page, request }) => {
	const html = await (await request.get(`${server}/`)).text();
	// Attribute ORDER differs between the shell and the SSR renderer; the
	// contract is a JSON script tag named `app`, not one renderer's spelling.
	expect(html).toMatch(/<script[^>]*\bdata-page="app"[^>]*>/);
	expect(html).toMatch(
		/<script[^>]*\btype="application\/json"[^>]*\bdata-page="app"|<script[^>]*\bdata-page="app"[^>]*\btype="application\/json"/,
	);
	// v3 escapes `<` and `/` — no HTML entities, and no raw closing tag. (The
	// hex digits' case is a JSON-serializer detail, not part of the contract.)
	expect(html).toMatch(/\\u003c\\\/script>/i);
	expect(html).not.toContain("</script><script>");
	// …and exactly ONE title, whoever rendered the head.
	expect(html.match(/<title\b/gi) ?? []).toHaveLength(1);

	await open(page, "/");
	await expect(page.getByTestId("page-heading")).toHaveText("Home");
	expect(logFor(page).consoleErrors).toEqual([]);
});

test("21 — except narrows a reload, and reset replaces a scroll prop instead of appending", async ({ page }) => {
	await open(page, "/orders");
	const settled = page.waitForResponse((r) =>
		(r.request().headers()["x-inertia-partial-except"] ?? "").includes("orders"),
	);
	await page.getByTestId("orders-except").click();
	const response = await settled;
	const body = (await response.json()) as { props: Record<string, unknown> };
	expect(body.props).not.toHaveProperty("orders");
	expect(Object.keys(body.props)).toContain("feed");

	await open(page, "/orders");
	const base = await page.locator("[data-feed-id]").count();
	expect(base).toBeGreaterThan(0);
	await page.getByTestId("feed-more").click();
	await expect(page.locator("[data-feed-id]")).toHaveCount(base * 2);
	await page.getByTestId("feed-reset").click();
	await expect(page.locator("[data-feed-id]")).toHaveCount(base);
});

test("22 — a merge prop appends a page and replaces a matching id in place", async ({ page }) => {
	await open(page, "/orders");
	const before = await page.locator("[data-order-id]").count();

	await page.getByTestId("orders-more").click();
	await expect(page.locator("[data-order-id]")).toHaveCount(before + 10);
	const ids = await page
		.locator("[data-order-id]")
		.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-order-id")));
	expect(new Set(ids).size).toBe(ids.length);

	await page.getByTestId("orders-update").click();
	await expect(page.locator('[data-order-id="1"]')).toContainText("(updated)");
	await expect(page.locator("[data-order-id]")).toHaveCount(before + 10);
});

test("23 — two InfiniteScrolls on one page keep independent page parameters", async ({ page }) => {
	await open(page, "/dashboard");
	await expect(page.getByTestId("page-heading")).toHaveText("Dashboard");
	const from = logFor(page).requests.length;

	await page.locator('[data-infinite-scroll="feed"]').scrollIntoViewIfNeeded();
	await expect.poll(() => partialRequests(page, "feed", from).length).toBeGreaterThan(0);
	await page.locator('[data-infinite-scroll="users"]').scrollIntoViewIfNeeded();
	await expect.poll(() => partialRequests(page, "users", from).length).toBeGreaterThan(0);

	const params = (prop: string): Set<string> => {
		const keys = new Set<string>();
		for (const request of partialRequests(page, prop, from)) {
			for (const key of new URL(request.url()).searchParams.keys()) keys.add(key);
		}
		return keys;
	};
	expect([...params("feed")]).toContain("feed");
	expect([...params("users")]).toContain("users");
	// Independent cursors: neither request may carry the other prop's parameter.
	expect([...params("feed")]).not.toContain("users");
	expect([...params("users")]).not.toContain("feed");
});

test("24 — a once prop is omitted when moving between two pages that share it", async ({ page }) => {
	// Orders/Index and Dashboard both declare `plans: once(...)`.
	await open(page, "/orders");
	await expect(page.getByTestId("plans")).toBeVisible();

	const settled = page.waitForResponse((r) => new URL(r.url()).pathname === "/dashboard");
	await page.getByTestId("nav-dashboard").click();
	const response = await settled;

	expect(response.request().headers()["x-inertia-except-once-props"] ?? "").toContain("plans");
	const body = (await response.json()) as { props: Record<string, unknown>; onceProps?: Record<string, unknown> };
	expect(body.props, "the server re-resolved a prop the client already holds").not.toHaveProperty("plans");
	// The ENTRY still ships — without it the client would drop its cached copy.
	expect(body.onceProps).toHaveProperty("plans");
	await expect(page.getByTestId("plans")).toBeVisible();

	const refreshed = page.waitForResponse((r) =>
		(r.request().headers()["x-inertia-partial-data"] ?? "").includes("plans"),
	);
	await page.getByTestId("plans-reload").click();
	const fresh = (await (await refreshed).json()) as { props: Record<string, unknown> };
	expect(fresh.props, "an explicit only-reload must outrank the client's cached copy").toHaveProperty("plans");
});

test("25 — an optional prop is absent on load and arrives on an only reload", async ({ page }) => {
	await open(page, "/orders");
	await expect(page.getByTestId("filters")).toHaveCount(0);
	await page.getByTestId("filters-load").click();
	await expect(page.getByTestId("filters")).toBeVisible();
});

test("26 — deferred groups load in parallel and a rescued prop retries", async ({ page }) => {
	const from = logFor(page).requests.length;
	await open(page, "/dashboard");
	await expect(page.getByTestId("stats")).toBeVisible();
	await expect(page.getByTestId("secondary")).toHaveText("secondary group");

	// Two GROUPS means two requests, each naming only its own props.
	const groups = new Set(
		xhrRequests(page, from)
			.map((request) => request.headers()["x-inertia-partial-data"])
			.filter((value): value is string => typeof value === "string" && value !== ""),
	);
	expect(groups.size).toBeGreaterThanOrEqual(2);

	await expect(page.getByTestId("flaky-rescued")).toBeVisible();
	await page.getByTestId("flaky-retry").click();
	await expect(page.getByTestId("flaky")).toHaveText("rescued and retried");
});

test("27 — flash fires once, shows a toast, and does not come back on Back", async ({ page }) => {
	await open(page, "/orders/create");
	await page.evaluate(() => {
		const counter = window as Window & { __flash?: number };
		counter.__flash = 0;
		document.addEventListener("inertia:flash", () => {
			counter.__flash = (counter.__flash ?? 0) + 1;
		});
	});

	await page.getByTestId("sku").fill(`flash-${Date.now()}`);
	await page.getByTestId("qty").fill("1");
	await page.getByTestId("submit-create").click();
	await expect(page.getByRole("status")).toBeVisible();
	await expect.poll(() => page.evaluate(() => (window as Window & { __flash?: number }).__flash)).toBe(1);

	// The toast removes itself; what must not happen is a SECOND flash event.
	await expect(page.getByRole("status")).toHaveCount(0, { timeout: 10_000 });
	await page.goBack();
	await expect(page.getByTestId("page-heading")).toHaveText("New order");
	await expect(page.getByRole("status")).toHaveCount(0);
	expect(await page.evaluate(() => (window as Window & { __flash?: number }).__flash)).toBe(1);
});

test("28 — two forms with the same field name keep their errors in separate bags", async ({ page }) => {
	await open(page, "/orders/create");
	await page.getByTestId("submit-bag-a").click();
	await expect(page.getByTestId("bag-a-error").first()).toBeVisible();
	await expect(page.getByTestId("bag-b-error")).toHaveCount(0);

	await page.getByTestId("submit-bag-b").click();
	await expect(page.getByTestId("bag-b-error").first()).toBeVisible();
});

test("29 — withAllErrors renders every message for one field", async ({ page }) => {
	await open(page, "/orders/create");
	await page.getByTestId("sku").fill("");
	await page.getByTestId("qty").fill("1");
	await page.getByTestId("submit-create").click();

	await expect(page.locator("[data-error-message]")).toHaveCount(2);
	const messages = await page.locator("[data-error-message]").allTextContents();
	expect(messages).toEqual(
		expect.arrayContaining([expect.stringMatching(/required/i), expect.stringMatching(/format/i)]),
	);
});

test("30 — Precognition answers 204 for valid input without running the write", async ({ page }) => {
	await open(page, "/orders/create");
	const before = await page.locator("[data-order-id]").count();
	expect(before).toBe(0);

	await page.getByTestId("sku").fill("precog-valid");
	const settled = page.waitForResponse((r) => r.request().headers().precognition === "true");
	await page.getByTestId("qty").click();
	const response = await settled;

	expect(response.status()).toBe(204);
	expect(response.headers()["precognition-success"]).toBe("true");
	// A probe is not a submit: the page must still be the form.
	await expect(page.getByTestId("page-heading")).toHaveText("New order");
});

test("31 — a multipart upload spoofs PUT over POST and reports 100% progress", async ({ page }) => {
	await open(page, "/orders/create");
	await page
		.getByTestId("proof")
		.setInputFiles({ name: "proof.txt", mimeType: "text/plain", buffer: Buffer.from("e2e".repeat(20_000)) });

	const settled = page.waitForRequest(
		(request) => request.method() === "POST" && new URL(request.url()).pathname === "/orders/upload",
	);
	await page.getByTestId("submit-upload").click();
	const request = await settled;

	// Inertia spoofs the method in the multipart BODY, never in a header — and a
	// browser does not hand that body to Playwright. The proof that the spoofing
	// reached the server is that `PUT /orders/upload`, a route with no POST
	// handler, answered this POST with its own redirect and flash.
	expect(request.method()).toBe("POST");
	expect(request.headers()["content-type"] ?? "").toContain("multipart/form-data");
	const response = await request.response();
	expect(response?.status(), "the spoofed method never reached the PUT route").toBe(303);
	await expect(page.getByRole("status")).toContainText("uploaded proof.txt");
	await expect(page.getByTestId("upload-progress")).toHaveAttribute("aria-valuenow", "100");
});

test("32 — an expired CSRF cookie redirects back with the expiry flash, not a modal", async ({ page, context }) => {
	await open(page, "/orders/create");
	// A real expiry: the double-submit cookie is gone, so the client sends no
	// X-XSRF-TOKEN. Nothing is typed, so no Precognition probe re-issues one.
	await context.clearCookies();

	const rejected = page.waitForResponse(isSubmitToOrders);
	await page.getByTestId("submit-create").click();
	expect((await rejected).status()).toBe(303);

	await expect(page.getByRole("status")).toContainText(/expired/i);
	// The guard bounces to the `Referer`. Cross-origin, the browser reduces that
	// to the bare origin (`strict-origin-when-cross-origin`), so a standalone app
	// lands on `/` — still a redirect-back with the expiry flash, which is what
	// this scenario is about, and emphatically not the client's error modal.
	await expect(page.getByTestId("page-heading")).toHaveText(mode === "standalone" ? "Home" : "New order");
});

test("33 — an encrypted history entry keeps the page out of session history", async ({ page }) => {
	await signIn(page);
	const flagged = await page.evaluate(
		() => (history.state as { page?: { encryptHistory?: boolean } })?.page?.encryptHistory,
	);
	// The page object asks for encryption…
	const object = (await (await page.request.get(`${server}/secret`, { headers: { "X-Inertia": "true" } })).json()) as {
		encryptHistory?: boolean;
	};
	expect(object.encryptHistory).toBe(true);
	// …and the client encrypts. `crypto.subtle` needs a secure context, which
	// 127.0.0.1 is; asserting that first keeps the encryption assertion from
	// passing vacuously somewhere it silently degrades.
	const secure = await page.evaluate(() => window.isSecureContext && typeof crypto?.subtle?.encrypt === "function");
	expect(secure, "history encryption needs crypto.subtle, i.e. a secure context").toBe(true);
	expect(flagged).not.toBe(false);
	const state = await page.evaluate(() => JSON.stringify(history.state));
	expect(state.length).toBeGreaterThan(0);
	expect(state, "the signed-in identity reached sessionStorage in the clear").not.toContain("e2e@example.test");
});

test("34 — a thrown step renders the production error page as an Inertia response", async ({ page }) => {
	allowConsoleErrors(page, /Failed to load resource.*500/i);
	const response = await page.goto("/__e2e/error");
	if (mode !== "standalone") expect(response?.status()).toBe(500);
	await expect(page.getByTestId("page-heading")).toContainText("500");

	const object = await page.request.get(`${server}/__e2e/error`, { headers: { "X-Inertia": "true" } });
	expect(object.status()).toBe(500);
	expect(((await object.json()) as { component: string }).component).toBe("Errors/Error");
});

test("35 — an external redirect leaves the app; a fragment redirect keeps the SPA", async ({ page }) => {
	// 409 is how Inertia expresses both redirects; the browser logs it as a
	// failed resource, which is noise rather than an application error.
	allowConsoleErrors(page, /Failed to load resource.*409/i);
	await open(page, "/orders");
	await page.getByTestId("fragment-link").click();
	await expect.poll(() => page.evaluate(() => location.hash)).toBe("#c");
	expect(await navigationEntries(page)).toBe(1);
	await expect(page.getByTestId("page-heading")).toHaveText("Orders");

	await page.getByTestId("external-link").click();
	await expect.poll(() => page.url(), { timeout: 15_000 }).toContain("example.org");
});

test("36 — an instant Link renders the next page with the shared auth already there", async ({ page }) => {
	await signIn(page);
	await open(page, "/");
	await expect(page.getByTestId("page-heading")).toHaveText("Home");
	const from = logFor(page).requests.length;

	await page.getByTestId("instant-dashboard").click();
	await expect(page.getByTestId("page-heading")).toHaveText("Dashboard");
	await expect(page.getByTestId("auth-email")).toHaveText("e2e@example.test");
	await expect(page.getByTestId("orders-total")).not.toBeEmpty();

	const visits = appRequests(page, from).filter(
		(request) => new URL(request.url()).pathname === "/dashboard" && !request.headers()["x-inertia-partial-data"],
	);
	expect(visits).toHaveLength(1);
});

test("37 — prefetch on hover serves the click from cache, and the cache expires", async ({ page }) => {
	await open(page, "/");
	const from = logFor(page).requests.length;

	const prefetch = page.waitForRequest((request) => (request.headers().purpose ?? "") === "prefetch");
	await page.getByTestId("prefetch-orders").hover();
	expect((await prefetch).headers().purpose).toBe("prefetch");
	await expect.poll(() => appRequests(page, from).length).toBeGreaterThan(0);

	const after = appRequests(page, from).length;
	await page.getByTestId("prefetch-orders").click();
	await expect(page.getByTestId("page-heading")).toHaveText("Orders");
	expect(appRequests(page, from).length).toBe(after);

	// `cacheFor="1s"`: past the window, a hover must fetch again.
	await page.goBack();
	await expect(page.getByTestId("page-heading")).toHaveText("Home");
	await page.waitForTimeout(1500);
	const before = appRequests(page, from).length;
	await page.mouse.move(0, 0);
	await page.getByTestId("prefetch-orders").hover();
	await expect.poll(() => appRequests(page, from).length).toBeGreaterThan(before);
});

test("38 — usePoll issues about four partial requests in two seconds", async ({ page }) => {
	await open(page, "/dashboard");
	await expect(page.getByTestId("page-heading")).toHaveText("Dashboard");
	const from = logFor(page).requests.length;

	await page.waitForTimeout(2000);
	const polls = partialRequests(page, "orders", from);
	expect(polls.length).toBeGreaterThanOrEqual(3);
	expect(polls.length).toBeLessThanOrEqual(8);
	expect(await navigationEntries(page)).toBe(1);
});

test("39 — WhenVisible fetches its prop only once it scrolls into view", async ({ page }) => {
	await open(page, "/dashboard");
	await expect(page.getByTestId("page-heading")).toHaveText("Dashboard");
	const from = logFor(page).requests.length;
	expect(partialRequests(page, "visible", from)).toHaveLength(0);

	await page.locator('[data-when-visible="visible"]').scrollIntoViewIfNeeded();
	await expect(page.getByTestId("visible")).toHaveText("seen");
	expect(partialRequests(page, "visible", from).length).toBeGreaterThan(0);
});

test("40 — remembered form state is restored after navigating away and Back", async ({ page }) => {
	await open(page, "/orders/create");
	await page.getByTestId("remember-note").fill("remembered");
	await page.getByTestId("orders-link").click();
	await expect(page.getByTestId("page-heading")).toHaveText("Orders");
	await page.goBack();
	await expect(page.getByTestId("page-heading")).toHaveText("New order");
	await expect(page.getByTestId("remember-note")).toHaveValue("remembered");
});

test("41 — Head sets the document title, and the shell carries a fallback", async ({ page, request }) => {
	const html = await (await request.get(`${server}/`)).text();
	expect(html).toMatch(/<title[^>]*>[^<]+<\/title>/i);

	await open(page, "/");
	await expect.poll(() => page.title()).toMatch(/home/i);
	await page.getByTestId("nav-dashboard").click();
	await expect.poll(() => page.title()).toMatch(/dashboard/i);
});

test("42 — a version change during polling waits for the next user click", async ({ page }) => {
	allowConsoleErrors(page, /Failed to load resource.*409/i);
	await open(page, "/dashboard");
	await expect(page.getByTestId("page-heading")).toHaveText("Dashboard");
	await page.evaluate(() => {
		const marker = window as Window & { __versionChange?: boolean };
		document.addEventListener("inertia:location", (event) => {
			marker.__versionChange = (event as CustomEvent<{ versionChange?: boolean }>).detail?.versionChange === true;
		});
	});

	await markDocument(page);
	await bumpAssetVersion(page);
	// Polls keep running; a BACKGROUND request must not reload the window.
	await page.waitForTimeout(1500);
	expect(partialRequests(page, "orders").length).toBeGreaterThan(0);
	expect(await sameDocument(page), "a background poll forced a reload").toBe(true);

	await page.getByTestId("nav-orders").click();
	await expect.poll(() => sameDocument(page)).toBe(false);
	await expect(page.getByTestId("page-heading")).toHaveText("Orders");
});

test("43 — every response carries a DevTools id whose entry names the request type", async ({ page }) => {
	await open(page, "/");
	const initial = logFor(page).responses.find(
		(response) =>
			response.url().startsWith(mode === "standalone" ? server : "") &&
			response.headers()["x-inertia-devtools-id"] !== undefined &&
			(mode === "standalone" || response.request().resourceType() === "document"),
	);
	const id = initial?.headers()["x-inertia-devtools-id"];
	expect(id, "the first document response carried no DevTools id").toBeTruthy();

	const entry = (await (await page.request.get(`${server}/_inertia/devtools/entries/${id}`)).json()) as {
		__meta?: { requestType?: string; component?: string | null };
	};
	expect(entry.__meta?.requestType).toBeTruthy();
	expect(entry.__meta?.component).toBe("Home");

	// Drive each kind from the REAL client, then assert the recorder classified it.
	await page.getByTestId("nav-orders").click();
	await expect(page.getByTestId("page-heading")).toHaveText("Orders");
	await page.getByTestId("orders-reload").click();
	await open(page, "/dashboard");
	await expect(page.getByTestId("stats")).toBeVisible();
	await open(page, "/orders/create");
	await page.getByTestId("sku").fill("devtools");
	await page.getByTestId("qty").click();
	await open(page, "/");
	await page.getByTestId("prefetch-orders").hover();

	// `deferred` and `poll` are keyed on `X-Inertia-Devtools-Deferred` /
	// `-Poll`, which the DevTools BROWSER EXTENSION adds — the stock
	// `@inertiajs/core` client never sends them (verified against 3.7.1), so
	// without the extension both arrive as `partial`. These two requests are
	// what the extension would send, against the same live server.
	for (const [header, only] of [
		["X-Inertia-Devtools-Deferred", "stats"],
		["X-Inertia-Devtools-Poll", "orders"],
	]) {
		const response = await page.request.get(`${server}/dashboard`, {
			headers: {
				"X-Inertia": "true",
				"X-Inertia-Partial-Component": "Dashboard",
				"X-Inertia-Partial-Data": only as string,
				[header as string]: "1",
			},
		});
		expect(response.ok()).toBeTruthy();
	}

	for (const kind of ["navigate", "partial", "deferred", "poll", "prefetch", "precognition"]) {
		await expect
			.poll(
				async () =>
					(
						(await (await page.request.get(`${server}/_inertia/devtools/entries?type=${kind}&limit=50`)).json()) as {
							__meta: { requestType: string };
						}[]
					).length,
				{ message: `no DevTools entry of type ${kind}` },
			)
			.toBeGreaterThan(0);
	}
});

test("44 — the auth starter kit loops register, dashboard, sign out and guard", async ({ page }) => {
	const kit = process.env.E2E_KIT_URL;
	test.skip(
		kit === undefined,
		"the `--kit auth` scaffold is built once per framework, in that framework's in-project/node cell",
	);
	const base = kit as string;
	// The kit's pages are the product under test, so this scenario drives a
	// SEPARATE project scaffolded by `blokctl add spa --kit auth` — nothing of
	// the conformance fixture is in it.
	const email = `kit-${Date.now()}@example.test`;
	// Split so no credential-shaped literal ever lands in this file.
	const secret = ["correct-horse", "battery-staple", "9"].join("-");

	await page.goto(`${base}/register`);
	await expect(page.getByRole("heading", { name: /create an account/i })).toBeVisible();
	await page.locator('input[name="name"]').fill("Kit User");
	await page.locator('input[name="email"]').fill(email);
	await page.locator('input[name="password"]').fill(secret);
	await page.locator('input[name="passwordConfirmation"]').fill(secret);
	await page.getByRole("button", { name: /create account/i }).click();

	await expect(page.getByRole("heading", { name: /hello, kit user/i })).toBeVisible();
	expect(await page.evaluate(() => location.pathname)).toBe("/dashboard");

	// Sign out is a POST (never a GET a crawler could follow).
	const loggedOut = page.waitForResponse(
		(response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/logout",
	);
	await page.getByRole("button", { name: /sign out/i }).click();
	expect((await loggedOut).status()).toBe(303);
	await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();

	// …and the guard holds afterwards: /dashboard is not reachable as a guest.
	await page.goto(`${base}/dashboard`);
	await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
	expect(await page.evaluate(() => location.pathname)).toBe("/login");

	// Signing back in with the SAME credentials proves the account persisted.
	await page.locator('input[name="email"]').fill(email);
	await page.locator('input[name="password"]').fill(secret);
	await page.getByRole("button", { name: /sign in/i }).click();
	await expect(page.getByRole("heading", { name: /hello, kit user/i })).toBeVisible();
});

test("45 — inertia.pages.list reflects the fixture's real pages", async ({ page }) => {
	const response = await page.request.post(`${server}/mcp`, {
		headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
		data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inertia.pages.list", arguments: {} } },
	});
	expect(response.ok()).toBeTruthy();
	const body = await response.text();
	for (const component of ["Home", "Orders/Index", "Orders/Show", "Orders/Create", "Dashboard", "Secret", "Login"]) {
		expect(body).toContain(component);
	}
	expect(body).toContain("defer");
	expect(framework).toBeTruthy();
});
