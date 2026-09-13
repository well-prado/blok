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
import { runNode } from "@blokjs/core/testing";
import type { RespondEnvelope } from "@blokjs/shared";
import { type Page, getInitialPageFromDOM, router } from "@inertiajs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
		const env = routes.get((req.url ?? "/").split("?")[0] as string) ?? visit;
		res.writeHead(env.status ?? 200, {
			"Content-Type": env.contentType ?? "application/json",
			...(env.headers ?? {}),
			...(env.cookies?.length ? { "Set-Cookie": env.cookies } : {}),
		});
		res.end(JSON.stringify(env.body));
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
