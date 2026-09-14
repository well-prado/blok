/**
 * The shared-data registry (#1015) — data every page gets, declared once.
 *
 * ```ts
 * share("appName", "Blok");                          // static
 * share("auth", (req) => currentUser(req));          // lazy, per request
 * share("ziggy", buildRoutes, { always: true });     // survives every partial filter
 * shareOnce("countries", loadCountries, { until: "1d" }); // client caches it
 * ```
 *
 * ## Where the values are resolved
 *
 * NOT here, and not in the `page` control step: the **serializer** (`@blokjs/inertia`
 * itself) resolves the selected entries as it builds the page object. That is
 * the one place that sees every response — a `page` step's, a hand-written
 * `step("render", …)`'s and `inertia.page()`'s alike — and the place that
 * already owns `sharedProps` / `exposeSharedPropKeys` on the wire.
 *
 * This splits cleanly from the `inertia.shared` MIDDLEWARE (#996), which stays
 * exactly what it was: two real workflow steps (`auth`, `flash`) whose outputs
 * land in `ctx.state` for `shared(currentUser, "auth")` to read. The middleware
 * gives you a typed handle a page prop can consume; the registry gives you a
 * value on EVERY page with no wiring at all. Use the middleware when a prop
 * needs the value as an input, the registry when the client needs it as a prop.
 *
 * ## Selection
 *
 * A shared entry is an extra prop as far as the request is concerned, so it
 * follows the same table the `page` step applies to declared props:
 *
 * - full visit — `regular` and `always` resolve; `once` resolves unless the
 *   client says it still holds the cached copy (`X-Inertia-Except-Once-Props`).
 * - partial reload OF THIS COMPONENT — `only` narrows (by top-level key), then
 *   `except` removes; `always` is exempt from both; `once` resolves only when
 *   named in `only`.
 * - a key the PAGE also declares is never resolved at all: the page wins.
 *
 * Lazy values therefore cost nothing on a request that did not select them.
 */

import { headerList } from "./protocol.js";

// =============================================================================
// Types
// =============================================================================

/** A lazy shared value: called with `ctx.request`, once per request, only when selected. */
export type SharedResolver = (req: unknown) => unknown;

/**
 * A node value (`defineNode`) used as a shared value's source. Only the
 * in-process node ABI is supported — a cross-language `runtimeNode()` stub has
 * no in-process `handle`, so pass a resolver function for those.
 */
export interface SharedNode {
	readonly name: string;
	handle?(ctx: unknown, inputs: unknown): Promise<{ success?: boolean; data?: unknown; error?: unknown }>;
}

/** How a shared entry is selected, mirroring the page-prop modes of the same name. */
export type SharedMode = "regular" | "always" | "once";

/** Options for {@link share}. */
export interface ShareOptions {
	/** `true` exempts the entry from every partial-reload `only`/`except` filter. */
	always?: boolean;
}

/** Options for {@link shareOnce} — the client-side one-shot cache (#1009 semantics). */
export interface ShareOnceOptions {
	/** Cache key. Defaults to the shared key. */
	as?: string;
	/** Lifetime — a duration (`"1d"`), a number of SECONDS, or an absolute date. */
	until?: string | number | Date;
}

interface SharedEntry {
	key: string;
	mode: SharedMode;
	/** Present for a STATIC value; `resolver`/`node` are then absent. */
	value?: unknown;
	resolver?: SharedResolver;
	node?: SharedNode;
	once?: ShareOnceOptions;
}

const registry = new Map<string, SharedEntry>();

/**
 * Resolved values, per request. Keyed by the request OBJECT (`ctx.request`),
 * which every child ctx the runner builds carries by reference — so a prop
 * step's `getShared()` and the serializer's own resolution share one result and
 * a lazy value runs exactly once per request.
 */
const perRequest = new WeakMap<object, Map<string, unknown>>();

// =============================================================================
// Registration
// =============================================================================

function assertKey(fn: string, key: string): void {
	if (typeof key !== "string" || key.length === 0) {
		throw new Error(`${fn}() requires a non-empty key. Fix: ${fn}("auth", value).`);
	}
	// Same reason the page step rejects a dotted prop key: partial reloads and
	// `sharedProps` address TOP-LEVEL keys, so `auth.user` would be read as a
	// path into a sibling prop.
	if (key.includes(".")) {
		throw new Error(
			`${fn}("${key}") — shared keys are top-level prop keys and cannot contain a dot. Fix: namespace by sharing an OBJECT instead: ${fn}("${key.split(".")[0]}", { ${key.split(".").slice(1).join(".")}: … }).`,
		);
	}
}

/**
 * Share a value with every page.
 *
 * A function is LAZY: it is called with `ctx.request` once per request, and
 * only on a request that actually selects the key.
 */
export function share(key: string, value: unknown, options: ShareOptions = {}): void {
	assertKey("share", key);
	const mode: SharedMode = options.always === true ? "always" : "regular";
	registry.set(
		key,
		typeof value === "function"
			? { key, mode, resolver: value as SharedResolver }
			: { key, mode, value: value as unknown },
	);
}

/**
 * Share a value the CLIENT caches and stops asking for — the shared-data
 * counterpart of `once()` (#1009). The value resolves on the first visit; on
 * later visits the client sends `X-Inertia-Except-Once-Props` and the source is
 * never invoked, while the page object keeps the `onceProps` entry that tells
 * the client its copy is still good.
 *
 * `source` is a node value (`defineNode`) or a lazy resolver.
 */
export function shareOnce(key: string, source: SharedNode | SharedResolver, options: ShareOnceOptions = {}): void {
	assertKey("shareOnce", key);
	const entry: SharedEntry = { key, mode: "once", once: { ...options } };
	if (typeof source === "function") entry.resolver = source as SharedResolver;
	else if (source && typeof source.name === "string" && source.name.length > 0) entry.node = source;
	else
		throw new Error(`shareOnce("${key}") needs a source. Fix: pass a defineNode() value or a (req) => value function.`);
	registry.set(key, entry);
}

/** Every registered shared key, in registration order. */
export function sharedKeys(): string[] {
	return [...registry.keys()];
}

/** Drop every shared entry. Test-only — a fresh module graph re-registers. */
export function _resetShared(): void {
	registry.clear();
}

// =============================================================================
// Reading
// =============================================================================

/**
 * Read a shared value while resolving a page — for a prop resolver that needs
 * data another `share()` already declared.
 *
 * Pass the node's `ctx` so a LAZY entry can resolve (and be cached for the rest
 * of this request); without it only statically-shared values are readable and
 * everything else yields `fallback`.
 *
 * ```ts
 * const tenant = await getShared("tenant", null, ctx);
 * ```
 */
export async function getShared<T = unknown>(key: string, fallback?: T, ctx?: unknown): Promise<T> {
	const entry = registry.get(key);
	if (!entry) return fallback as T;
	if (isStatic(entry)) return entry.value as T;
	if (ctx === undefined) return fallback as T;
	return (await resolveEntry(entry, ctx)) as T;
}

// =============================================================================
// Resolution (the serializer's entry point)
// =============================================================================

function requestOf(ctx: unknown): unknown {
	return (ctx as { request?: unknown } | undefined)?.request;
}

/** The per-request memo table, created on first use. `undefined` when there is no request object. */
function memo(ctx: unknown): Map<string, unknown> | undefined {
	const request = requestOf(ctx);
	if (request === null || typeof request !== "object") return undefined;
	let table = perRequest.get(request as object);
	if (!table) {
		table = new Map<string, unknown>();
		perRequest.set(request as object, table);
	}
	return table;
}

/** A statically-shared value — nothing to run, readable without a request. */
function isStatic(entry: SharedEntry): boolean {
	return entry.resolver === undefined && entry.node === undefined;
}

async function resolveEntry(entry: SharedEntry, ctx: unknown): Promise<unknown> {
	if (isStatic(entry)) return entry.value;
	const table = memo(ctx);
	if (table?.has(entry.key)) return table.get(entry.key);

	let value: unknown;
	if (entry.resolver) {
		value = await entry.resolver(requestOf(ctx));
	} else if (entry.node) {
		value = await runSharedNode(entry.node, ctx);
	}
	table?.set(entry.key, value);
	return value;
}

/**
 * Run a node-backed shared value.
 *
 * `handle()` is the node's own validate → execute → validate path, so Zod still
 * applies. ponytail: this deliberately does NOT go through `Runner` — a shared
 * value is not a workflow step, has no id, and would otherwise need a synthetic
 * step record just to get per-prop `retry`/tracing it never declared. Upgrade
 * path if shared values ever need those knobs: give them real prop steps.
 */
async function runSharedNode(node: SharedNode, ctx: unknown): Promise<unknown> {
	if (typeof node.handle !== "function") {
		throw new Error(
			`shareOnce(): node "${node.name}" has no in-process handle() — cross-runtime nodes cannot back a shared value. Fix: share a (req) => value function instead.`,
		);
	}
	const result = await node.handle(ctx, {});
	if (result?.error) throw result.error;
	return result?.data;
}

/** `1h` / `30s` / `500ms` → ms. */
const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;
const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * A shared entry's `until` → the expiry as EPOCH MILLISECONDS, or `null` when
 * it never expires.
 *
 * Milliseconds, not an ISO string, because that is what the client compares:
 * `@inertiajs/core` keeps a remembered entry while
 * `onceProp.expiresAt > Date.now()`. A string loses that comparison every time,
 * and page-prop and shared once entries land in the SAME `onceProps` map — one
 * string value would make the client forget the whole page's once props.
 *
 * ponytail: a nine-line twin of `PageNode.onceExpiry`, kept identical by hand.
 * The runner owns that one and this package cannot import it (the dependency
 * runs the other way). Upgrade path if the two ever disagree: move it to
 * `@blokjs/shared`, which both sides already depend on.
 */
function onceExpiry(until: string | number | Date | undefined): number | null {
	if (until === undefined) return null;
	if (until instanceof Date) return Number.isNaN(until.getTime()) ? null : until.getTime();
	if (typeof until === "number") return Date.now() + until * 1000;
	const match = DURATION.exec(until.trim());
	if (match) return Date.now() + Number(match[1]) * (DURATION_UNITS[match[2]] as number);
	const parsed = Date.parse(until);
	return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Has an ABSOLUTE `until` already passed? A relative duration is measured from
 * NOW, so it is never expired at emission and this is always `false` —
 * enforcing THAT deadline is the client's job (it stops listing the key).
 */
function onceExpired(until: string | number | Date | undefined): boolean {
	const expiry = onceExpiry(until);
	return expiry !== null && expiry <= Date.now();
}

/** What {@link resolveSharedProps} hands the serializer. */
export interface SharedResolution {
	/** Resolved values, to merge UNDER the page's own props. */
	values: Record<string, unknown>;
	/** Every registered top-level shared key — the page object's `sharedProps`. */
	keys: string[];
	/** Keys declared `always`, to add to `alwaysProps`. */
	alwaysKeys: string[];
	/** `onceProps` entries contributed by {@link shareOnce}. `expiresAt` is epoch ms. */
	onceProps: Record<string, { prop: string; expiresAt: number | null }>;
}

/** `posts.data` in an `only` header names the prop `posts`. */
function rootSegment(path: string): string {
	const dot = path.indexOf(".");
	return dot === -1 ? path : path.slice(0, dot);
}

/**
 * Resolve the shared entries this request selects.
 *
 * `pageProps` are the page's OWN props: a key they already carry is skipped
 * entirely, so a collision costs nothing and the page always wins.
 */
export async function resolveSharedProps(
	ctx: unknown,
	headers: Record<string, string>,
	component: string,
	pageProps: Record<string, unknown>,
): Promise<SharedResolution> {
	const resolution: SharedResolution = { values: {}, keys: [], alwaysKeys: [], onceProps: {} };
	if (registry.size === 0) return resolution;

	const partial = headers["x-inertia"] === "true" && headers["x-inertia-partial-component"] === component;
	const only = new Set(headerList(headers["x-inertia-partial-data"]).map(rootSegment));
	const except = new Set(headerList(headers["x-inertia-partial-except"]));
	const exceptOnce = new Set(headerList(headers["x-inertia-except-once-props"]));

	const selected: SharedEntry[] = [];
	for (const entry of registry.values()) {
		// The key is shared whatever happens to its value — that list is what an
		// instant visit carries to the next page.
		resolution.keys.push(entry.key);
		// A page prop of the same name owns the key completely: the shared value
		// is not resolved, and its `always`/`once` metadata would describe a value
		// that is not in this response.
		if (Object.hasOwn(pageProps, entry.key)) continue;

		if (entry.mode === "always") resolution.alwaysKeys.push(entry.key);
		// The once ENTRY is emitted even when the value is not: the client reads
		// it to learn its cached copy is still valid, and a missing entry
		// invalidates that cache.
		if (entry.mode === "once") {
			resolution.onceProps[entry.once?.as ?? entry.key] = {
				prop: entry.key,
				expiresAt: onceExpiry(entry.once?.until),
			};
		}
		if (selects(entry, { partial, only, except, exceptOnce })) selected.push(entry);
	}

	await Promise.all(
		selected.map(async (entry) => {
			resolution.values[entry.key] = await resolveEntry(entry, ctx);
		}),
	);
	return resolution;
}

interface SelectionInput {
	partial: boolean;
	only: Set<string>;
	except: Set<string>;
	exceptOnce: Set<string>;
}

function selects(entry: SharedEntry, { partial, only, except, exceptOnce }: SelectionInput): boolean {
	if (entry.mode === "always") return true;
	if (except.has(entry.key)) return false;
	// Naming a `once` entry in `only` always resolves it — an explicit request
	// outranks the client's "I still have it" claim.
	if (partial && only.size > 0) return only.has(entry.key);
	// Otherwise a `once` entry belongs to the regular set, and stays out only
	// while the client holds a LIVE copy: an absolute `until` that has already
	// passed invalidates the claim. Same rule as `PageNode.resolveOnce` (#1009).
	if (entry.mode === "once" && exceptOnce.has(entry.once?.as ?? entry.key)) {
		return onceExpired(entry.once?.until);
	}
	return true;
}
