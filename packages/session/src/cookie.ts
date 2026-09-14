/**
 * The session cookie (#1018).
 *
 * `HttpOnly`, `SameSite=Lax`, `Path=/`, and signed — the mirror image of the
 * CSRF cookie (`core/shared/src/csrf.ts`), which is deliberately readable by
 * JavaScript and carries no authority. This one carries ALL of it: the value is
 * an opaque session id, and every byte of session DATA stays server-side in the
 * store. Nothing about the user is ever in the cookie, so a stolen cookie is
 * revocable (destroy the record) and a tampered one verifies to `undefined`.
 *
 * `SameSite=Lax` rather than `Strict`: `Strict` drops the cookie on a top-level
 * navigation from another origin, so a user following a link into the app looks
 * logged out. `Lax` still withholds it from cross-site POSTs, and the CSRF
 * double-submit (#1012) covers what remains.
 *
 * ponytail: the HMAC here is a 15-line twin of `signFlash`/`verifyFlash`
 * (`@blokjs/shared`) with one difference that matters — the payload is an
 * opaque id, not JSON, so there is no base64url-of-JSON round trip and nothing
 * to parse from an attacker-controlled string. Upgrade path if a third signed
 * cookie ever appears: generalise `flash.ts` over its payload type and have
 * both call it.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readCookie } from "@blokjs/shared";

/** Default cookie name. */
export const SESSION_COOKIE = "blok_session";

/** Default lifetime: two weeks, in seconds — Laravel's `remember me` window. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 14;

/** Cookie attributes. `HttpOnly` and `SameSite=Lax` are not negotiable knobs. */
export interface SessionCookieOptions {
	name?: string;
	path?: string;
	/** Seconds. Default {@link SESSION_MAX_AGE}. */
	maxAge?: number;
	/** `SameSite`. Default `Lax`; `None` additionally forces `Secure`. */
	sameSite?: "Lax" | "Strict" | "None";
	/** Add `Secure`. Set it from the request's scheme in production. */
	secure?: boolean;
}

/** A fresh session id: 32 random bytes, base64url (43 chars, cookie-safe). */
export function newSessionId(): string {
	return randomBytes(32).toString("base64url");
}

function signature(id: string, secret: string): string {
	return createHmac("sha256", secret).update(id).digest("base64url");
}

/** Sign a session id into the cookie VALUE (`<id>.<mac>`). */
export function signSessionId(id: string, secret: string): string {
	return `${id}.${signature(id, secret)}`;
}

/**
 * Verify a cookie value and return the session id, or `undefined` for anything
 * that is not intact and correctly signed. Never throws: a poisoned cookie
 * degrades to "signed out" rather than a 500.
 */
export function verifySessionId(token: string | undefined, secret: string): string | undefined {
	if (!token) return undefined;
	const split = token.lastIndexOf(".");
	if (split <= 0) return undefined;
	const id = token.slice(0, split);
	const mac = Buffer.from(token.slice(split + 1), "utf8");
	const expected = Buffer.from(signature(id, secret), "utf8");
	// Constant-time; the length check short-circuits because `timingSafeEqual`
	// throws on differing lengths and a MAC's length is not a secret.
	if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return undefined;
	return id;
}

function attributes(opts: SessionCookieOptions): string[] {
	const sameSite = opts.sameSite ?? "Lax";
	const parts = [`Path=${opts.path ?? "/"}`, "HttpOnly", `SameSite=${sameSite}`];
	// A `SameSite=None` cookie without `Secure` is rejected outright by every
	// current browser, which would silently sign the user out.
	if (opts.secure || sameSite === "None") parts.push("Secure");
	return parts;
}

/** Build the `Set-Cookie` that PERSISTS a signed session token. */
export function sessionSetCookie(token: string, opts: SessionCookieOptions = {}): string {
	return [
		`${opts.name ?? SESSION_COOKIE}=${token}`,
		...attributes(opts),
		`Max-Age=${opts.maxAge ?? SESSION_MAX_AGE}`,
	].join("; ");
}

/** Build the `Set-Cookie` that CLEARS the session cookie (`Max-Age=0`). */
export function clearSessionCookie(opts: SessionCookieOptions = {}): string {
	return [`${opts.name ?? SESSION_COOKIE}=`, ...attributes(opts), "Max-Age=0"].join("; ");
}

/** The session id a request arrived with — verified — or `undefined`. */
export function readSessionCookie(
	headers: Record<string, unknown> | undefined,
	secret: string,
	name: string = SESSION_COOKIE,
): string | undefined {
	const header = headers?.cookie ?? headers?.Cookie;
	if (typeof header !== "string") return undefined;
	return verifySessionId(readCookie(header, name), secret);
}
