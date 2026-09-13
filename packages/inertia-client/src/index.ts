/**
 * `@blokjs/inertia-client` — the framework-agnostic half of Blok's Inertia
 * integration (#997).
 *
 * It deliberately contains **no** React/Vue/Svelte code: the stock
 * `@inertiajs/react|vue3|svelte` adapters already own rendering. What a Blok
 * SPA is missing is the typing and the build glue, which is all that lives
 * here:
 *
 * - `Pages` / `Routes` — empty interfaces augmented by the generated
 *   `blok-pages.d.ts` / `blok-routes.d.ts` (#998), or by hand.
 * - `PageProps<K>` / `PagePropsOf<T>` — page props as a component sees them,
 *   merged with Inertia's own `InertiaConfig["sharedPageProps"]`.
 * - `route()` — a typed URL builder that returns a Wayfinder-shaped
 *   `{ url, method, component? }` object, directly usable as a `<Link href>`,
 *   a `<Form action>` or a `router.visit(...)` argument.
 *
 * The Vite plugin lives in the `@blokjs/inertia-client/vite` subpath so that
 * nothing in an app bundle ever pulls `vite` in.
 */
import type { ErrorValue, Method, SharedPageProps } from "@inertiajs/core";

declare global {
	/**
	 * Populated by the `blokInertia()` Vite plugin. The `vite/client` types
	 * (or any other `ImportMetaEnv` declaration) supply `import.meta.env`
	 * itself; this only adds Blok's two keys to it.
	 */
	interface ImportMetaEnv {
		/**
		 * The asset version the client was built with — sha256 of the Vite
		 * manifest, or `"dev"` while the Vite dev server is running. The Blok
		 * server sends the same value as `X-Inertia-Version`.
		 */
		readonly BLOK_ASSET_VERSION: string;
		/** URL of the Inertia SSR render endpoint, or `""` when SSR is off. */
		readonly BLOK_SSR_URL: string;
	}
}

/**
 * Every Inertia page component in the project, keyed by its Inertia component
 * name. Augmented by the generated `blok-pages.d.ts`:
 *
 * ```ts
 * declare module "@blokjs/inertia-client" {
 *   interface Pages {
 *     "Orders/Index": { orders: { id: string; total: number }[] };
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: this is the augmentation target — a type alias cannot be module-augmented.
export interface Pages {}

/**
 * Every named route the Blok server exposes. Augmented by the generated
 * `blok-routes.d.ts`:
 *
 * ```ts
 * declare module "@blokjs/inertia-client" {
 *   interface Routes {
 *     "orders.show": { params: { id: string }; method: "get"; component: "Orders/Show" };
 *   }
 * }
 * ```
 *
 * The type side only describes the call signature. The URL patterns
 * themselves arrive at runtime through {@link registerRoutes}.
 */
// biome-ignore lint/suspicious/noEmptyInterface: this is the augmentation target — a type alias cannot be module-augmented.
export interface Routes {}

/** Inertia component name of a known page. */
export type PageName = Extract<keyof Pages, string>;

/** Name of a known route. */
export type RouteName = Extract<keyof Routes, string>;

/**
 * Validation errors as Inertia hands them to a page. The value type follows
 * `InertiaConfig["errorValueType"]`, so a project that declares
 * `errorValueType: string[]` gets `string[]` here too.
 */
export type PageErrors = Record<string, ErrorValue>;

/**
 * Props of a page component: its own props, plus the app-wide shared props
 * declared on Inertia's `InertiaConfig["sharedPageProps"]`, plus `errors`.
 *
 * ```ts
 * export default function Index(props: PageProps<"Orders/Index">) { … }
 * ```
 */
export type PageProps<K extends PageName> = Pages[K] & SharedPageProps & { errors: PageErrors };

/**
 * The same thing, reached through a value rather than a page name — the
 * monorepo path, where the workflow's `definePage` export carries its prop
 * type on a phantom `__props` field.
 *
 * ```ts
 * import type ordersIndex from "../../workflows/orders-index";
 * export default function Index(props: PagePropsOf<typeof ordersIndex>) { … }
 * ```
 */
export type PagePropsOf<T extends { __props: unknown }> = T["__props"] &
	SharedPageProps & {
		errors: PageErrors;
	};

/**
 * HTTP method as written either way round. Blok workflows declare
 * `method: "GET"`; Inertia's own `Method` union is lowercase. Both are
 * accepted here and normalised to Inertia's form by {@link route}.
 */
export type RouteMethod = Method | Uppercase<Method>;

/** One runtime route entry, as handed to {@link registerRoutes}. */
export interface RouteEntry {
	/** URL pattern with `:name` placeholders, e.g. `/orders/:id`. */
	url: string;
	/** Defaults to `"get"`. */
	method?: RouteMethod;
	/** Page component rendered by this route, when the workflow has a `definePage`. */
	component?: string;
}

/**
 * A Wayfinder-shaped route object. Structurally an Inertia `UrlMethodPair`,
 * so it can be passed straight to `<Link href>`, `<Form action>`,
 * `router.visit()` and `useForm()` — the client infers the method from it.
 */
export interface BlokRoute {
	readonly url: string;
	readonly method: Method;
	/** Set when the route's workflow declares a page, enabling instant visits. */
	readonly component?: string;
	/** Attach (or override) the page component for an instant visit. */
	withComponent(component: string): BlokRoute;
	/** The URL, so a route object interpolates into a template string. */
	toString(): string;
}

/** Params accepted by a route. `never` when the route takes none. */
export type RouteParams<N extends RouteName> = Routes[N] extends { params: infer P } ? P : never;

/**
 * `route(name)` for a route with no params, `route(name, params)` for one
 * with params — enforced at the call site rather than by an optional argument.
 */
export type RouteArgs<N extends RouteName> = [RouteParams<N>] extends [never]
	? [params?: undefined]
	: [params: RouteParams<N>];

const routes = new Map<string, RouteEntry>();

/**
 * Register the runtime route table. The generated `blok-routes` module calls
 * this once at boot; tests and hand-written setups call it directly.
 *
 * Registering the same name twice replaces the earlier entry.
 */
export function registerRoutes(table: Record<string, RouteEntry>): void {
	for (const [name, entry] of Object.entries(table)) routes.set(name, entry);
}

/** Drop every registered route. Mostly useful to isolate tests. */
export function clearRoutes(): void {
	routes.clear();
}

const PARAM = /:([A-Za-z_][A-Za-z0-9_]*)/g;

function makeRoute(url: string, method: Method, component: string | undefined): BlokRoute {
	return {
		url,
		method,
		...(component === undefined ? {} : { component }),
		withComponent: (next: string) => makeRoute(url, method, next),
		toString: () => url,
	};
}

/**
 * Build a route object from a registered name.
 *
 * ```ts
 * route("orders.show", { id: "1" });   // { url: "/orders/1", method: "get", component: "Orders/Show" }
 * route("orders.index").url;           // "/orders"
 * route("orders.show", { id }).withComponent("Orders/Show");
 * ```
 *
 * Params not consumed by the pattern become query-string entries. A pattern
 * placeholder with no matching param throws, naming the parameter — silently
 * emitting `/orders/undefined` is the failure mode this exists to prevent.
 */
export function route<N extends RouteName>(name: N, ...args: RouteArgs<N>): BlokRoute {
	const entry = routes.get(name);
	if (entry === undefined) {
		throw new Error(`route("${name}") is not registered. Call registerRoutes() with the generated route table first.`);
	}
	const params = (args[0] ?? {}) as Record<string, unknown>;
	const used = new Set<string>();
	const path = entry.url.replace(PARAM, (_match, key: string) => {
		const value = params[key];
		if (value === undefined || value === null || value === "") {
			throw new Error(`route("${name}") is missing the required parameter "${key}".`);
		}
		used.add(key);
		return encodeURIComponent(String(value));
	});

	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (used.has(key) || value === undefined || value === null) continue;
		query.append(key, String(value));
	}
	const search = query.toString();
	const method = (entry.method ?? "get").toLowerCase() as Method;
	return makeRoute(search === "" ? path : `${path}?${search}`, method, entry.component);
}
