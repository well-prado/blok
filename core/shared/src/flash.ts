/**
 * Signed one-shot **flash** cookie (#996).
 *
 * The carrier for the "redirect back with errors" flow: a POST that failed
 * validation persists `{ errors, bag, flash, preserveFragment }` into a signed
 * cookie, redirects, and the next GET reads it, merges it into the page object
 * and clears it. HMAC-SHA256 over the JSON body; a tampered or wrong-secret
 * token verifies to `undefined` rather than throwing, so a poisoned cookie
 * degrades to "no flash" instead of a 500.
 *
 * It lives in `@blokjs/shared` — not in `@blokjs/helpers` next to the
 * `@blokjs/flash` node, and not in `@blokjs/inertia` next to `redirectBack()` —
 * because BOTH of those need it and `@blokjs/helpers` already imports
 * `@blokjs/inertia` dynamically. A static import in the other direction would
 * close that loop and (silently, inside the existing try/catch) drop the
 * Inertia node from `HELPER_NODES` depending on module-eval order. Shared is
 * the one place both already depend on — same reasoning that put
 * `RespondEnvelope` here.
 *
 * Nothing here touches `ctx`: pure string in, pure string out.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Default cookie name. Override per call when one app serves several areas. */
export const FLASH_COOKIE = "blok_flash";

/** Env var holding the signing secret. Required — there is NO fallback. */
export const FLASH_SECRET_ENV = "BLOK_FLASH_SECRET";

/** What one flash cookie carries between two requests. */
export interface FlashPayload {
	/** Validation errors, merged into `props.errors` on the next render. */
	errors?: Record<string, unknown>;
	/** `X-Inertia-Error-Bag` name the errors nest under. */
	bag?: string;
	/** Page-object `flash` data (v3: a top-level field, NOT a prop). */
	flash?: Record<string, unknown>;
	/** Keep the URL fragment across the redirect. */
	preserveFragment?: boolean;
}

/** Cookie attributes. Defaults are the safe ones; only `secure` is opt-in. */
export interface FlashCookieOptions {
	name?: string;
	path?: string;
	/** Seconds. The cookie is one-shot anyway; this bounds a lost round-trip. */
	maxAge?: number;
	sameSite?: "Lax" | "Strict" | "None";
	secure?: boolean;
}

/**
 * Resolve the signing secret: the explicit argument, else `BLOK_FLASH_SECRET`.
 *
 * Throws — naming the env var — when neither is set. A derived or random
 * fallback would silently invalidate every flash cookie on restart (and, with a
 * constant fallback, forge them), so "missing secret" is a hard error.
 */
export function resolveFlashSecret(explicit?: string): string {
	const secret = explicit ?? process.env[FLASH_SECRET_ENV];
	if (!secret) {
		throw new Error(
			`[blok] flash cookies require a signing secret: set ${FLASH_SECRET_ENV} (or pass \`secret\`). ` +
				"There is no default — an unsigned or randomly-keyed flash cookie is forgeable.",
		);
	}
	return secret;
}

function encode(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function signature(body: string, secret: string): string {
	return createHmac("sha256", secret).update(body).digest("base64url");
}

/** Sign a payload into the cookie VALUE (`<base64url(json)>.<base64url(mac)>`). */
export function signFlash(payload: FlashPayload, secret: string): string {
	const body = encode(JSON.stringify(payload));
	return `${body}.${signature(body, secret)}`;
}

/**
 * Verify + decode a cookie value. Returns `undefined` for anything that is not
 * an intact, correctly-signed payload — missing, malformed, tampered, or signed
 * with a different secret. Never throws.
 */
export function verifyFlash(token: string | undefined, secret: string): FlashPayload | undefined {
	if (!token) return undefined;
	const split = token.lastIndexOf(".");
	if (split <= 0) return undefined;
	const body = token.slice(0, split);
	const mac = token.slice(split + 1);
	const expected = signature(body, secret);
	// Constant-time compare; length mismatch short-circuits (timingSafeEqual
	// throws on differing lengths, and the length itself is not a secret).
	const a = Buffer.from(mac, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as FlashPayload;
	} catch {
		return undefined;
	}
}

/** Build the `Set-Cookie` value that PERSISTS a signed token. */
export function flashSetCookie(token: string, opts: FlashCookieOptions = {}): string {
	const parts = [
		`${opts.name ?? FLASH_COOKIE}=${token}`,
		`Path=${opts.path ?? "/"}`,
		"HttpOnly",
		`SameSite=${opts.sameSite ?? "Lax"}`,
		`Max-Age=${opts.maxAge ?? 120}`,
	];
	if (opts.secure) parts.push("Secure");
	return parts.join("; ");
}

/** Build the `Set-Cookie` value that CLEARS the flash cookie (`Max-Age=0`). */
export function clearFlashCookie(opts: FlashCookieOptions = {}): string {
	const parts = [
		`${opts.name ?? FLASH_COOKIE}=`,
		`Path=${opts.path ?? "/"}`,
		"HttpOnly",
		`SameSite=${opts.sameSite ?? "Lax"}`,
		"Max-Age=0",
	];
	if (opts.secure) parts.push("Secure");
	return parts.join("; ");
}

/** Pull one cookie's value out of a raw `Cookie:` request header. */
export function readCookie(header: string | undefined, name: string = FLASH_COOKIE): string | undefined {
	if (!header) return undefined;
	for (const pair of header.split(";")) {
		const eq = pair.indexOf("=");
		if (eq < 0) continue;
		if (pair.slice(0, eq).trim() !== name) continue;
		return pair.slice(eq + 1).trim();
	}
	return undefined;
}

/** True when a payload carries nothing worth persisting. */
export function isEmptyFlash(payload: FlashPayload | undefined): boolean {
	if (!payload) return true;
	const errors = Object.keys(payload.errors ?? {}).length;
	const flash = Object.keys(payload.flash ?? {}).length;
	return errors === 0 && flash === 0 && !payload.preserveFragment;
}
