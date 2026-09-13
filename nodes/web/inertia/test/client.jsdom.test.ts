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
import InertiaNode from "../src/index.js";

const PORT = 39441;
const SENT_PROPS = { user: { name: "Ada", href: "/users/1" }, count: 2 };

let server: Server;

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

	server = createServer((req, res) => {
		res.writeHead(visit.status ?? 200, {
			"Content-Type": visit.contentType ?? "application/json",
			...(visit.headers ?? {}),
		});
		res.end(JSON.stringify(visit.body));
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
