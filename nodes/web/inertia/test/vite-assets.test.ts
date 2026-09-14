/**
 * Issue #1051, tests 2 and 3 — the tags that make the shell load the bundle,
 * and where `renderShell()` puts them.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNode } from "@blokjs/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import InertiaNode from "../src/index.js";
import { APP_MARKER, ASSETS_MARKER, DEFAULT_SHELL, HEAD_MARKER, renderShell } from "../src/protocol.js";
import { type ViteDescriptor, _resetViteAssets, viteAssetTags } from "../src/vite-assets.js";

const PAGE = { component: "Dashboard", props: {}, url: "/", version: "v1" };

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "blok-vite-assets-"));
	_resetViteAssets();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	_resetViteAssets();
});

function writeDescriptor(descriptor: ViteDescriptor): string {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".blok-vite.json"), JSON.stringify(descriptor));
	return dir;
}

describe("viteAssetTags() — build descriptor", () => {
	it("emits modulepreload, stylesheet and the module script, in that order", () => {
		writeDescriptor({
			mode: "build",
			entry: "assets/index-a1b2c3d4.js",
			css: ["assets/index-e5f6.css"],
			imports: ["assets/vendor-9988.js"],
			framework: "react",
		});

		expect(viteAssetTags({ dir })).toBe(
			[
				'<link rel="modulepreload" href="/assets/vendor-9988.js" />',
				'<link rel="stylesheet" href="/assets/index-e5f6.css" />',
				'<script type="module" src="/assets/index-a1b2c3d4.js"></script>',
			].join("\n"),
		);
	});

	it("never emits the React refresh preamble for a build — there is no dev server", () => {
		writeDescriptor({ mode: "build", entry: "assets/index-a1.js", framework: "react" });

		expect(viteAssetTags({ dir })).not.toContain("@react-refresh");
	});
});

describe("viteAssetTags() — dev descriptor", () => {
	it("emits the Vite client and the entry from the dev server", () => {
		writeDescriptor({ mode: "dev", devUrl: "http://localhost:5173", entry: "src/main.ts", framework: "vue" });

		expect(viteAssetTags({ dir })).toBe(
			[
				'<script type="module" src="http://localhost:5173/@vite/client"></script>',
				'<script type="module" src="http://localhost:5173/src/main.ts"></script>',
			].join("\n"),
		);
	});

	it("prepends the React refresh preamble only for React", () => {
		writeDescriptor({ mode: "dev", devUrl: "http://localhost:5173", entry: "src/main.tsx", framework: "react" });

		expect(viteAssetTags({ dir })).toBe(
			[
				'<script type="module">',
				'import RefreshRuntime from "http://localhost:5173/@react-refresh"',
				"RefreshRuntime.injectIntoGlobalHook(window)",
				"window.$RefreshReg$ = () => {}",
				"window.$RefreshSig$ = () => (type) => type",
				"window.__vite_plugin_react_preamble_installed__ = true",
				"</script>",
				'<script type="module" src="http://localhost:5173/@vite/client"></script>',
				'<script type="module" src="http://localhost:5173/src/main.tsx"></script>',
			].join("\n"),
		);
	});

	it("is re-read on every render, because the dev server can move", () => {
		writeDescriptor({ mode: "dev", devUrl: "http://localhost:5173", entry: "src/main.ts", framework: null });
		expect(viteAssetTags({ dir })).toContain("localhost:5173");

		writeDescriptor({ mode: "dev", devUrl: "http://localhost:5199", entry: "src/main.ts", framework: null });
		expect(viteAssetTags({ dir })).toContain("localhost:5199");
	});
});

describe("viteAssetTags() — missing descriptor", () => {
	it("warns ONCE, names the fix, and returns no tags", () => {
		const warnings: string[] = [];
		const warn = (message: string) => warnings.push(message);

		expect(viteAssetTags({ dir, warn })).toBe("");
		expect(viteAssetTags({ dir, warn })).toBe("");

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Fix:");
		expect(warnings[0]).toContain("vite build");
		expect(warnings[0]).toContain("BLOK_STATIC_DIR");
	});

	it("treats a malformed descriptor the same way", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".blok-vite.json"), "{ not json");
		const warnings: string[] = [];

		expect(viteAssetTags({ dir, warn: (m) => warnings.push(m) })).toBe("");
		expect(warnings).toHaveLength(1);
	});
});

describe("renderShell() asset marker", () => {
	const TAGS = '<script type="module" src="/assets/index-a1.js"></script>';

	it("puts the tags in the default shell's head, after the head marker", () => {
		const html = renderShell(PAGE, { assets: TAGS, head: "<meta name=x />" });

		expect(html).toContain(TAGS);
		expect(html).not.toContain(ASSETS_MARKER);
		// Inside <head>, and after whatever `<Head>` emitted.
		expect(html.indexOf(TAGS)).toBeGreaterThan(html.indexOf("<meta name=x />"));
		expect(html.indexOf(TAGS)).toBeLessThan(html.indexOf("</head>"));
	});

	it("leaves a custom shell without the marker exactly as it was", () => {
		const shell = `<html><head>${HEAD_MARKER}</head><body>${APP_MARKER}</body></html>`;
		const html = renderShell(PAGE, { shell, assets: TAGS });

		expect(html).not.toContain(TAGS);
		expect(html).not.toContain('<script type="module" src');
	});

	it("drops the marker when there are no tags, rather than leaking it into the HTML", () => {
		expect(DEFAULT_SHELL).toContain(ASSETS_MARKER);
		expect(renderShell(PAGE)).not.toContain(ASSETS_MARKER);
	});
});

describe("the serializer node wires the two together", () => {
	it("serves an HTML shell whose script tag comes from the descriptor", async () => {
		writeDescriptor({ mode: "build", entry: "assets/index-zz99.js", css: [], imports: [], framework: "react" });
		process.env.BLOK_STATIC_DIR = dir;
		try {
			const response = (await runNode(InertiaNode, {
				component: "Dashboard",
				props: {},
				url: "/",
				version: "v1",
				headers: {},
				method: "GET",
			} as never)) as unknown as { body?: unknown };

			expect(String(response.body)).toContain('<script type="module" src="/assets/index-zz99.js"></script>');
		} finally {
			process.env.BLOK_STATIC_DIR = undefined;
		}
	});
});
