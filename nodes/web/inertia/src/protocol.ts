/**
 * Inertia **v3** wire protocol — pure functions, no node, no `ctx`.
 *
 * Everything here is deliberately free of Blok runtime types except the
 * `RespondEnvelope` brand, so the SSR server (#1001) and DevTools (#1017) can
 * import the exact same serializer the HTTP node uses.
 *
 * Reference: https://inertiajs.com/docs/v3/core-concepts/the-protocol
 */

import { RESPOND_BRAND, type RespondEnvelope } from "@blokjs/shared";

// =============================================================================
// Page object
// =============================================================================

/** One infinite-scroll prop's paging metadata. */
export interface ScrollProp {
	pageName: string;
	previousPage?: number | string | null;
	nextPage?: number | string | null;
	currentPage?: number | string | null;
	reset?: boolean;
}

/**
 * A once-prop entry: which prop it caches, and when the cache expires.
 *
 * `expiresAt` is EPOCH MILLISECONDS (`null` = never). That is the client's own
 * contract — it keeps an entry while `expiresAt > Date.now()`.
 */
export interface OnceProp {
	prop: string;
	expiresAt: number | null;
}

/**
 * The Inertia v3 page object. The four always-present fields come first;
 * every optional field is OMITTED when it does not apply (never `false`,
 * never `[]`, never `{}`).
 */
export interface PageObject {
	component: string;
	props: Record<string, unknown>;
	url: string;
	version: string;
	encryptHistory?: true;
	clearHistory?: true;
	preserveFragment?: true;
	mergeProps?: string[];
	prependProps?: string[];
	deepMergeProps?: string[];
	matchPropsOn?: string[];
	scrollProps?: Record<string, ScrollProp>;
	deferredProps?: Record<string, string[]>;
	rescuedProps?: string[];
	sharedProps?: string[];
	onceProps?: Record<string, OnceProp>;
	flash?: Record<string, unknown>;
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * The two JS line terminators, as a character class built from char codes so
 * this source file stays pure ASCII.
 */
const LINE_TERMINATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, "g");

/**
 * Serialize a page object for the `<script type="application/json">` boot tag.
 *
 * v3 delivers the page through a script element, not an HTML attribute, so the
 * browser hands the body to `JSON.parse` **verbatim** — HTML entities are NOT
 * decoded inside `<script>`, which makes entity encoding actively wrong here.
 * What has to be escaped is anything that could terminate the element or
 * confuse a JS parser:
 *
 * - every `/` becomes `\/` (kills `</script>` in one rule, and is what the
 *   protocol docs specify),
 * - every `<` becomes the JSON escape `\\u003C` (kills `<!--`, and a nested
 *   `<script` inside a string),
 * - U+2028 / U+2029 become their `\u` escapes (valid JSON, illegal raw in JS).
 *
 * All three are legal JSON escapes, so `JSON.parse(textContent)` round-trips
 * to the original value.
 */
export function serializePage(page: unknown): string {
	return JSON.stringify(page)
		.replace(/\//g, "\\/")
		.replace(/</g, "\\u003C")
		.replace(LINE_TERMINATORS, (ch) => (ch.charCodeAt(0) === 0x2028 ? "\\u2028" : "\\u2029"));
}

// =============================================================================
// HTML shell (initial, non-Inertia response)
// =============================================================================

/** Where the shell wants the `<Head>` defaults and the app root + boot script. */
export const HEAD_MARKER = "<!--blok:head-->";
export const APP_MARKER = "<!--blok:app-->";
/**
 * Where the shell wants the client bundle's `<script>` / `<link>` tags (#1051).
 * `viteAssetTags()` in `./vite-assets.ts` produces them; this file stays free
 * of the filesystem so the SSR server and DevTools can import it anywhere.
 */
export const ASSETS_MARKER = "<!--blok:assets-->";

/**
 * The default shell. `data-inertia` (v3 renamed it from `inertia`) marks the
 * tags the client's `<Head>` is allowed to replace on the first render.
 */
export const DEFAULT_SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title data-inertia>{{title}}</title>
${HEAD_MARKER}
${ASSETS_MARKER}
</head>
<body>
${APP_MARKER}
</body>
</html>
`;

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export interface RenderShellOptions {
	/** Shell template. Must contain {@link APP_MARKER}. */
	shell?: string;
	/** Root element id, and the `data-page` attribute value. */
	rootId?: string;
	/** Markup injected at {@link HEAD_MARKER} (server-rendered `<Head>` tags). */
	head?: string;
	/**
	 * Markup injected at {@link ASSETS_MARKER} — the client bundle's tags from
	 * `viteAssetTags()`. A shell without the marker is left untouched.
	 */
	assets?: string;
	/** Template-only values — `{{key}}` in the shell. NEVER sent to the client. */
	viewData?: Record<string, unknown>;
	/** Pre-rendered app markup. Omit for the normal client-rendered root + page script. */
	body?: string;
}

/**
 * Render the initial HTML document around a page object.
 *
 * The page rides in `<script type="application/json" data-page="…">`, which is
 * how v3 delivers it — the v2 `data-page` ATTRIBUTE on the root div is gone,
 * and with it the entity-encoding rules that attribute needed.
 */
export function renderShell(page: PageObject, opts: RenderShellOptions = {}): string {
	const shell = opts.shell ?? DEFAULT_SHELL;
	if (!shell.includes(APP_MARKER)) {
		throw new Error(
			`Inertia shell is missing the ${APP_MARKER} marker — the app root cannot be placed. Fix: add ${APP_MARKER} to the shell template where the app should mount.`,
		);
	}
	const rootId = opts.rootId ?? "app";
	const boot =
		opts.body ??
		`<div id="${escapeHtml(rootId)}"></div>` +
			`<script type="application/json" data-page="${escapeHtml(rootId)}">${serializePage(page)}</script>`;

	let html = shell;
	for (const [key, value] of Object.entries(opts.viewData ?? {})) {
		html = html.split(`{{${key}}}`).join(escapeHtml(value === undefined || value === null ? "" : String(value)));
	}
	// Unfilled placeholders would otherwise render as literal `{{title}}`.
	html = html.replace(/\{\{\s*[\w.$-]+\s*\}\}/g, "");
	// Replacer FUNCTIONS, not strings: a prop containing `$&` or `$'` would
	// otherwise be re-expanded by String.replace's substitution patterns.
	const head = opts.head ?? "";
	const assets = opts.assets ?? "";
	return html
		.replace(HEAD_MARKER, () => head)
		.replace(ASSETS_MARKER, () => assets)
		.replace(APP_MARKER, () => boot);
}

// =============================================================================
// Control responses
// =============================================================================

/** Methods whose redirect must be a 303 so the browser re-issues it as a GET. */
const SEE_OTHER_METHODS = new Set(["PUT", "PATCH", "DELETE"]);

function envelope(env: Omit<RespondEnvelope, typeof RESPOND_BRAND>): RespondEnvelope {
	return { [RESPOND_BRAND]: true, ...env };
}

/**
 * Hard, full-page visit to `url` (the Inertia `location()` response): `409`
 * plus `X-Inertia-Location`. Used for external redirects and anywhere the SPA
 * must be torn down and rebooted.
 */
export function location(url: string): RespondEnvelope {
	return envelope({ status: 409, headers: { "X-Inertia-Location": url } });
}

export interface RedirectOptions {
	/** The request method the redirect answers. PUT/PATCH/DELETE produce a 303. */
	method?: string;
	/** True when the request carried `Purpose: prefetch`. */
	prefetch?: boolean;
	/** Ask the client to keep the current URL fragment across the visit. */
	preserveFragment?: boolean;
	/** Extra response headers (`Set-Cookie` rides the envelope's `cookies`). */
	headers?: Record<string, string>;
}

/**
 * Redirect, Inertia-style.
 *
 * - Target carries a `#fragment` and the request is NOT a prefetch: `409` +
 *   `X-Inertia-Redirect`, so the client issues a fresh Inertia GET and keeps
 *   the fragment (a plain 302 would lose it — browsers do not resend it).
 * - Otherwise a normal redirect, promoted to `303` after PUT/PATCH/DELETE so
 *   the follow-up is a GET rather than a replayed write.
 */
export function redirect(url: string, opts: RedirectOptions = {}): RespondEnvelope {
	const headers: Record<string, string> = { ...opts.headers };
	if (url.includes("#") && !opts.prefetch) {
		headers["X-Inertia-Redirect"] = url;
		return envelope({ status: 409, headers });
	}
	headers.Location = url;
	// `preserveFragment` reaches the NEXT page object through this marker header.
	// #996 shipped the real carrier — `redirectBack()` persists the flag in the
	// signed flash cookie, and `inertia.shared` reads it back — so prefer that;
	// this header stays for a hand-rolled `redirect()` that has no flash cookie.
	if (opts.preserveFragment) headers["X-Inertia-Preserve-Fragment"] = "true";
	return envelope({
		status: SEE_OTHER_METHODS.has((opts.method ?? "GET").toUpperCase()) ? 303 : 302,
		headers,
	});
}

/**
 * Page-object flag: encrypt this history entry in the browser's history state.
 *
 * `encryptHistory(false)` is the per-page OPT-OUT (#1013): an explicit `false`
 * input beats the `inertia.encryptHistory` middleware and the adapter-wide
 * `history.encrypt` default, and the field is simply omitted (the page object
 * never carries `false`).
 */
export function encryptHistory(value = true): { encryptHistory: boolean } {
	return { encryptHistory: value };
}

/** Page-object flag: clear the client's history state on this visit. */
export function clearHistory(value = true): { clearHistory: boolean } {
	return { clearHistory: value };
}

/**
 * Version-mismatch response: `409`, empty body, `X-Inertia-Location` (so the
 * client reloads the same URL) and the current `X-Inertia-Version`. Note the
 * deliberate absence of an `X-Inertia` response header — the client treats a
 * 409 carrying it as a protocol error.
 */
export function versionConflict(url: string, version: string): RespondEnvelope {
	return envelope({
		status: 409,
		headers: { "X-Inertia-Location": url, "X-Inertia-Version": version },
	});
}

// =============================================================================
// Dot-path helpers (partial reloads use dot notation: `posts.data`)
// =============================================================================

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function getPath(source: Record<string, unknown>, path: string): unknown {
	let cursor: unknown = source;
	for (const key of path.split(".")) {
		if (!isRecord(cursor)) return undefined;
		cursor = cursor[key];
	}
	return cursor;
}

export function hasPath(source: Record<string, unknown>, path: string): boolean {
	let cursor: unknown = source;
	for (const key of path.split(".")) {
		if (!isRecord(cursor) || !(key in cursor)) return false;
		cursor = cursor[key];
	}
	return true;
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const keys = path.split(".");
	const last = keys.pop() as string;
	let cursor = target;
	for (const key of keys) {
		const next = cursor[key];
		if (!isRecord(next)) cursor[key] = {};
		cursor = cursor[key] as Record<string, unknown>;
	}
	cursor[last] = value;
}

export function deletePath(target: Record<string, unknown>, path: string): void {
	const keys = path.split(".");
	const last = keys.pop() as string;
	let cursor: unknown = target;
	for (const key of keys) {
		if (!isRecord(cursor)) return;
		cursor = cursor[key];
	}
	if (isRecord(cursor)) delete cursor[last];
}

/** Build a new object holding only `paths` (dot notation) out of `source`. */
export function pickPaths(source: Record<string, unknown>, paths: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const path of paths) {
		if (hasPath(source, path)) setPath(out, path, getPath(source, path));
	}
	return out;
}

// =============================================================================
// Header helpers
// =============================================================================

/** Lower-case every header name so lookups are case-insensitive. */
export function normalizeHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (value === undefined || value === null) continue;
		out[key.toLowerCase()] = Array.isArray(value) ? String(value[0]) : String(value);
	}
	return out;
}

/** Split a comma-separated header value into trimmed, non-empty items. */
export function headerList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}
