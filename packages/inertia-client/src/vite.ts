/**
 * `blokInertia()` — the Vite half of Blok's Inertia integration (#997).
 *
 * It **wraps** the official `@inertiajs/vite` plugin rather than replacing it:
 * page resolution (`pages: { path, extension, lazy, transform }`), the SSR
 * transform and the HMR-backed dev SSR endpoint all stay upstream. This file
 * only adds the four things Blok needs on top:
 *
 * 1. `<outDir>/.blok-asset-version` — sha256 of the Vite manifest, which the
 *    Blok server reads into `ASSET_VERSION` and sends as `X-Inertia-Version`
 *    (#1000/T7). The same value is inlined into the bundle as
 *    `import.meta.env.BLOK_ASSET_VERSION`.
 * 2. A dev proxy: every non-asset request goes to the Blok server, carrying
 *    `X-Inertia-Version: dev` so a dev-time visit can never 409.
 * 3. `<outDir>/pages.json` — the page manifest `ensurePagesExist` checks
 *    against (#1015).
 * 4. `<outDir>/.blok-ssr-url` and `import.meta.env.BLOK_SSR_URL` — where the
 *    Blok server should POST a page to have it server-rendered (#1001).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import inertia, { type InertiaPluginOptions } from "@inertiajs/vite";
import type { Plugin, ResolvedConfig } from "vite";

/** Written into `outDir`; read by the Blok server. */
export const ASSET_VERSION_FILE = ".blok-asset-version";
/** Written into `outDir`; read by the Blok server's SSR bridge (#1001). */
export const SSR_URL_FILE = ".blok-ssr-url";
/** Written into `outDir`; read by `ensurePagesExist` (#1015). */
export const PAGES_FILE = "pages.json";
/**
 * Written into `outDir`; read by `viteAssetTags()` in `@blokjs/inertia`, which
 * turns it into the `<script type="module">` / `<link>` tags the HTML shell
 * needs (#1051). This is Blok's answer to Laravel's `public/hot` + manifest
 * pair: ONE file that says, for the current mode, exactly what to load.
 */
export const VITE_DESCRIPTOR_FILE = ".blok-vite.json";

/** Which adapter is in play — only React needs a dev-time refresh preamble. */
export type BlokViteFramework = "react" | "vue" | "svelte" | null;

/** Dev: the entry is served by Vite itself, so the tags are absolute URLs. */
export interface BlokViteDevDescriptor {
	mode: "dev";
	/** Origin the Vite dev server is listening on, e.g. `http://localhost:5173`. */
	devUrl: string;
	/** Entry as Vite serves it, root-relative without a leading slash. */
	entry: string;
	framework: BlokViteFramework;
}

/** Build: hashed filenames, relative to the static root Blok mounts. */
export interface BlokViteBuildDescriptor {
	mode: "build";
	/** Hashed entry chunk, e.g. `assets/index-a1b2c3d4.js`. */
	entry: string;
	/** Stylesheets the entry pulls in. */
	css: string[];
	/** Static imports of the entry, for `<link rel="modulepreload">`. */
	imports: string[];
	framework: BlokViteFramework;
}

export type BlokViteDescriptor = BlokViteDevDescriptor | BlokViteBuildDescriptor;

/** The dev SSR endpoint `@inertiajs/vite` mounts on the Vite dev server. */
export const SSR_DEV_ENDPOINT = "/__inertia_ssr";
/** Default port of Inertia's standalone production SSR server. */
export const SSR_DEFAULT_PORT = 13714;

/** Asset version used while the dev server is running. */
export const DEV_ASSET_VERSION = "dev";

/**
 * Stand-in for the asset version during a build. The real version is a hash of
 * the Vite manifest, which only exists once the bundle has been written — so
 * the placeholder is emitted first and swapped for the real value in
 * `writeBundle`. The manifest describes chunk *filenames*, which are hashed
 * before that swap, so there is no cycle and the build stays deterministic.
 */
const ASSET_VERSION_PLACEHOLDER = "__BLOK_ASSET_VERSION__";

/** Rewritten after the bundle is on disk; everything else is left alone. */
const REWRITABLE = /\.(?:js|mjs|cjs|css|html)$/;

/** Where `@inertiajs/vite` looks for an SSR entry when none is configured. */
const SSR_ENTRY_CANDIDATES = ["resources/js/ssr", "src/ssr", "resources/js/app", "src/app"];
const SSR_ENTRY_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/** Where page components usually live, tried in order. */
const PAGE_DIR_CANDIDATES = ["resources/js/Pages", "resources/js/pages", "src/Pages", "src/pages", "Pages", "pages"];
const PAGE_EXTENSIONS = [".tsx", ".jsx", ".vue", ".svelte", ".ts", ".js"];

/** Requests the Vite dev server must answer itself instead of proxying. */
const VITE_OWNED =
	/^\/(?:@|src\/|node_modules\/|__inertia_ssr|favicon\.ico|.*\.(?:js|mjs|ts|tsx|jsx|css|map|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|wasm)(?:$|\?))/;

export interface BlokInertiaPagesOptions {
	/** Page directory, relative to the Vite root. Auto-detected when omitted. */
	path?: string;
	/** Page file extensions. Defaults to every extension the adapters support. */
	extension?: string | string[];
}

export interface BlokInertiaProxyOptions {
	/** Blok server to proxy to. Defaults to `BLOK_URL` or `http://localhost:4000`. */
	target?: string;
	/** Requests Vite must serve itself. Defaults to Vite internals and asset-shaped paths. */
	exclude?: RegExp;
}

export interface BlokInertiaOptions extends InertiaPluginOptions {
	/**
	 * Dev proxy to the Blok server. `false` turns it off (standalone mode,
	 * where the SPA talks to Blok cross-origin instead — see the README).
	 */
	proxy?: boolean | BlokInertiaProxyOptions;
	/** Where to find page components, for the `pages.json` manifest. */
	pages?: string | BlokInertiaPagesOptions;
	/**
	 * URL the Blok server should POST pages to for production SSR. Defaults to
	 * `http://127.0.0.1:<ssr.port ?? 13714>/render`.
	 */
	ssrUrl?: string;
}

function sha256(input: string | Buffer): string {
	return createHash("sha256").update(input).digest("hex");
}

function proxyOptions(options: BlokInertiaOptions): BlokInertiaProxyOptions | null {
	if (options.proxy === false) return null;
	return options.proxy === true || options.proxy === undefined ? {} : options.proxy;
}

function blokUrlOf(proxy: BlokInertiaProxyOptions): string {
	return proxy.target ?? process.env.BLOK_URL ?? "http://localhost:4000";
}

/** Production SSR URL, honouring an explicit override or a custom `ssr.port`. */
function productionSsrUrl(options: BlokInertiaOptions): string {
	if (options.ssrUrl !== undefined) return options.ssrUrl;
	const port = typeof options.ssr === "object" && options.ssr.port !== undefined ? options.ssr.port : SSR_DEFAULT_PORT;
	return `http://127.0.0.1:${port}/render`;
}

/**
 * Whether SSR is actually on, using the same entry resolution as
 * `@inertiajs/vite` — writing an SSR URL for a project without an SSR entry
 * would point the Blok server at an endpoint that is not mounted.
 */
function ssrEnabled(options: BlokInertiaOptions, root: string): boolean {
	if (options.ssr === false) return false;
	if (typeof options.ssr === "string") return existsSync(resolve(root, options.ssr));
	if (typeof options.ssr === "object" && options.ssr.entry !== undefined) {
		return existsSync(resolve(root, options.ssr.entry));
	}
	return SSR_ENTRY_CANDIDATES.some((candidate) =>
		SSR_ENTRY_EXTENSIONS.some((extension) => existsSync(resolve(root, candidate + extension))),
	);
}

function pageExtensions(options: BlokInertiaOptions): string[] {
	const pages = typeof options.pages === "string" ? { path: options.pages } : (options.pages ?? {});
	if (pages.extension === undefined) return PAGE_EXTENSIONS;
	return Array.isArray(pages.extension) ? pages.extension : [pages.extension];
}

function pageDir(options: BlokInertiaOptions, root: string): string | null {
	const pages = typeof options.pages === "string" ? { path: options.pages } : (options.pages ?? {});
	if (pages.path !== undefined) {
		const explicit = resolve(root, pages.path);
		return existsSync(explicit) ? explicit : null;
	}
	for (const candidate of PAGE_DIR_CANDIDATES) {
		const dir = resolve(root, candidate);
		if (existsSync(dir)) return dir;
	}
	return null;
}

/**
 * Inertia component names under the page directory. This is a manifest for the
 * server, not a second page resolver — resolution stays in `@inertiajs/vite`.
 */
function discoverPages(dir: string, extensions: string[]): string[] {
	const names = new Set<string>();
	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const extension = extensions.find((candidate) => entry.name.endsWith(candidate));
		if (extension === undefined) continue;
		// `parentPath` is absolute; the component name is the path below `dir`,
		// always with forward slashes, which is how Inertia names components.
		const parent = entry.parentPath.slice(dir.length).replace(/\\/g, "/").replace(/^\//, "");
		const base = entry.name.slice(0, -extension.length);
		names.add(parent === "" ? base : `${parent}/${base}`);
	}
	return [...names].sort();
}

function writePagesManifest(options: BlokInertiaOptions, root: string, outDir: string): void {
	const dir = pageDir(options, root);
	const manifest = {
		root: dir === null ? null : dir.slice(root.length).replace(/\\/g, "/").replace(/^\//, ""),
		pages: dir === null ? [] : discoverPages(dir, pageExtensions(options)),
	};
	writeFileSync(join(outDir, PAGES_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

// =============================================================================
// #1051 — the asset descriptor the HTML shell is built from
// =============================================================================

/** The first `<script type="module" src>` of an HTML entry, in either attribute order. */
const MODULE_SCRIPT = /<script\b(?=[^>]*\btype=["']module["'])[^>]*\bsrc=["']([^"']+)["']/i;

/** Path below `root`, with forward slashes and no leading slash. */
function underRoot(root: string, path: string): string {
	return resolve(root, path).slice(resolve(root).length).replace(/\\/g, "/").replace(/^\//, "");
}

interface EntryInfo {
	/** What the DEV server serves, e.g. `src/main.tsx`. */
	dev: string;
	/** What the build manifest is keyed by — the HTML file when there is one. */
	key: string;
}

/**
 * The app entry, in the issue's order: `build.rollupOptions.input`, else
 * `index.html`'s module script. `null` when neither exists.
 *
 * The two spellings differ on purpose. Vite's manifest keys an HTML input by
 * the HTML file (whose `file` is already the hashed JS chunk), while the dev
 * server only knows the module script inside it.
 */
function entryInfo(config: ResolvedConfig): EntryInfo | null {
	const input = config.build.rollupOptions?.input;
	const declared =
		typeof input === "string" ? [input] : Array.isArray(input) ? [...input] : input ? Object.values(input) : [];
	const first = declared[0] ?? "index.html";
	const entry = resolve(config.root, first);
	const key = underRoot(config.root, entry);
	if (!entry.endsWith(".html")) return { dev: key, key };
	if (!existsSync(entry)) return null;
	const src = MODULE_SCRIPT.exec(readFileSync(entry, "utf8"))?.[1];
	if (src === undefined) return null;
	// `/src/main.tsx` is root-relative; `./src/main.tsx` is relative to the HTML.
	return { dev: src.startsWith("/") ? src.slice(1) : underRoot(config.root, join(entry, "..", src)), key };
}

/**
 * Which adapter is in play, read off the plugin list rather than guessed from
 * file extensions — `@vitejs/plugin-react` and `@vitejs/plugin-react-swc` both
 * announce themselves as `vite:react-*`, and only they need the preamble.
 */
function frameworkOf(config: ResolvedConfig): BlokViteFramework {
	for (const plugin of config.plugins) {
		if (plugin.name.startsWith("vite:react")) return "react";
		if (plugin.name.startsWith("vite:vue")) return "vue";
		if (plugin.name.startsWith("vite-plugin-svelte")) return "svelte";
	}
	return null;
}

interface ManifestChunk {
	file: string;
	isEntry?: boolean;
	css?: string[];
	imports?: string[];
}

/**
 * Resolve the manifest into the exact tag list. CSS and static imports are
 * collected transitively: a shared chunk's stylesheet is as necessary as the
 * entry's own, and a preload for it is what keeps the waterfall one round trip.
 */
function buildDescriptor(
	manifest: Record<string, ManifestChunk>,
	entry: EntryInfo | null,
): BlokViteBuildDescriptor | null {
	// An entry whose emitted file is JavaScript: that is what a `<script>` can
	// load. (For an HTML input Vite already reports the hashed JS chunk here.)
	const entries = Object.keys(manifest).filter(
		(name) => manifest[name]?.isEntry === true && manifest[name].file.endsWith(".js"),
	);
	const key = [entry?.key, entry?.dev].find((name) => name !== undefined && entries.includes(name)) ?? entries[0];
	if (key === undefined) return null;

	const css = new Set<string>();
	const imports = new Set<string>();
	const seen = new Set<string>();
	const collect = (name: string): void => {
		if (seen.has(name)) return;
		seen.add(name);
		const chunk = manifest[name];
		if (chunk === undefined) return;
		for (const file of chunk.css ?? []) css.add(file);
		for (const dep of chunk.imports ?? []) {
			const file = manifest[dep]?.file;
			if (file !== undefined) imports.add(file);
			collect(dep);
		}
	};
	collect(key);

	return { mode: "build", entry: manifest[key].file, css: [...css], imports: [...imports], framework: null };
}

function writeDescriptor(outDir: string, descriptor: BlokViteDescriptor): void {
	writeFileSync(join(outDir, VITE_DESCRIPTOR_FILE), `${JSON.stringify(descriptor, null, 2)}\n`);
}

/** Every file under `dir`, absolute. */
function walk(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

function blokPlugin(options: BlokInertiaOptions): Plugin {
	const proxy = proxyOptions(options);
	let config: ResolvedConfig;

	return {
		name: "blok:inertia",
		// After @inertiajs/vite and after Vite's own manifest plugin, so
		// `writeBundle` sees a bundle that is already fully on disk.
		enforce: "post",

		config(userConfig, env) {
			const dev = env.command === "serve";
			const root = resolve(userConfig.root ?? process.cwd());
			const devPort = userConfig.server?.port ?? 5173;
			const ssrUrl = !ssrEnabled(options, root)
				? ""
				: dev
					? `http://localhost:${devPort}${SSR_DEV_ENDPOINT}`
					: productionSsrUrl(options);

			return {
				// The asset version is a hash of this file; without it there is
				// nothing to hash and nothing for the server to read.
				build: { manifest: true },
				define: {
					"import.meta.env.BLOK_ASSET_VERSION": JSON.stringify(dev ? DEV_ASSET_VERSION : ASSET_VERSION_PLACEHOLDER),
					"import.meta.env.BLOK_SSR_URL": JSON.stringify(ssrUrl),
				},
				...(proxy === null
					? {}
					: {
							server: {
								proxy: {
									"^/": {
										target: blokUrlOf(proxy),
										changeOrigin: true,
										// Dev has no real asset version, so pin the one
										// the server also uses in dev. Without it every
										// dev visit 409s on a version mismatch.
										headers: { "X-Inertia-Version": DEV_ASSET_VERSION },
										bypass: (req: { url?: string }) => {
											const url = req.url ?? "/";
											return (proxy.exclude ?? VITE_OWNED).test(url) ? url : undefined;
										},
									},
								},
							},
						}),
			};
		},

		configResolved(resolved) {
			config = resolved;
		},

		configureServer(server) {
			server.httpServer?.once("listening", () => {
				const root = config.root;
				const outDir = resolve(root, config.build.outDir);
				mkdirSync(outDir, { recursive: true });
				writeFileSync(join(outDir, ASSET_VERSION_FILE), DEV_ASSET_VERSION);
				const address = server.httpServer?.address();
				const port = typeof address === "object" && address !== null ? address.port : config.server.port;
				writeFileSync(
					join(outDir, SSR_URL_FILE),
					ssrEnabled(options, root) ? `http://localhost:${port}${SSR_DEV_ENDPOINT}` : "",
				);
				writePagesManifest(options, root, outDir);

				// #1051 — Laravel's `public/hot`. The shell points the browser at
				// THIS dev server, so the file must die with it: a stale dev
				// descriptor would make a later production boot emit tags for a
				// port nobody is listening on.
				const entry = entryInfo(config);
				if (entry === null) {
					config.logger.warn(
						`blokInertia(): no app entry found (no build.rollupOptions.input and no <script type="module" src> in ${join(root, "index.html")}), so ${VITE_DESCRIPTOR_FILE} was not written and the Blok shell will not load the client.`,
					);
					return;
				}
				writeDescriptor(outDir, {
					mode: "dev",
					devUrl: `http://localhost:${port}`,
					entry: entry.dev,
					framework: frameworkOf(config),
				});
				server.httpServer?.once("close", () => {
					rmSync(join(outDir, VITE_DESCRIPTOR_FILE), { force: true });
				});
			});
		},

		writeBundle() {
			// The SSR bundle is a second output into a different directory; the
			// asset version belongs to the client build only.
			if (config.build.ssr) return;

			const outDir = resolve(config.root, config.build.outDir);
			const manifest = join(outDir, ".vite", "manifest.json");
			if (!existsSync(manifest)) {
				throw new Error(
					`blokInertia(): expected a Vite manifest at ${manifest}. Fix: leave build.manifest enabled — the Blok asset version is a hash of it.`,
				);
			}

			const version = sha256(readFileSync(manifest));
			writeFileSync(join(outDir, ASSET_VERSION_FILE), version);

			// #1051 — the tags the Blok shell emits. Written from the manifest,
			// so the hashed filenames the server serves and the ones the browser
			// asks for can never drift apart.
			const descriptor = buildDescriptor(
				JSON.parse(readFileSync(manifest, "utf8")) as Record<string, ManifestChunk>,
				entryInfo(config),
			);
			if (descriptor === null) {
				config.logger.warn(
					`blokInertia(): the Vite manifest has no JavaScript entry chunk, so ${VITE_DESCRIPTOR_FILE} was not written and the Blok shell will not load the client.`,
				);
			} else {
				writeDescriptor(outDir, { ...descriptor, framework: frameworkOf(config) });
			}

			writeFileSync(join(outDir, SSR_URL_FILE), ssrEnabled(options, config.root) ? productionSsrUrl(options) : "");
			writePagesManifest(options, config.root, outDir);

			for (const file of walk(outDir)) {
				if (!REWRITABLE.test(file)) continue;
				const text = readFileSync(file, "utf8");
				if (!text.includes(ASSET_VERSION_PLACEHOLDER)) continue;
				writeFileSync(file, text.split(ASSET_VERSION_PLACEHOLDER).join(version));
			}
		},
	};
}

/**
 * The official `@inertiajs/vite` plugin plus Blok's build glue.
 *
 * ```ts
 * // vite.config.ts
 * import { blokInertia } from "@blokjs/inertia-client/vite";
 * import react from "@vitejs/plugin-react";
 *
 * export default defineConfig({ plugins: [react(), blokInertia()] });
 * ```
 *
 * Every `@inertiajs/vite` option (`ssr`, `frameworks`) is passed through.
 */
export function blokInertia(options: BlokInertiaOptions = {}): Plugin[] {
	const { proxy: _proxy, pages: _pages, ssrUrl: _ssrUrl, ...inertiaOptions } = options;
	return [inertia(inertiaOptions), blokPlugin(options)];
}

export default blokInertia;
