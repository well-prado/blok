/**
 * Flash data + "redirect back with errors" (#996).
 *
 * Inertia v3 moved flash OUT of props: it is a top-level page-object field the
 * client reads once, fires `inertia:flash` for, and strips from history state.
 * The server side of that is a one-shot signed cookie — written on the redirect
 * that follows a failed write, read (and expired) by the render that follows.
 *
 * Everything here is pure: request-shaped input in, `RespondEnvelope` /
 * plain-object out. The signing primitives come from `@blokjs/shared` so the
 * `@blokjs/flash` node and these helpers produce byte-identical cookies.
 */

import {
	type FlashCookieOptions,
	type FlashPayload,
	flashSetCookie,
	isEmptyFlash,
	resolveFlashSecret,
	signFlash,
} from "@blokjs/shared";
import type { RespondEnvelope } from "@blokjs/shared";
import { normalizeHeaders, redirect } from "./protocol.js";

export type { FlashPayload } from "@blokjs/shared";

/** The slice of a request these helpers read (`ctx.request`, or #1008's `req`). */
export interface FlashRequest {
	headers?: Record<string, unknown>;
	method?: string;
}

/** Cookie + signing knobs, shared by every helper that persists a flash. */
export interface FlashPersistOptions extends FlashCookieOptions {
	/** Signing secret. Defaults to `BLOK_FLASH_SECRET`. */
	secret?: string;
}

export interface RedirectBackOptions extends FlashPersistOptions {
	/** Validation errors to show on the page we bounce back to. */
	errors?: Record<string, unknown>;
	/** Error-bag name the errors nest under. Defaults to the request's `X-Inertia-Error-Bag`. */
	bag?: string;
	/** Page-object flash data to carry across the redirect. */
	flash?: Record<string, unknown>;
	/** Where to go when the request carried no `Referer`. Default `/`. */
	fallback?: string;
	/** Keep the current URL fragment across the visit. */
	preserveFragment?: boolean;
	/** #1013 — make the page after the redirect carry `clearHistory: true`. */
	clearHistory?: boolean;
	/** Extra response headers merged onto the redirect. */
	headers?: Record<string, string>;
}

/**
 * Build the `Set-Cookie` that persists `payload`, or `undefined` when there is
 * nothing to persist. Signing needs a secret — see `resolveFlashSecret`; an app
 * that has flash to carry is an app that configured one.
 */
export function flashCookie(payload: FlashPayload, opts: FlashPersistOptions = {}): string | undefined {
	if (isEmptyFlash(payload)) return undefined;
	return flashSetCookie(signFlash(payload, resolveFlashSecret(opts.secret)), opts);
}

/**
 * Redirect back to the referring page, persisting `errors` AND `flash` in the
 * signed one-shot cookie — Laravel's `back()->withErrors(...)`, exactly.
 *
 * The status follows the Inertia rules `redirect()` already encodes (303 after
 * PUT/PATCH/DELETE; the trigger's safety net covers a 302 that escapes another
 * way), and `preserveFragment` rides the COOKIE rather than the
 * `X-Inertia-Preserve-Fragment` stopgap header `redirect()` emits — the next
 * render reads it back off the flash and puts it on the page object.
 */
/**
 * The `Referer` to bounce back to, or `undefined` when it is not OURS.
 *
 * A `Referer` is attacker-controllable, and `redirectBack()` answers a failed
 * write — so without this check `POST /login` with
 * `Referer: https://evil.example/x` answers 303 to evil.example, carrying the
 * flash cookie's errors to a phishing page that looks like the bounce the user
 * expected (#1018 security review L1).
 *
 * Same-origin means: a relative path (what a same-origin browser navigation
 * sends), or an absolute URL whose host matches the request's own `Origin` /
 * `Host` (`X-Forwarded-Host` first, behind a proxy).
 */
function sameOriginReferer(referer: string | undefined, headers: Record<string, string>): string | undefined {
	if (referer === undefined || referer === "") return undefined;
	// A protocol-relative URL (`//evil.example/x`) is absolute to a browser.
	if (referer.startsWith("/") && !referer.startsWith("//")) return referer;

	let url: URL;
	try {
		url = new URL(referer);
	} catch {
		return undefined;
	}
	const origin = headers.origin;
	if (typeof origin === "string" && origin.length > 0) {
		try {
			if (new URL(origin).host === url.host) return referer;
		} catch {
			// An unparsable Origin proves nothing; fall through to Host.
		}
	}
	const forwarded = headers["x-forwarded-host"]?.split(",")[0]?.trim();
	const host = forwarded && forwarded.length > 0 ? forwarded : headers.host;
	return typeof host === "string" && host.length > 0 && host.toLowerCase() === url.host.toLowerCase()
		? referer
		: undefined;
}

export function redirectBack(req: FlashRequest, opts: RedirectBackOptions = {}): RespondEnvelope {
	const headers = normalizeHeaders(req?.headers);
	const referer = sameOriginReferer(headers.referer ?? headers.referrer, headers);
	const target = referer ?? opts.fallback ?? "/";
	const env = redirect(target, {
		method: req?.method,
		prefetch: headers.purpose === "prefetch",
		headers: opts.headers,
	});
	const cookie = flashCookie(
		{
			errors: opts.errors,
			// #1011 — the bag defaults to the REQUEST's `X-Inertia-Error-Bag`, the
			// mirror of what the adapter already does on the render side. The
			// bounce-back GET does not carry the header, so if the name is not
			// persisted here the errors un-nest on exactly the visit that shows
			// them, and a page with two forms puts one form's errors on the other.
			bag: opts.bag ?? headers["x-inertia-error-bag"],
			flash: opts.flash,
			preserveFragment: opts.preserveFragment,
			clearHistory: opts.clearHistory,
		},
		opts,
	);
	// `redirect()` promotes PUT/PATCH/DELETE to 303. A bounce-back answers a
	// FAILED WRITE, so POST gets the same treatment here: on a 302 the browser
	// (and a non-Inertia client) may replay the POST against the target, which
	// is the double-submit this helper exists to avoid. 303 forces a GET.
	const method = (req?.method ?? "GET").toUpperCase();
	const status = env.status === 302 && method !== "GET" && method !== "HEAD" ? 303 : env.status;
	return { ...env, status, ...(cookie ? { cookies: [cookie] } : {}) };
}

/**
 * `back()` — the shorthand name. Identical to {@link redirectBack}, including
 * the error/flash persistence; Inertia's docs call it `back`, Laravel's call it
 * "redirect back", and authoring code reads better with the short one.
 */
export const back = redirectBack;

/** Chainable flash accumulator — see {@link flash}. */
export interface FlashBuilder {
	/** Add another entry (or merge another object). Returns `this` for chaining. */
	flash(key: string | Record<string, unknown>, value?: unknown): FlashBuilder;
	/** The accumulated flash data. */
	data(): Record<string, unknown>;
	/** Merge the accumulated flash into an `@blokjs/inertia` node input. */
	render<T extends Record<string, unknown>>(input: T): T & { flash: Record<string, unknown> };
	/** Redirect back, carrying the accumulated flash (plus any `errors`). */
	redirectBack(req: FlashRequest, opts?: RedirectBackOptions): RespondEnvelope;
	/** Alias of {@link FlashBuilder.redirectBack}. */
	back(req: FlashRequest, opts?: RedirectBackOptions): RespondEnvelope;
}

/**
 * Start a flash chain: `flash("toast", "Order created.").render({ component, props })`
 * or `flash({ toast }).redirectBack(req, { errors })`.
 *
 * The payload is arbitrary — it lands on `page.flash` as-is. The toast helper
 * the examples and scaffolds ship (`client/src/flash-toast.ts`) shows STRING
 * values, so an object payload needs a component of your own to render it.
 *
 * @example
 * return flash("toast", "Order created.").render({ component: "Orders/Index", props });
 */
export function flash(key: string | Record<string, unknown>, value?: unknown): FlashBuilder {
	const bag: Record<string, unknown> = {};
	const builder: FlashBuilder = {
		flash(nextKey, nextValue) {
			if (typeof nextKey === "string") bag[nextKey] = nextValue;
			else Object.assign(bag, nextKey);
			return builder;
		},
		data() {
			return { ...bag };
		},
		render(input) {
			return { ...input, flash: { ...((input.flash as Record<string, unknown>) ?? {}), ...bag } };
		},
		redirectBack(req, opts = {}) {
			return redirectBack(req, { ...opts, flash: { ...bag, ...(opts.flash ?? {}) } });
		},
		back(req, opts = {}) {
			return builder.redirectBack(req, opts);
		},
	};
	return builder.flash(key, value);
}

/**
 * Normalize validation errors to the shape the adapter is configured for.
 *
 * Inertia's default contract is one message per field (`string`); Laravel's
 * `withAllErrors` equivalent ships every message (`string[]`). The wire format
 * is whatever the server sends, so the choice is a server-side option — this is
 * the single place both the node and #1008's render path funnel through.
 */
export function normalizeErrors(
	errors: Record<string, unknown> | undefined,
	opts: { withAllErrors?: boolean } = {},
): Record<string, unknown> {
	const source = errors ?? {};
	const out: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(source)) {
		if (opts.withAllErrors) out[field] = Array.isArray(value) ? value : [value];
		else out[field] = Array.isArray(value) ? value[0] : value;
	}
	return out;
}
