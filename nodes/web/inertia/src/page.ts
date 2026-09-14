/**
 * Page-object assembly: resolved props + prop metadata + request headers in,
 * a v3 {@link PageObject} out. Pure — no `ctx`, no I/O — so both the node and
 * the SSR server can call it.
 */

import {
	type OnceProp,
	type PageObject,
	type ScrollProp,
	deletePath,
	getPath,
	hasPath,
	headerList,
	pickPaths,
	setPath,
} from "./protocol.js";

export interface PageMetadata {
	mergeProps?: string[];
	prependProps?: string[];
	deepMergeProps?: string[];
	matchPropsOn?: string[];
	scrollProps?: Record<string, ScrollProp>;
	deferredProps?: Record<string, string[]>;
	rescuedProps?: string[];
	sharedProps?: string[];
	onceProps?: Record<string, { prop: string; expiresAt?: number | null }>;
	flash?: Record<string, unknown>;
	encryptHistory?: boolean;
	clearHistory?: boolean;
	preserveFragment?: boolean;
	/** Props that survive every partial-reload filter (`errors` always does). */
	alwaysProps?: string[];
	/** `false` hides the shared-prop key list from the page object. */
	exposeSharedPropKeys?: boolean;
}

export interface BuildPageInput extends PageMetadata {
	component: string;
	props: Record<string, unknown>;
	url: string;
	version: string;
	errors?: Record<string, unknown>;
	/** `X-Inertia-Error-Bag`: nests `errors` under that bag name. */
	errorBag?: string;
	/** Lower-cased request headers. */
	headers: Record<string, string>;
}

/** Is this an Inertia XHR (as opposed to the first, full HTML page load)? */
export function isInertiaRequest(headers: Record<string, string>): boolean {
	return headers["x-inertia"] === "true";
}

/**
 * True when the request is a partial reload OF THIS COMPONENT. A
 * `X-Inertia-Partial-Component` naming a different component is treated as a
 * full visit — the client navigated away, so narrowed props would be wrong.
 */
export function isPartialReload(headers: Record<string, string>, component: string): boolean {
	return isInertiaRequest(headers) && headers["x-inertia-partial-component"] === component;
}

/**
 * Build the v3 page object.
 *
 * Order of operations matters: partial-reload narrowing runs first, then
 * always-props and `errors` are forced back in, then reset paths strip their
 * merge labels.
 */
export function buildPage(input: BuildPageInput): PageObject {
	const { headers, component } = input;
	const partial = isPartialReload(headers, component);
	const always = input.alwaysProps ?? [];

	const full: Record<string, unknown> = { ...input.props };
	const onceProps = normalizeOnceProps(input.onceProps);

	// `X-Inertia-Except-Once-Props` names once-props the client still holds. Not
	// RESOLVING those is the prop resolver's job (#1008) — by the time the page
	// is serialized the value is simply absent from `props`. What the node must
	// not do is drop the `onceProps` ENTRY: the client reads it to learn its
	// cached copy is still valid, and a missing entry invalidates the cache.
	// A value the server chose to resolve anyway (the entry expired, so the
	// resolver produced a fresh one) therefore ships alongside its entry.

	let props: Record<string, unknown> = full;
	if (partial) {
		const only = headerList(headers["x-inertia-partial-data"]);
		const except = headerList(headers["x-inertia-partial-except"]);
		if (only.length > 0) props = pickPaths(full, only);
		else props = { ...full };
		for (const path of except) deletePath(props, path);
		// Always-props are exempt from BOTH filters.
		for (const path of always) {
			if (hasPath(full, path)) setPath(props, path, getPath(full, path));
		}
	}

	// `errors` is always present — `{}` when the request produced none.
	props.errors = resolveErrors(input.errors, input.errorBag);

	const page: PageObject = {
		component,
		props,
		url: input.url,
		version: input.version,
	};

	if (input.encryptHistory) page.encryptHistory = true;
	if (input.clearHistory) page.clearHistory = true;
	if (input.preserveFragment) page.preserveFragment = true;

	// Merge labels ship on PARTIAL RELOADS ONLY — "full page visits will always
	// replace props entirely, even if you've marked them for merging". The rule
	// lives here rather than in the prop resolver so a hand-written serializer
	// step obeys it too.
	//
	// Reset paths come back unmerged for the same reason: the client asked for a
	// fresh copy, so it replaces them wholesale.
	const reset = headerList(headers["x-inertia-reset"]);
	const scrollProps = applyReset(input.scrollProps, reset);
	// A scroll prop is keyed by the PROP (`posts`) but labelled on its wrapper
	// path (`posts.data`), so resetting it has to reach both. `reset: ["posts"]`
	// and `reset: ["posts.data"]` therefore mean the same thing for a scroll
	// prop — which is what the client sends, depending on whether the caller
	// spelled the prop or the array inside it.
	const resetScroll = scrollResetKeys(scrollProps);
	let mergeProps = partial ? strip(input.mergeProps, reset, resetScroll) : [];
	let prependProps = partial ? strip(input.prependProps, reset, resetScroll) : [];
	const deepMergeProps = partial ? strip(input.deepMergeProps, reset, resetScroll) : [];

	// Infinite scroll tells us which end the client is growing, which decides
	// whether a scroll prop merges as an append or a prepend.
	const intent = headers["x-inertia-infinite-scroll-merge-intent"];
	if (intent === "prepend" || intent === "append") {
		const scrollPaths = new Set(Object.keys(scrollProps ?? {}));
		const [from, to] = intent === "prepend" ? [mergeProps, prependProps] : [prependProps, mergeProps];
		// A label belongs to a scroll prop when it IS the entry's key or lives
		// under it — `scrollProps.posts` owns the `posts.data` label it emitted.
		const moved = from.filter((path) => scrollPaths.has(path) || scrollPaths.has(root(path)));
		if (moved.length > 0) {
			const kept = from.filter((path) => !moved.includes(path));
			const grown = [...to, ...moved.filter((path) => !to.includes(path))];
			if (intent === "prepend") {
				mergeProps = kept;
				prependProps = grown;
			} else {
				prependProps = kept;
				mergeProps = grown;
			}
		}
	}

	if (mergeProps.length > 0) page.mergeProps = mergeProps;
	if (prependProps.length > 0) page.prependProps = prependProps;
	if (deepMergeProps.length > 0) page.deepMergeProps = deepMergeProps;
	// A match field is addressed as `<mergePath>.<field>`, so a reset path takes
	// its matching key with it — an entry naming a path nothing merges any more
	// is dead weight on the wire.
	const matchPropsOn = partial
		? (input.matchPropsOn ?? []).filter((entry) => !reset.includes(entry.split(".").slice(0, -1).join(".")))
		: [];
	if (matchPropsOn.length > 0) page.matchPropsOn = matchPropsOn;
	if (scrollProps && Object.keys(scrollProps).length > 0) page.scrollProps = scrollProps;

	// Deferred props describe work the client must fetch in a FOLLOW-UP partial
	// request — announcing them during that partial would loop forever.
	const deferredProps = input.deferredProps ?? {};
	if (!partial && Object.keys(deferredProps).length > 0) page.deferredProps = deferredProps;

	// Rescued props are the deferred props that failed and were retried; they
	// only exist in the partial response that carries them.
	const rescuedProps = input.rescuedProps ?? [];
	if (partial && rescuedProps.length > 0) page.rescuedProps = rescuedProps;

	const sharedProps = input.sharedProps ?? [];
	if (input.exposeSharedPropKeys !== false && sharedProps.length > 0) page.sharedProps = sharedProps;

	if (Object.keys(onceProps).length > 0) page.onceProps = onceProps;

	const flash = input.flash ?? {};
	if (Object.keys(flash).length > 0) page.flash = flash;

	return page;
}

function resolveErrors(errors: Record<string, unknown> | undefined, errorBag: string | undefined) {
	const resolved = errors ?? {};
	if (errorBag && Object.keys(resolved).length > 0) return { [errorBag]: resolved };
	return resolved;
}

function normalizeOnceProps(
	onceProps: Record<string, { prop: string; expiresAt?: number | null }> | undefined,
): Record<string, OnceProp> {
	const out: Record<string, OnceProp> = {};
	for (const [key, entry] of Object.entries(onceProps ?? {})) {
		out[key] = { prop: entry.prop, expiresAt: entry.expiresAt ?? null };
	}
	return out;
}

/** `posts.data` -> `posts`; a path with no dot is its own root. */
function root(path: string): string {
	const dot = path.indexOf(".");
	return dot === -1 ? path : path.slice(0, dot);
}

/**
 * Drop the merge labels this reset cancels: the exact paths named, plus
 * everything under a scroll prop the reset flagged.
 */
function strip(list: string[] | undefined, reset: readonly string[], resetScroll: ReadonlySet<string>): string[] {
	return (list ?? []).filter((path) => !reset.includes(path) && !resetScroll.has(path) && !resetScroll.has(root(path)));
}

/**
 * Does `entry` name this scroll prop? A scroll prop is addressed by its key
 * (`posts`), and the merge label it emits sits one level in (`posts.data`) —
 * either spelling in `X-Inertia-Reset` means the same prop.
 */
function resets(key: string, reset: readonly string[]): boolean {
	return reset.some((entry) => entry === key || root(entry) === key || root(key) === entry);
}

function applyReset(
	scrollProps: Record<string, ScrollProp> | undefined,
	reset: readonly string[],
): Record<string, ScrollProp> | undefined {
	if (!scrollProps) return undefined;
	if (reset.length === 0) return { ...scrollProps };
	const out: Record<string, ScrollProp> = {};
	for (const [path, value] of Object.entries(scrollProps)) {
		out[path] = resets(path, reset) ? { ...value, reset: true } : value;
	}
	return out;
}

/** The scroll prop keys this response flagged `reset` — their labels come off. */
function scrollResetKeys(scrollProps: Record<string, ScrollProp> | undefined): ReadonlySet<string> {
	const out = new Set<string>();
	for (const [key, value] of Object.entries(scrollProps ?? {})) {
		if (value.reset === true) out.add(key);
	}
	return out;
}
