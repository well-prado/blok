/**
 * Routing and naming knobs (#1015): `inertia.page()`, `resolveUrlUsing()`,
 * `transformComponentUsing()` and the boot-time `ensurePagesExist()` check.
 *
 * All three overrides are adapter-wide, set once at boot next to
 * `configureHistory()` — they describe how THIS app spells URLs and component
 * names, which is not a per-page decision.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { http, node, step, workflow } from "@blokjs/core";
import { getPageRegistry } from "./define-page.js";

// =============================================================================
// url / component overrides
// =============================================================================

/** Build the page-object `url` from the request. Return a relative URL (no scheme/host). */
export type UrlResolver = (req: unknown) => string;
/** Rewrite a component name on its way to the client (and to the existence check). */
export type ComponentTransform = (name: string) => string;

let urlResolver: UrlResolver | undefined;
let componentTransform: ComponentTransform | undefined;

/**
 * Override the page object's `url` (default: request path + query, no
 * scheme/host).
 *
 * ```ts
 * resolveUrlUsing((req) => new URL(String((req as Request).url)).pathname);
 * ```
 */
export function resolveUrlUsing(resolver: UrlResolver | null): void {
	urlResolver = resolver ?? undefined;
}

/**
 * Rewrite every component name server-side — applied BEFORE the name is
 * emitted and before {@link ensurePagesExist} checks it, so both sides agree.
 *
 * ```ts
 * transformComponentUsing((name) => name.toLowerCase());
 * ```
 */
export function transformComponentUsing(transform: ComponentTransform | null): void {
	componentTransform = transform ?? undefined;
}

/** The configured component name for `name`, or `name` itself. */
export function transformComponent(name: string): string {
	return componentTransform ? componentTransform(name) : name;
}

/** The configured `url` for this request, or `undefined` to keep the default. */
export function resolveUrl(req: unknown): string | undefined {
	if (!urlResolver) return undefined;
	const url = urlResolver(req);
	return typeof url === "string" ? url : undefined;
}

// =============================================================================
// ensurePagesExist
// =============================================================================

/** The `pages.json` manifest the Blok Vite plugin writes into its `outDir` (#997). */
interface PagesManifest {
	root: string | null;
	pages: string[];
}

export interface EnsurePagesExistOptions {
	/**
	 * Run the check. Default: on everywhere except `NODE_ENV=production` — a
	 * deployed server should not refuse to boot over a stale manifest.
	 */
	enabled?: boolean;
	/** Path to `pages.json`. Default: `<dir>/pages.json`. */
	manifest?: string;
	/** Client build directory holding `pages.json`. Default `BLOK_STATIC_DIR`, else `client/dist`. */
	dir?: string;
	/** Where to report a missing manifest. Default `console.warn`. */
	warn?: (message: string) => void;
}

function manifestPath(options: EnsurePagesExistOptions): string {
	if (options.manifest !== undefined) return options.manifest;
	const dir = options.dir ?? process.env.BLOK_STATIC_DIR ?? "client/dist";
	return join(isAbsolute(dir) ? dir : join(process.cwd(), dir), "pages.json");
}

function readManifest(path: string): PagesManifest | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PagesManifest>;
		return { root: typeof parsed.root === "string" ? parsed.root : null, pages: parsed.pages ?? [] };
	} catch {
		return null;
	}
}

/**
 * Verify at boot that every component the server declares actually exists in
 * the client's pages directory, so a typo fails on startup instead of as a
 * blank screen on the one route nobody clicked before the deploy.
 *
 * ```ts
 * await ensurePagesExist();            // dev: on. production: skipped.
 * ```
 *
 * A MISSING manifest is a warning, not a failure: the server boots before the
 * client is built at least once, and refusing to start then would make the
 * order of two independent builds load-bearing.
 *
 * @throws when a declared component is absent from the manifest.
 */
export async function ensurePagesExist(options: EnsurePagesExistOptions = {}): Promise<void> {
	const enabled = options.enabled ?? process.env.NODE_ENV !== "production";
	if (!enabled) return;

	const path = manifestPath(options);
	const manifest = readManifest(path);
	if (!manifest) {
		(options.warn ?? console.warn)(
			`[blok] @blokjs/inertia: ensurePagesExist found no page manifest at ${path}, so no component names were checked. Fix: build the client once (the Blok Vite plugin writes pages.json into its outDir), or pass { manifest } / set BLOK_STATIC_DIR.`,
		);
		return;
	}

	const known = new Set(manifest.pages);
	const declared = new Map<string, string | undefined>();
	for (const entry of getPageRegistry().values()) {
		const component = transformComponent(entry.component);
		declared.set(component, entry.source ? `${entry.source.file}:${entry.source.line}` : undefined);
	}
	for (const component of routeComponents) declared.set(transformComponent(component), undefined);

	const missing = [...declared.entries()].filter(([component]) => !known.has(component));
	if (missing.length === 0) return;

	const where = manifest.root ?? "the client pages directory";
	const list = missing.map(([component, at]) => `  - ${component}${at ? ` (declared at ${at})` : ""}`).join("\n");
	throw new Error(
		`[blok] @blokjs/inertia: ${missing.length} page component(s) declared server-side do not exist in ${where}:\n${list}\n` +
			`Fix: create the missing file(s) under ${where}, or correct the component name passed to definePage()/inertia.page(). Checked against ${path}.`,
	);
}

// =============================================================================
// inertia.page — the controller-less route
// =============================================================================

/** Components named by a controller-less route, so `ensurePagesExist` covers them too. */
const routeComponents = new Set<string>();

export interface InertiaRouteOptions {
	/** Workflow name — what `Workflows.ts` and `middleware` lists address. Default: the component name. */
	name?: string;
	/** Middleware chain for this route. */
	middleware?: string[];
	/** Extra serializer inputs carried verbatim (`version`, `viewData`, `shell`, `head`, `rootId`, …). */
	inputs?: Record<string, unknown>;
}

/**
 * A route with no controller — Laravel's `Route::inertia()`.
 *
 * ```ts
 * // src/Workflows.ts
 * export default { about: await inertia.page("/about", "About", { team: "Blok" }) };
 * ```
 *
 * ponytail: ONE step, the serializer itself, rather than the `page` control
 * step — a controller-less route declares no prop NODES, so the control step
 * would only lazily resolve an empty set. Shared data, `resolveUrlUsing` and
 * `transformComponentUsing` all live in the serializer, so this route gets them
 * exactly like a `definePage().render()` one. Upgrade path if these routes ever
 * need lazy props: give the third argument prop specs and emit `page()`.
 */
export function inertiaPage(
	path: string,
	component: string,
	props: Record<string, unknown> = {},
	opts: InertiaRouteOptions = {},
) {
	if (typeof path !== "string" || !path.startsWith("/")) {
		throw new Error(`inertia.page() requires a route path starting with "/", got ${JSON.stringify(path)}.`);
	}
	if (typeof component !== "string" || component.length === 0) {
		throw new Error(`inertia.page("${path}") requires a non-empty component name.`);
	}
	routeComponents.add(component);
	return workflow(
		opts.name ?? component,
		{
			version: "1.0.0",
			trigger: http.get(path, opts.middleware ? { middleware: opts.middleware } : {}),
		},
		() => {
			step("page", node("@blokjs/inertia"), { ...opts.inputs, component, url: path, props });
		},
	);
}

/** The `inertia.*` route helpers. `inertia.page(path, component, props?)`. */
export const inertia = { page: inertiaPage } as const;

/** Drop the controller-less route names AND both adapter overrides. Test-only. */
export function _resetRoutes(): void {
	routeComponents.clear();
	urlResolver = undefined;
	componentTransform = undefined;
}
