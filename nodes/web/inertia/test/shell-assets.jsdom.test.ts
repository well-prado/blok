/**
 * Issue #1051, test 4 — the real `@inertiajs/core` client boots out of a shell
 * that carries the asset tags, and those tags point at files that exist.
 *
 * The blank-page bug was never a page-object bug: the JSON was always right and
 * nothing loaded the JavaScript that reads it. So this asserts BOTH halves of
 * the document at once — the client's own `getInitialPageFromDOM` finds the
 * page, and the `<script type="module" src>` next to it resolves to a real file
 * in the client build.
 *
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://127.0.0.1:39452/" }
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNode } from "@blokjs/core/testing";
import { type Page, getInitialPageFromDOM, router } from "@inertiajs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import InertiaNode from "../src/index.js";
import { _resetViteAssets } from "../src/vite-assets.js";

const ENTRY = "assets/index-Bt7Kq1.js";
const STYLE = "assets/index-Zx90.css";

let dir: string;
let html: string;
let previousStaticDir: string | undefined;

beforeAll(async () => {
	// A client build exactly as `vite build` leaves it: hashed files on disk,
	// plus the descriptor that names them.
	dir = mkdtempSync(join(tmpdir(), "blok-shell-assets-"));
	mkdirSync(join(dir, "assets"), { recursive: true });
	writeFileSync(join(dir, ENTRY), "export const boot = 1;\n");
	writeFileSync(join(dir, STYLE), "body { margin: 0 }\n");
	writeFileSync(
		join(dir, ".blok-vite.json"),
		JSON.stringify({ mode: "build", entry: ENTRY, css: [STYLE], imports: [], framework: "react" }),
	);

	previousStaticDir = process.env.BLOK_STATIC_DIR;
	process.env.BLOK_STATIC_DIR = dir;
	_resetViteAssets();

	const response = (await runNode(InertiaNode, {
		component: "Dashboard",
		props: { user: { email: "ada@example.com" } },
		url: "/",
		version: "v1",
		headers: {},
		method: "GET",
	} as never)) as unknown as { body?: unknown };
	html = String(response.body);
	document.documentElement.innerHTML = html;
});

afterAll(() => {
	if (previousStaticDir === undefined) process.env.BLOK_STATIC_DIR = undefined;
	else process.env.BLOK_STATIC_DIR = previousStaticDir;
	_resetViteAssets();
	rmSync(dir, { recursive: true, force: true });
});

describe("the rendered shell loads the client build", () => {
	it("carries a module script whose src exists in the client build", () => {
		const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
		const src = script?.getAttribute("src");

		expect(src).toBe(`/${ENTRY}`);
		// The server mounts the same directory at `/assets/*` (#1000), so a
		// root-relative src maps straight onto a file in the build.
		expect(existsSync(join(dir, (src as string).slice(1)))).toBe(true);
	});

	it("links the stylesheet the same way", () => {
		const href = document.querySelector('link[rel="stylesheet"]')?.getAttribute("href");

		expect(href).toBe(`/${STYLE}`);
		expect(existsSync(join(dir, (href as string).slice(1)))).toBe(true);
	});

	it("still hands the page object to the client's own getInitialPageFromDOM", () => {
		const page = getInitialPageFromDOM("app") as Page | null;

		expect(page).toEqual({
			component: "Dashboard",
			props: { user: { email: "ada@example.com" }, errors: {} },
			url: "/",
			version: "v1",
		});
	});

	it("boots the real client, which renders the component name", async () => {
		const initialPage = getInitialPageFromDOM("app") as Page;
		const swapped: string[] = [];

		router.init({
			initialPage,
			resolveComponent: async (name: string) => ({ name }),
			swapComponent: async ({ page }: { page: Page }) => {
				swapped.push(page.component);
				const root = document.getElementById("app");
				if (root) root.textContent = page.component;
			},
		});

		// `router.init` swaps synchronously through a microtask chain.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(swapped).toContain("Dashboard");
		expect(document.getElementById("app")?.textContent).toBe("Dashboard");
	});
});
