/**
 * Issue #1014, test 7 — the error page through the REAL `@inertiajs/core`
 * client.
 *
 * The issue asks for Playwright; the browser half (a real Vite build, a real
 * `<Link>`, a real paint) lands with the conformance harness in #1003. What is
 * provable HERE — with the stock client, in jsdom, against responses
 * `renderErrorPage()` actually produced — is the whole mechanism the issue is
 * about:
 *
 * - a 404 carrying `X-Inertia: true` takes the client's `isHttpException()`
 *   path: it fires `inertia:httpException` and then SWAPS THE PAGE, instead of
 *   handing the body to the error modal (which is what any non-Inertia error
 *   response gets),
 * - the URL becomes the missing one,
 * - and Back returns to the page the visit started from.
 *
 * A stdlib `node:http` server on the origin jsdom is pointed at replays those
 * envelopes, so no XHR, header or status is stubbed.
 *
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://127.0.0.1:39443/" }
 */

import { type Server, createServer } from "node:http";
import { runNode } from "@blokjs/core/testing";
import type { RespondEnvelope } from "@blokjs/shared";
import { type Page, getInitialPageFromDOM, router } from "@inertiajs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureErrorPages, renderErrorPage } from "../src/errors.js";
import InertiaNode from "../src/index.js";

const PORT = 39443;
let server: Server;

async function page(input: Record<string, unknown>): Promise<RespondEnvelope> {
	return (await runNode(InertiaNode, input as never)) as unknown as RespondEnvelope;
}

beforeAll(async () => {
	// jsdom has no layout engine; the client's scroll reset is irrelevant here.
	window.scrollTo = () => {};
	process.env.BLOK_INERTIA_ERROR_PAGES = "1";
	configureErrorPages({ pages: { 404: "Errors/NotFound", default: "Errors/Error" } });

	server = createServer((req, res) => {
		void (async () => {
			const url = req.url ?? "/";
			const path = url.split("?")[0] as string;
			const headers = req.headers as Record<string, string>;
			const env =
				path === "/users/1"
					? await page({ component: "Users/Show", props: { name: "Ada" }, url: path, version: "v1", headers })
					: // Exactly what the HTTP trigger's error branch emits (#1014).
						await renderErrorPage({ headers, method: req.method, url, path }, 404, new Error("no such route"));
			if (!env) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Workflow not found" }));
				return;
			}
			res.writeHead(env.status ?? 200, {
				"Content-Type": env.contentType ?? "application/json",
				...(env.headers ?? {}),
			});
			res.end(typeof env.body === "string" ? env.body : JSON.stringify(env.body));
		})();
	});
	await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	// biome-ignore lint/performance/noDelete: must unset, not store "undefined"
	delete process.env.BLOK_INERTIA_ERROR_PAGES;
});

describe("7 (#1014) — the stock client renders the error page in place", () => {
	it("swaps to the 404 component, updates the URL, and Back returns", async () => {
		// A cold browser load of /users/1: the HTML shell with the boot script.
		const html = (await page({ component: "Users/Show", props: { name: "Ada" }, url: "/users/1", version: "v1" }))
			.body as string;
		document.documentElement.innerHTML = html;
		const initialPage = getInitialPageFromDOM("app") as Page;
		window.history.replaceState({}, "", "/users/1");

		const swapped: Page[] = [];
		router.init({
			initialPage,
			resolveComponent: async (name: string) => ({ name }),
			swapComponent: async ({ page: swappedPage }: { page: Page }) => {
				swapped.push(swappedPage);
			},
		});

		// The client's own "this response is a 4xx/5xx" event. It firing AND the
		// page swapping is the proof this took the page path, not the modal.
		const exceptions: number[] = [];
		const stopListening = router.on("httpException", (event: CustomEvent<{ response: { status: number } }>) => {
			exceptions.push(event.detail.response.status);
		});

		const errorPage = await new Promise<Page>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("visit to /missing never navigated")), 5000);
			const off = router.on("navigate", (event: CustomEvent<{ page: Page }>) => {
				if (event.detail.page.url !== "/missing") return;
				clearTimeout(timer);
				off();
				resolve(event.detail.page);
			});
			router.visit("/missing", { method: "get" });
		});
		stopListening();

		expect(exceptions).toEqual([404]);
		expect(errorPage.component).toBe("Errors/NotFound");
		expect(errorPage.props).toMatchObject({ status: 404, message: "Not Found" });
		expect(JSON.stringify(errorPage.props)).not.toContain("stack");
		// Rendered IN PLACE: the client swapped the component and moved the URL.
		expect(swapped.at(-1)?.component).toBe("Errors/NotFound");
		expect(window.location.pathname).toBe("/missing");

		// Back: the page the visit started from comes out of history.
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
		expect(window.location.pathname).toBe("/users/1");
	});
});
