/**
 * #1051 — the `@vite` equivalent: the `<script>` / `<link>` tags that actually
 * load the client bundle into the HTML shell.
 *
 * Without these the shell is a `<div id="app">` and a page object nobody
 * parses, which renders as a blank page. Laravel's Blade template calls
 * `@vite('resources/js/app.jsx')`; Blok's shell carries an {@link ASSETS_MARKER}
 * and this function fills it.
 *
 * The input is `<BLOK_STATIC_DIR>/.blok-vite.json`, written by `blokInertia()`
 * (`@blokjs/inertia-client/vite`) in both `vite` and `vite build`. Reading a
 * descriptor instead of guessing filenames is the whole point: Vite hashes its
 * output, and in dev the entry is not on disk at all.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** Where the shell wants the client bundle's tags. Lives inside `<head>`. */
export const ASSETS_MARKER = "<!--blok:assets-->";

/** Which adapter built the bundle. Only React needs a dev refresh preamble. */
export type ViteFramework = "react" | "vue" | "svelte" | null;

/** The descriptor `blokInertia()` writes. Mirrors `BlokViteDescriptor` there. */
export type ViteDescriptor =
	| { mode: "dev"; devUrl: string; entry: string; framework?: ViteFramework }
	| { mode: "build"; entry: string; css?: string[]; imports?: string[]; framework?: ViteFramework };

export interface ViteAssetTagsOptions {
	/** Path to `.blok-vite.json`. Default: `<dir>/.blok-vite.json`. */
	descriptor?: string;
	/** Client build directory. Default `BLOK_STATIC_DIR`, else `client/dist`. */
	dir?: string;
	/** Where to report a missing descriptor. Default `console.warn`. */
	warn?: (message: string) => void;
}

export const DESCRIPTOR_FILE = ".blok-vite.json";

function descriptorPath(options: ViteAssetTagsOptions): string {
	if (options.descriptor !== undefined) return options.descriptor;
	const dir = options.dir ?? process.env.BLOK_STATIC_DIR ?? "client/dist";
	return join(isAbsolute(dir) ? dir : resolve(process.cwd(), dir), DESCRIPTOR_FILE);
}

function readDescriptor(path: string): ViteDescriptor | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ViteDescriptor>;
		if (typeof parsed.entry !== "string" || parsed.entry === "") return null;
		if (parsed.mode === "dev") {
			return typeof parsed.devUrl === "string" && parsed.devUrl !== "" ? (parsed as ViteDescriptor) : null;
		}
		return parsed.mode === "build" ? (parsed as ViteDescriptor) : null;
	} catch {
		return null;
	}
}

/** Attribute-safe: these values are filenames and a localhost URL, not markup. */
function attr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * `@vitejs/plugin-react`'s dev-time contract: the refresh runtime must be
 * installed BEFORE the first component module evaluates, or every render
 * throws `@vitejs/plugin-react can't detect preamble`. Laravel ships the same
 * block as `@viteReactRefresh`.
 */
function reactPreamble(origin: string): string {
	return [
		'<script type="module">',
		`import RefreshRuntime from "${origin}/@react-refresh"`,
		"RefreshRuntime.injectIntoGlobalHook(window)",
		"window.$RefreshReg$ = () => {}",
		"window.$RefreshSig$ = () => (type) => type",
		"window.__vite_plugin_react_preamble_installed__ = true",
		"</script>",
	].join("\n");
}

/** Turn a descriptor into tags. Exported for tests and for the DevTools recorder. */
export function tagsFor(descriptor: ViteDescriptor): string {
	if (descriptor.mode === "dev") {
		const origin = descriptor.devUrl.replace(/\/+$/, "");
		const tags = descriptor.framework === "react" ? [reactPreamble(origin)] : [];
		tags.push(`<script type="module" src="${attr(`${origin}/@vite/client`)}"></script>`);
		tags.push(`<script type="module" src="${attr(`${origin}/${descriptor.entry.replace(/^\//, "")}`)}"></script>`);
		return tags.join("\n");
	}

	const tags: string[] = [];
	for (const file of descriptor.imports ?? []) tags.push(`<link rel="modulepreload" href="${attr(`/${file}`)}" />`);
	for (const file of descriptor.css ?? []) tags.push(`<link rel="stylesheet" href="${attr(`/${file}`)}" />`);
	tags.push(`<script type="module" src="${attr(`/${descriptor.entry.replace(/^\//, "")}`)}"></script>`);
	return tags.join("\n");
}

/**
 * `path|mtime` -> rendered tags.
 *
 * Keyed on the descriptor's modification time rather than the asset version:
 * `ASSET_VERSION` is read once at boot, so a version key would serve stale
 * `<script src>` for the whole life of a process that was running when the
 * client was rebuilt — and a dev server that restarts on a new port has no new
 * version at all. One `statSync` per HTML render (never per Inertia XHR) buys
 * both cases.
 */
const cache = new Map<string, string>();
const warned = new Set<string>();

/** Test-only: forget cached tags and re-arm the once-per-path warning. */
export function _resetViteAssets(): void {
	cache.clear();
	warned.clear();
}

/**
 * The tags for the current client build, ready to splice at
 * {@link ASSETS_MARKER}.
 *
 * A MISSING descriptor is a warning, not a failure: the server can boot before
 * the client has ever been built, and 500ing then would make the order of two
 * independent builds load-bearing. The page object still ships, so the HTML is
 * inspectable — it just will not hydrate.
 */
export function viteAssetTags(options: ViteAssetTagsOptions = {}): string {
	const path = descriptorPath(options);
	let key: string | null = null;
	try {
		key = `${path}|${statSync(path).mtimeMs}`;
	} catch {
		// Missing descriptor — fall through to the warning below.
	}
	if (key !== null) {
		const hit = cache.get(key);
		if (hit !== undefined) return hit;
	}

	const descriptor = readDescriptor(path);
	if (descriptor === null) {
		if (!warned.has(path)) {
			warned.add(path);
			(options.warn ?? console.warn)(
				`[blok] @blokjs/inertia: no client asset descriptor at ${path}, so the HTML shell loads no JavaScript and the page renders blank. Fix: run \`vite build\` (production) or \`vite\` (dev) in the client, with blokInertia() in vite.config.ts, and point BLOK_STATIC_DIR at the client build directory (e.g. BLOK_STATIC_DIR=client/dist). (Warned once per path.)`,
			);
		}
		return "";
	}

	const tags = tagsFor(descriptor);
	if (key !== null) cache.set(key, tags);
	return tags;
}
