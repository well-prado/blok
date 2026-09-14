/**
 * Issue #994, test 17 — the REAL `@inertiajs/core` client, in jsdom, against
 * responses this node produced.
 *
 * A stdlib `node:http` server replays the node's envelopes on the SAME origin
 * jsdom is pointed at (no CORS, no mocks, no stubbed XHR), so the boot script,
 * the headers and the page object are all exercised by the client that ships
 * to browsers.
 *
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://127.0.0.1:39441/" }
 */

import { type Server, createServer } from "node:http";
import { http, defineNode, workflow } from "@blokjs/core";
import { runNode, runWorkflow } from "@blokjs/core/testing";
import type { RespondEnvelope } from "@blokjs/shared";
import { type Page, getInitialPageFromDOM, router } from "@inertiajs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { definePage, merge, once } from "../src/define-page.js";
import InertiaNode, { clearHistory } from "../src/index.js";

const PORT = 39441;
const SENT_PROPS = { user: { name: "Ada", href: "/users/1" }, count: 2 };
/** #996 — the page-object `flash` field the client reads once and strips. */
const TOAST = { toast: { type: "success", message: "Order saved." } };

// The client's own `sessionStorage` keys for the history AES key and IV
// (`historySessionStorageKeys` in @inertiajs/core — declared in its types but
// not re-exported from the package entry, so they are spelled out here).
const HISTORY_KEY = "historyKey";
const HISTORY_IV = "historyIv";

let server: Server;

/** Path -> the envelope the server replays. Unlisted paths get the default visit. */
const routes = new Map<string, RespondEnvelope>();

/** Every request the client actually put on the wire (#1015 test 12). */
let requests = 0;

/**
 * Path -> a LIVE handler (#1009). Where `routes` replays a canned envelope,
 * these run the real workflow per request, so the CLIENT's own headers decide
 * what the runner resolves and which labels come back.
 */
const dynamic = new Map<string, (headers: Record<string, string>) => Promise<RespondEnvelope>>();

async function render(input: Record<string, unknown>): Promise<RespondEnvelope> {
	return (await runNode(InertiaNode, input as never)) as unknown as RespondEnvelope;
}

beforeAll(async () => {
	// jsdom has no layout engine, so the client's scroll reset logs a loud
	// "Not implemented" through the virtual console. Irrelevant here.
	window.scrollTo = () => {};

	const visit = await render({
		component: "Users/Show",
		props: SENT_PROPS,
		url: "/users/1",
		version: "v1",
		headers: { "x-inertia": "true" },
	});

	// #996 — the same node answering a bounce-back GET: errors in props, flash
	// on the page object itself, and the clearing cookie on the way out.
	const flashed = await render({
		component: "Orders/Index",
		props: { count: 0 },
		errors: { sku: "Required." },
		flash: TOAST,
		url: "/orders",
		version: "v1",
		headers: { "x-inertia": "true" },
		cookies: ["blok_flash=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
	});

	routes.set("/users/1", visit);
	routes.set("/orders", flashed);
	server = createServer((req, res) => {
		requests += 1;
		void (async () => {
			const path = (req.url ?? "/").split("?")[0] as string;
			const live = dynamic.get(path);
			const env = live ? await live(req.headers as Record<string, string>) : (routes.get(path) ?? visit);
			res.writeHead(env.status ?? 200, {
				"Content-Type": env.contentType ?? "application/json",
				...(env.headers ?? {}),
				...(env.cookies?.length ? { "Set-Cookie": env.cookies } : {}),
			});
			res.end(typeof env.body === "string" ? env.body : JSON.stringify(env.body));
		})();
	});
	await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("17 — the stock Inertia client boots from, and visits, our responses", () => {
	it("reads the boot script with the client's own getInitialPageFromDOM", async () => {
		const html = (await render({ component: "Home", props: { path: "a/b" }, url: "/", version: "v1" })).body as string;
		document.documentElement.innerHTML = html;

		const page = getInitialPageFromDOM("app") as Page | null;
		expect(page).not.toBeNull();
		expect(page).toEqual({
			component: "Home",
			props: { path: "a/b", errors: {} },
			url: "/",
			version: "v1",
		});
	});

	it("router.visit resolves and the current page carries exactly the props we sent", async () => {
		const initialPage = getInitialPageFromDOM("app") as Page;
		const swapped: Page[] = [];

		router.init({
			initialPage,
			resolveComponent: async (name: string) => ({ name }),
			swapComponent: async ({ page }: { page: Page }) => {
				swapped.push(page);
			},
		});

		const visited = await new Promise<Page>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("router.visit never resolved")), 5000);
			router.visit("/users/1", {
				method: "get",
				onSuccess: (page: Page) => {
					clearTimeout(timer);
					resolve(page);
				},
				onError: (errors: unknown) => {
					clearTimeout(timer);
					reject(new Error(`visit failed: ${JSON.stringify(errors)}`));
				},
			});
		});

		expect(visited.component).toBe("Users/Show");
		expect(visited.props).toEqual({ ...SENT_PROPS, errors: {} });
		// `usePage()` in every framework adapter is a thin read of the page the
		// router swapped in — this is that same value.
		expect(swapped.at(-1)?.props).toEqual({ ...SENT_PROPS, errors: {} });
		expect(swapped.at(-1)?.url).toBe("/users/1");
	});
});

/**
 * #996 test 17 — flash, through the stock client.
 *
 * Declared after the block above on purpose: `router.init()` there is what
 * wires the client's popstate handling, and the router is a module singleton —
 * a second init would double every listener. Declared BEFORE the #1013 block
 * below for the same kind of reason: that one deliberately replaces the current
 * history entry with an undecryptable one, which is no state to press Back in.
 */
describe("17 (#996) — router.on('flash') fires, and Back leaves the page flash empty", () => {
	it("delivers page.flash to the client and drops it from the history entry", async () => {
		const flashes: Record<string, unknown>[] = [];
		const stopListening = router.on("flash", (event: CustomEvent<{ flash: Record<string, unknown> }>) => {
			flashes.push(event.detail.flash);
		});

		// Resolved off `navigate`, not `onSuccess`: a page carrying validation
		// errors is an `onError` visit by the client's own contract, and this
		// bounce-back page deliberately carries both errors and flash.
		const withFlash = await new Promise<Page>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("router.visit('/orders') never navigated")), 5000);
			const off = router.on("navigate", (event: CustomEvent<{ page: Page }>) => {
				if (event.detail.page.url !== "/orders") return;
				clearTimeout(timer);
				off();
				resolve(event.detail.page);
			});
			router.visit("/orders", { method: "get" });
		});
		// `inertia:flash` fires after the page swap completes.
		await new Promise((resolve) => setTimeout(resolve, 0));

		// The page object carries flash as a TOP-LEVEL field, not a prop...
		expect(withFlash.flash).toEqual(TOAST);
		expect(withFlash.props).not.toHaveProperty("flash");
		expect(withFlash.props.errors).toEqual({ sku: "Required." });
		// ...and the client fired `inertia:flash` with exactly that payload.
		expect(flashes).toEqual([TOAST]);
		stopListening();

		// Back: the client stores history entries WITHOUT flash, so the restored
		// page carries none — a toast must not replay on every backward visit.
		const restored = await new Promise<Page>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("popstate never restored a page")), 5000);
			const off = router.on("navigate", (event: CustomEvent<{ page: Page }>) => {
				if (event.detail.page.url !== "/users/1") return;
				clearTimeout(timer);
				off();
				resolve(event.detail.page);
			});
			window.history.back();
		});

		expect(restored.component).toBe("Users/Show");
		expect(restored.flash ?? {}).toEqual({});
		expect(flashes).toEqual([TOAST]);
	});
});

/**
 * Issue #1015, test 12 — an INSTANT visit, through the real client.
 *
 * The issue asks for Playwright; the browser half (a real `<Link instant>`, a
 * real paint) lands with the harness in #1003. What is testable HERE — with the
 * stock `@inertiajs/core`, against page objects THIS node produced — is the
 * whole mechanism: the client reads `sharedProps` off the page it is on,
 * carries exactly those props onto the intermediate page it renders
 * immediately, and then the one server response fills in the rest.
 *
 * Declared before the #1013 block for the reason stated there: that one leaves
 * an undecryptable history entry behind on purpose.
 */
describe("12 (#1015) — an instant visit renders shared props first, then the real ones", () => {
	const AUTH = { id: "u-1", name: "Ada" };

	it("carries `auth` over immediately and finishes the page in ONE request", async () => {
		// The page the user is on: shared data in props, and the key list that
		// says which of them are shared. Both come out of this node.
		const current = (
			await render({
				component: "Users/Show",
				props: { ...SENT_PROPS, auth: AUTH },
				sharedProps: ["auth"],
				url: "/users/1",
				version: "v1",
				headers: { "x-inertia": "true" },
			})
		).body as unknown as Page;

		// Where the instant visit is headed.
		routes.set(
			"/dashboard",
			await render({
				component: "Dashboard",
				props: { auth: AUTH, stats: { total: 42 } },
				sharedProps: ["auth"],
				url: "/dashboard",
				version: "v1",
				headers: { "x-inertia": "true" },
			}),
		);

		const swaps: Page[] = [];
		router.init({
			initialPage: current,
			resolveComponent: async (name: string) => ({ name }),
			swapComponent: async ({ page }: { page: Page }) => {
				swaps.push(page);
			},
		});

		const before = requests;
		const landed = await new Promise<Page>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("the instant visit never resolved")), 5000);
			router.visit("/dashboard", {
				method: "get",
				component: "Dashboard",
				onSuccess: (p: Page) => {
					clearTimeout(timer);
					resolve(p);
				},
				onError: (errors: unknown) => {
					clearTimeout(timer);
					reject(new Error(`visit failed: ${JSON.stringify(errors)}`));
				},
			});
		});

		// Two swaps reached the Dashboard: the INSTANT one (`router.init` swapped
		// the initial page in first, hence the filter), then the server's.
		const dashboards = swaps.filter((p) => p.component === "Dashboard");
		expect(dashboards).toHaveLength(2);

		// The instant swap happened before the server answered, so it carries the
		// shared prop and nothing page-specific.
		const instant = dashboards[0] as Page;
		expect(instant.props.auth).toEqual(AUTH);
		expect(instant.props.stats).toBeUndefined();
		expect(instant.sharedProps).toEqual(["auth"]);

		// Then the server's props arrived, over exactly one request.
		expect(landed.component).toBe("Dashboard");
		expect(landed.props.stats).toEqual({ total: 42 });
		expect(landed.props.auth).toEqual(AUTH);
		expect((dashboards[1] as Page).props.stats).toEqual({ total: 42 });
		expect(requests - before).toBe(1);
	});
});

/**
 * Issue #1009, test 13 — merge props and once props through the STOCK client.
 *
 * The server half is the real thing: every request below runs the whole
 * `workflow() -> PageNode -> @blokjs/inertia` pipeline against the headers the
 * CLIENT actually sent, so what is under test is the pair — the labels we emit
 * and what the client does with them. The prop nodes count their runs, so
 * "the once prop was not re-requested" is asserted as "the node never ran
 * again", not as an absent key.
 *
 * Declared BEFORE the #1013 block below, which deliberately leaves an
 * undecryptable history entry behind.
 */

let feedRuns = 0;
let planRuns = 0;

const loadFeed = defineNode({
	name: "jsdom-feed",
	description: "one more row per call",
	input: z.object({}),
	output: z.object({ data: z.array(z.object({ id: z.number() })) }),
	async execute() {
		feedRuns += 1;
		return { data: [{ id: feedRuns }] };
	},
});

const loadPlans = defineNode({
	name: "jsdom-plans",
	description: "expensive, remembered by the client",
	input: z.object({}),
	output: z.object({ tiers: z.array(z.string()) }),
	async execute() {
		planRuns += 1;
		return { tiers: ["pro"] };
	},
});

// `until` on purpose: the client keeps a remembered entry only while
// `expiresAt > Date.now()`, so an entry that is not a NUMBER of milliseconds
// loses that comparison and the client stops sending the header entirely.
const FeedPage = definePage("Feed/Index", {
	feed: merge(loadFeed, { append: "data", matchOn: "id" }),
	plans: once(loadPlans, { until: "1h" }),
});

const BillingPage = definePage("Billing/Index", { plans: once(loadPlans, { until: "1h" }) });

function feedWorkflow() {
	return workflow("jsdom-feed-page", { version: "1.0.0", trigger: http.get("/feed") }, (req) => {
		FeedPage.render(req, "page", "/feed", {}, { version: "v1" });
	});
}

function billingWorkflow() {
	return workflow("jsdom-billing-page", { version: "1.0.0", trigger: http.get("/billing") }, (req) => {
		BillingPage.render(req, "page", "/billing", {}, { version: "v1" });
	});
}

async function serve(
	build: () => Promise<unknown>,
	headers: Record<string, string>,
	url: string,
): Promise<RespondEnvelope> {
	const run = await runWorkflow((await build()) as never, {}, { headers, path: url });
	if (!run.ok) throw run.error;
	return run.response as unknown as RespondEnvelope;
}

/** Resolve on the client's own success callback, or fail loudly on a timeout. */
function clientVisit(start: (hooks: Record<string, unknown>) => void, what: string): Promise<Page> {
	return new Promise<Page>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what} never resolved`)), 5000);
		start({
			onSuccess: (page: Page) => {
				clearTimeout(timer);
				resolve(page);
			},
			onError: (errors: unknown) => {
				clearTimeout(timer);
				reject(new Error(`${what} failed: ${JSON.stringify(errors)}`));
			},
		});
	});
}

describe("13 (#1009) — the client appends, resets, and stops asking for a once prop", () => {
	it("reload({only}) appends, reset replaces, and the once prop resolves exactly once", async () => {
		dynamic.set("/feed", (headers) => serve(feedWorkflow, headers, "/feed"));
		dynamic.set("/billing", (headers) => serve(billingWorkflow, headers, "/billing"));

		// The first load is a plain browser GET: the HTML shell with the boot
		// script, exactly what the server would send a cold browser.
		const html = (await serve(feedWorkflow, {}, "/feed")).body as string;
		document.documentElement.innerHTML = html;
		const initialPage = getInitialPageFromDOM("app") as Page;
		expect(initialPage.props.feed).toEqual({ data: [{ id: 1 }] });
		expect(initialPage.onceProps?.plans?.prop).toBe("plans");
		expect(initialPage.onceProps?.plans?.expiresAt).toBeGreaterThan(Date.now());
		expect(planRuns).toBe(1);

		// `router.reload()` reloads `window.location.href`, so the document has to
		// be standing on the page we just booted from.
		window.history.replaceState({}, "", "/feed");
		router.init({
			initialPage,
			resolveComponent: async (name: string) => ({ name }),
			swapComponent: async () => {},
		});

		// A partial reload of the merge prop: the client sends `only: feed` AND
		// `X-Inertia-Except-Once-Props: plans`, so the server labels `feed.data`
		// and never touches the plans node.
		const appended = await clientVisit(
			(hooks) => router.reload({ only: ["feed"], ...hooks }),
			"reload({only: [feed]})",
		);
		expect(appended.props.feed).toEqual({ data: [{ id: 1 }, { id: 2 }] });
		expect(planRuns).toBe(1);
		expect(appended.props.plans).toEqual({ tiers: ["pro"] });

		// `reset` asks for a fresh copy: the label is stripped, so the client
		// REPLACES instead of appending.
		const replaced = await clientVisit(
			(hooks) => router.reload({ only: ["feed"], reset: ["feed.data"], ...hooks }),
			"reload({reset})",
		);
		expect(replaced.props.feed).toEqual({ data: [{ id: 3 }] });

		// A second navigation, to a different page declaring the same once prop:
		// the client replays its remembered copy and the node stays untouched.
		const billing = await clientVisit(
			(hooks) => router.visit("/billing", { method: "get", ...hooks }),
			"visit(/billing)",
		);
		expect(billing.component).toBe("Billing/Index");
		expect(planRuns).toBe(1);
		expect(billing.props.plans).toEqual({ tiers: ["pro"] });
		expect(feedRuns).toBe(3);
	});
});

/**
 * Issue #1013, test 4 — logout, then Back.
 *
 * The issue asks for Playwright: log in, visit `/secret`, log out, press Back,
 * and see that the secret page is not restored. The browser half of that (a
 * real Back button, a secure context with `window.crypto.subtle`) lands with
 * the Playwright harness in #1003. What is testable HERE — with the REAL
 * `@inertiajs/core` client, against a response THIS node produced — is the
 * mechanism the whole scenario rests on: a page carrying `clearHistory: true`
 * makes the client drop the AES key and IV it keeps in `sessionStorage`, so
 * the encrypted history entries behind the Back button can no longer be
 * decrypted. Without the key the client cannot restore the page and has to
 * re-request it — which is when the auth middleware redirects to login.
 */
describe("4 (#1013) — clearHistory re-keys the client's history on logout", () => {
	it("drops the history key/IV, leaving prior encrypted entries undecryptable", async () => {
		// The state a user is in after visiting an encrypted /secret page: the
		// client holds the key + IV that decrypt its history entries.
		window.sessionStorage.setItem(HISTORY_KEY, JSON.stringify([1, 2, 3, 4]));
		window.sessionStorage.setItem(HISTORY_IV, JSON.stringify([5, 6, 7, 8]));

		// The page the logout redirect lands on. `clearHistory()` here is the
		// same page input `logoutResponse()` marks on the request.
		const login = await render({
			component: "Auth/Login",
			url: "/login",
			version: "v1",
			headers: { "x-inertia": "true" },
			...clearHistory(),
		});
		expect((login.body as Page).clearHistory).toBe(true);
		routes.set("/login", login);

		const initialPage = getInitialPageFromDOM("app") as Page;
		router.init({
			initialPage,
			resolveComponent: async (name: string) => ({ name }),
			swapComponent: async () => {},
		});

		const landed = await new Promise<Page>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("logout visit never resolved")), 5000);
			router.visit("/login", {
				method: "get",
				onSuccess: (p: Page) => {
					clearTimeout(timer);
					resolve(p);
				},
				onError: (errors: unknown) => {
					clearTimeout(timer);
					reject(new Error(`visit failed: ${JSON.stringify(errors)}`));
				},
			});
		});

		expect(landed.clearHistory).toBe(true);
		// The client rotated the key: both entries are gone from sessionStorage.
		expect(window.sessionStorage.getItem(HISTORY_KEY)).toBeNull();
		expect(window.sessionStorage.getItem(HISTORY_IV)).toBeNull();

		// Now press Back onto the encrypted /secret entry: an encrypted history
		// entry stores the page as an ArrayBuffer, and the client's own restore
		// path (`router.decryptHistory()` -> `history.decrypt()`) is what a
		// popstate runs. Without the key it refuses — so the secret page cannot
		// come back from history and the client has to re-request it, which is
		// where the auth middleware redirects to login.
		window.history.replaceState({ page: new ArrayBuffer(8) }, "", "/secret");
		await expect(router.decryptHistory()).rejects.toThrow(/Unable to decrypt history/);
	});
});
