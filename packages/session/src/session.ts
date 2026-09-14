/**
 * The session itself (#1018): configuration, the per-request mark, and the four
 * operations the nodes are thin wrappers over.
 *
 * ## Where the cookie goes
 *
 * Every operation that changes the session id hands its `Set-Cookie` to
 * `issueCookie(ctx, …)` — `@blokjs/shared`'s `issueCsrfCookie`, whose mechanism
 * is not CSRF-specific at all: it installs a one-time accessor over
 * `ctx.response` so whatever the workflow finally returns (an Inertia page, a
 * redirect, `@blokjs/respond`) carries the cookie out. Re-using it means the
 * session cookie and the CSRF cookie can never disagree about how a pending
 * `Set-Cookie` reaches the wire, and login/logout ALSO get the string back so
 * they can put it on the envelope they build themselves (the append is
 * de-duplicated by exact value, so doing both is safe).
 *
 * ## Where the data goes
 *
 * `ctx.request`, via {@link markSession} — the same place `markCsrfToken()`
 * puts the CSRF token, and for the same reason: every child ctx the runner
 * builds carries `request` by reference, and a shared-prop resolver is handed
 * exactly that object. Never `ctx.state` / `ctx.vars`, which nodes must not
 * write; the `session` STATE slot is written the ordinary way, by the
 * `inertia.session` middleware step returning it.
 */

import { issueCsrfCookie as issueCookie } from "@blokjs/shared";
import {
	SESSION_MAX_AGE,
	type SessionCookieOptions,
	clearSessionCookie,
	newSessionId,
	readSessionCookie,
	sessionSetCookie,
	signSessionId,
} from "./cookie.js";
import { resolveSessionSecret } from "./secret.js";
import { type SessionStore, createSessionStore } from "./store.js";

// =============================================================================
// Configuration
// =============================================================================

export interface SessionOptions {
	/** Storage backend. Default: {@link createSessionStore} reads the environment. */
	store?: SessionStore;
	/** Cookie attributes. Name/path/SameSite/Secure. */
	cookie?: SessionCookieOptions;
	/** Lifetime in SECONDS. Default two weeks. */
	ttl?: number;
	/** Signing secret. Default `BLOK_SESSION_SECRET`. */
	secret?: string;
}

let options: SessionOptions = {};
let store: SessionStore | undefined;

/**
 * Configure the app's session. Call it once at boot, before any request.
 *
 * ```ts
 * configureSession({ ttl: 60 * 60 * 8, cookie: { secure: true } });
 * ```
 */
export function configureSession(next: SessionOptions): void {
	options = { ...options, ...next };
	if (next.store) store = next.store;
}

/** The configured store, created from the environment on first use. */
export function getSessionStore(): SessionStore {
	if (!store) store = options.store ?? createSessionStore();
	return store;
}

/** Test-only: drop the configuration and the memoised store. */
export function _resetSession(): void {
	options = {};
	store = undefined;
}

function cookieOptions(): SessionCookieOptions {
	return { ...options.cookie, maxAge: options.cookie?.maxAge ?? options.ttl ?? SESSION_MAX_AGE };
}

function ttlMs(): number {
	return (options.ttl ?? options.cookie?.maxAge ?? SESSION_MAX_AGE) * 1000;
}

// =============================================================================
// The per-request mark
// =============================================================================

/** What a request knows about its session once the middleware (or a node) has looked. */
export interface SessionState {
	/** The session id, or `null` for a request with no (valid) session. */
	id: string | null;
	/** The stored data. `{}` when there is no session. */
	data: Record<string, unknown>;
}

interface SessionHost {
	request?: { headers?: Record<string, unknown>; _blokSession?: SessionState };
}

/** Remember this request's session on `ctx.request`. */
export function markSession(request: unknown, state: SessionState): void {
	if (!request || typeof request !== "object") return;
	(request as { _blokSession?: SessionState })._blokSession = state;
}

/** What a previous lookup left on the request, or `undefined` when nothing has looked yet. */
export function sessionOf(request: unknown): SessionState | undefined {
	if (!request || typeof request !== "object") return undefined;
	return (request as { _blokSession?: SessionState })._blokSession;
}

// =============================================================================
// Operations
// =============================================================================

/**
 * Load this request's session — from the mark when something already looked,
 * otherwise from the signed cookie plus the store. Always marks the request, so
 * the store is hit at most once per request.
 */
export async function loadSession(ctx: unknown): Promise<SessionState> {
	const request = (ctx as SessionHost | undefined)?.request;
	const marked = sessionOf(request);
	if (marked) return marked;

	const id = readSessionCookie(request?.headers, resolveSessionSecret(options.secret), options.cookie?.name);
	const record = id ? await getSessionStore().read(id) : undefined;
	// A cookie whose record is gone (expired, swept, or revoked) is a signed-out
	// request, not an error: the browser drops it on the next write.
	const state: SessionState = record ? { id: record.id, data: record.data } : { id: null, data: {} };
	markSession(request, state);
	return state;
}

/**
 * Merge `patch` into the session's data, creating a session when the request
 * has none. Returns the new state plus the `Set-Cookie` when one was issued.
 */
export async function saveSession(
	ctx: unknown,
	patch: Record<string, unknown>,
): Promise<{ state: SessionState; cookie?: string }> {
	const current = await loadSession(ctx);
	const data = { ...current.data, ...patch };
	if (current.id) {
		await getSessionStore().write({ id: current.id, data, expiresAt: Date.now() + ttlMs() });
		const state: SessionState = { id: current.id, data };
		markSession((ctx as SessionHost).request, state);
		return { state };
	}
	return startSession(ctx, data);
}

/**
 * Replace the session's data wholesale. The only operation that can express a
 * DELETION (`saveSession` merges), so `session.forget(key)` goes through it.
 * A request with no session is a no-op: there is nothing to forget.
 */
export async function replaceSession(ctx: unknown, data: Record<string, unknown>): Promise<SessionState> {
	const current = await loadSession(ctx);
	if (!current.id) return current;
	await getSessionStore().write({ id: current.id, data, expiresAt: Date.now() + ttlMs() });
	const state: SessionState = { id: current.id, data };
	markSession((ctx as SessionHost).request, state);
	return state;
}

/**
 * Start a brand-new session carrying `data`, discarding any existing one.
 *
 * This is the LOGIN path: a fresh id means a session-fixation cookie planted
 * before sign-in is worthless afterwards.
 */
export async function startSession(
	ctx: unknown,
	data: Record<string, unknown> = {},
): Promise<{ state: SessionState; cookie: string }> {
	const current = await loadSession(ctx);
	if (current.id) await getSessionStore().destroy(current.id);

	const id = newSessionId();
	await getSessionStore().write({ id, data, expiresAt: Date.now() + ttlMs() });
	const state: SessionState = { id, data };
	markSession((ctx as SessionHost).request, state);

	const cookie = sessionSetCookie(signSessionId(id, resolveSessionSecret(options.secret)), cookieOptions());
	issueCookie(ctx, cookie);
	return { state, cookie };
}

/**
 * Rotate the session id, KEEPING the data. Call it on privilege changes that
 * are not a fresh login.
 */
export async function regenerateSession(ctx: unknown): Promise<{ state: SessionState; cookie: string }> {
	const current = await loadSession(ctx);
	return startSession(ctx, current.data);
}

/** Destroy the session and clear the cookie. Returns the clearing `Set-Cookie`. */
export async function destroySession(ctx: unknown): Promise<string> {
	const current = await loadSession(ctx);
	if (current.id) await getSessionStore().destroy(current.id);
	markSession((ctx as SessionHost).request, { id: null, data: {} });
	const cookie = clearSessionCookie(cookieOptions());
	issueCookie(ctx, cookie);
	return cookie;
}
