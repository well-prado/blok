/**
 * Double-submit CSRF primitives (#1012).
 *
 * The token never leaves the browser's own cookie jar: the server writes a
 * random `XSRF-TOKEN` cookie that is deliberately NOT `HttpOnly`, the stock
 * Inertia client (axios) reads it back and echoes it in `X-XSRF-TOKEN`, and a
 * write request is accepted only when the two match. A cross-site form can
 * make the browser SEND the cookie but cannot READ it, so it cannot produce
 * the header — that asymmetry is the whole mechanism.
 *
 * It lives in `@blokjs/shared` for the same reason `flash.ts` does: both the
 * `@blokjs/csrf` node (in `@blokjs/helpers`) and `@blokjs/inertia`'s
 * `rotateCsrf()` need byte-identical cookies, and `@blokjs/helpers` already
 * imports `@blokjs/inertia` dynamically — a static import back would close the
 * loop. A cookie whose `Path`/`SameSite` differ between the two writers is two
 * cookies as far as the browser is concerned, which is exactly the failure
 * mode this shared file rules out.
 *
 * ## How the cookie reaches the response
 *
 * The middleware that issues it runs BEFORE the page workflow, so it cannot
 * hand a `Set-Cookie` to a response that does not exist yet, and it must not
 * depend on the Inertia serializer (a route may answer with `@blokjs/respond`,
 * an error page, or a redirect). {@link issueCsrfCookie} therefore installs a
 * one-time accessor over `ctx.response`: whatever the workflow finally assigns
 * there gets the pending `Set-Cookie` values appended on its way out. The mark
 * is a plain (non-`state`) field on `ctx`, the same pattern `markHistory()`
 * (#1013) and `_blokMiddlewareName` use.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readCookie } from "./flash";
import { type RespondEnvelope, isRespondEnvelope } from "./types/RespondEnvelope";

/** Default cookie name — what `@inertiajs/core`'s axios reads with no config. */
export const CSRF_COOKIE = "XSRF-TOKEN";

/** Default header name — what that same axios sends it back in. */
export const CSRF_HEADER = "X-XSRF-TOKEN";

/** Legacy body field (Laravel's `@csrf` / `usePage().props.csrfToken` pattern). */
export const CSRF_FIELD = "_token";

/** The flash message a rejected write bounces back with. */
export const CSRF_EXPIRED_MESSAGE = "The page expired, please try again.";

/** Cookie attributes. `HttpOnly` is deliberately absent — the client reads this one. */
export interface CsrfCookieOptions {
	name?: string;
	path?: string;
	sameSite?: "Lax" | "Strict" | "None";
	/** Add `Secure`. The middleware sets it from the request's scheme. */
	secure?: boolean;
	/** Seconds. Omitted by default, i.e. a session cookie. */
	maxAge?: number;
}

/**
 * Should the cookie carry `Secure`? True for an HTTPS request — behind a proxy,
 * per `X-Forwarded-Proto`. Pass `ctx.request`.
 */
export function csrfSecureFor(request: unknown): boolean {
	if (!request || typeof request !== "object") return false;
	const host = request as CsrfRequestHost & { url?: unknown };
	const proto = host.headers?.["x-forwarded-proto"];
	if (typeof proto === "string" && proto.length > 0) return proto.split(",")[0]?.trim().toLowerCase() === "https";
	return typeof host.url === "string" && host.url.startsWith("https:");
}

/** A fresh token: 32 random bytes, base64url (43 chars, URL- and cookie-safe). */
export function newCsrfToken(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * Build the `Set-Cookie` that carries the token.
 *
 * `SameSite=Lax` + `Path=/`, and NO `HttpOnly`: the browser must be able to
 * read this cookie from JavaScript, which is the point of the double-submit
 * pattern. It carries no authority on its own — it authenticates nothing, it
 * only has to be unguessable.
 */
export function csrfSetCookie(token: string, opts: CsrfCookieOptions = {}): string {
	const parts = [
		`${opts.name ?? CSRF_COOKIE}=${token}`,
		`Path=${opts.path ?? "/"}`,
		`SameSite=${opts.sameSite ?? "Lax"}`,
	];
	if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
	if (opts.secure) parts.push("Secure");
	return parts.join("; ");
}

/**
 * Constant-time token comparison.
 *
 * `timingSafeEqual` throws on differing lengths, so the length check runs
 * first — the length of a token is not a secret, its bytes are. Two tokens of
 * the same length always cost the same to compare, whether they match or not.
 */
export function csrfTokensMatch(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

// =============================================================================
// Request / response marks
// =============================================================================

/** The `ctx` fields these helpers own. Structural, so this file needs no engine types. */
interface CsrfHost {
	_blokCsrfCookies?: string[];
	response?: unknown;
	request?: CsrfRequestHost;
}

/** The `ctx.request` fields these helpers own. */
interface CsrfRequestHost {
	headers?: Record<string, unknown>;
	_blokCsrfToken?: string;
}

/** Append the cookies this request issued to a finished response value. */
function attachCookies(value: unknown, cookies: string[]): unknown {
	if (isRespondEnvelope(value)) return withCookies(value, cookies);
	// A module node's `BlokResponse` wrapper — the envelope is one level down.
	if (value && typeof value === "object" && "data" in value) {
		const wrapper = value as { data: unknown };
		if (isRespondEnvelope(wrapper.data)) return { ...value, data: withCookies(wrapper.data, cookies) };
	}
	// Anything else (a bare object/string body, the empty initial response) has
	// no place to put a `Set-Cookie`. ponytail: an Inertia page response is
	// always an envelope — the serializer, `@blokjs/respond` and every redirect
	// helper return one — so the cookie reaches every response that could
	// plausibly render a form. Upgrade path if a plain-JSON route ever needs it:
	// wrap the value here, at the cost of owning its content-type.
	return value;
}

function withCookies(env: RespondEnvelope, cookies: string[]): RespondEnvelope {
	const existing = env.cookies ?? [];
	const missing = cookies.filter((cookie) => !existing.includes(cookie));
	if (missing.length === 0) return env;
	return { ...env, cookies: [...existing, ...missing] };
}

/**
 * Emit `cookie` with whatever response this request ends up producing.
 *
 * Idempotent per ctx: the first call installs the `ctx.response` accessor,
 * later ones just add to the pending list. Re-assigning `ctx.response` (the
 * runner does it after every step, and the HTTP trigger once more when it
 * normalises the envelope) re-applies the cookies without duplicating them.
 */
export function issueCsrfCookie(ctx: unknown, cookie: string): void {
	if (!ctx || typeof ctx !== "object") return;
	const host = ctx as CsrfHost;
	if (host._blokCsrfCookies) {
		if (!host._blokCsrfCookies.includes(cookie)) host._blokCsrfCookies.push(cookie);
		// Re-run the setter so a cookie added AFTER the response was assigned
		// (`rotateCsrf()` in the last step of a login workflow) still lands.
		const assigned = host.response;
		host.response = assigned;
		return;
	}

	const cookies = [cookie];
	let current = attachCookies(host.response, cookies);
	Object.defineProperty(host, "_blokCsrfCookies", {
		value: cookies,
		writable: true,
		enumerable: false,
		configurable: true,
	});
	Object.defineProperty(host, "response", {
		configurable: true,
		// Enumerable, because a spread copy of the ctx (the `page` step builds
		// one per prop) has to keep carrying a `response` field.
		enumerable: true,
		get: () => current,
		set: (value: unknown) => {
			current = attachCookies(value, cookies);
		},
	});
}

/** Every `Set-Cookie` this request has issued — what a short-circuit must carry itself. */
export function pendingCsrfCookies(ctx: unknown): string[] {
	if (!ctx || typeof ctx !== "object") return [];
	return [...((ctx as CsrfHost)._blokCsrfCookies ?? [])];
}

/**
 * Remember the token this request issued, on `ctx.request`.
 *
 * On the request rather than the ctx because that object is what a shared-prop
 * resolver (`share("csrfToken", (req) => …)`) is handed, and what every child
 * ctx the runner builds carries by reference.
 */
export function markCsrfToken(request: unknown, token: string): void {
	if (!request || typeof request !== "object") return;
	(request as CsrfRequestHost)._blokCsrfToken = token;
}

/**
 * This request's token: the cookie it arrived with, else the one the middleware
 * issued for it. `undefined` when the middleware never ran.
 */
export function csrfTokenOf(request: unknown, cookieName: string = CSRF_COOKIE): string | undefined {
	if (!request || typeof request !== "object") return undefined;
	const host = request as CsrfRequestHost;
	const cookieHeader = host.headers?.cookie;
	const fromCookie = typeof cookieHeader === "string" ? readCookie(cookieHeader, cookieName) : undefined;
	return fromCookie ?? host._blokCsrfToken;
}

// =============================================================================
// Exemptions
// =============================================================================

/**
 * Laravel's `Str::is` semantics: `*` matches ANY run of characters, slashes
 * included, so `webhooks/*` exempts `/webhooks/stripe/events` too. A leading
 * slash on either side is ignored, so `webhooks/*` and `/webhooks/*` are the
 * same rule.
 */
export function csrfPathExempt(path: string, patterns: readonly string[] | undefined): boolean {
	if (!patterns || patterns.length === 0) return false;
	const target = path.replace(/^\/+/, "");
	return patterns.some((pattern) => {
		const trimmed = pattern.replace(/^\/+/, "");
		if (trimmed === target) return true;
		if (!trimmed.includes("*")) return false;
		const source = trimmed
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
		return new RegExp(`^${source}$`).test(target);
	});
}

/**
 * The PATH of a `Referer` this app may bounce back to, or `undefined`.
 *
 * `Referer` is attacker-controllable and a bounce-back answers a FAILED WRITE,
 * so a raw `Location: <referer>` hands an attacker a 303 to their own site,
 * carrying whatever the bounce was going to show (#1018 security review L1).
 * Both bounce-backs in this codebase — `redirectBack()` in `@blokjs/inertia`
 * and the `@blokjs/csrf` node's rejection — go through here, because a guard
 * that lives in one of them is a guard the other one does not have.
 *
 * Ours means: a relative path (what a same-origin browser navigation sends), or
 * an absolute URL whose host matches the request's own `Origin` / `Host`
 * (`X-Forwarded-Host` first, behind a proxy).
 *
 * The result is always PATH-ONLY (#1003), for two reasons:
 *
 * - **Standalone mode.** There the referring page is the SPA's origin, which
 *   `Origin` legitimately names — and an absolute `Location` would send the
 *   browser to the SPA server, an XHR redirect it cannot follow because that
 *   server answers no CORS. A relative one resolves against the API.
 * - **Defence in depth.** A path can never leave this app, so the phishing
 *   shape is impossible even if the host comparison is ever fooled.
 */
export function safeRefererPath(referer: string | undefined, headers: Record<string, string>): string | undefined {
	if (referer === undefined || referer === "") return undefined;
	// A protocol-relative URL (`//evil.example/x`) is absolute to a browser.
	if (referer.startsWith("/") && !referer.startsWith("//")) return referer;

	let url: URL;
	try {
		url = new URL(referer);
	} catch {
		return undefined;
	}
	const path = `${url.pathname}${url.search}${url.hash}`;
	const origin = headers.origin;
	if (typeof origin === "string" && origin.length > 0) {
		try {
			if (new URL(origin).host === url.host) return path;
		} catch {
			// An unparsable Origin proves nothing; fall through to Host.
		}
	}
	const forwarded = headers["x-forwarded-host"]?.split(",")[0]?.trim();
	const host = forwarded && forwarded.length > 0 ? forwarded : headers.host;
	return typeof host === "string" && host.length > 0 && host.toLowerCase() === url.host.toLowerCase()
		? path
		: undefined;
}
