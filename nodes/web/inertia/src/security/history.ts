/**
 * History encryption and `clearHistory` — issue #1013.
 *
 * Three ways to ask for `encryptHistory` on a page object, in falling
 * precedence:
 *
 * 1. **per page** — the node's `encryptHistory` input (`encryptHistory()` /
 *    `encryptHistory(false)` spread into the step's inputs). An explicit
 *    `false` OPTS OUT of the two below; that is the whole point of the
 *    argument.
 * 2. **per request** — a mark left on the live `ctx` by
 *    {@link historyNode}, which is what the `inertia.encryptHistory`
 *    middleware runs. Middleware and the workflow it guards share one `ctx`
 *    (`TriggerBase.runMiddlewareChain`), so the mark reaches every page
 *    serialized later in that chain.
 * 3. **per app** — {@link configureHistory}, the adapter's `history` option
 *    block.
 *
 * `clearHistory` works the same way, minus the global default: nothing clears
 * history by default. {@link logoutResponse} sets the mark.
 *
 * The mark is a plain field on `ctx` (the pattern `TriggerBase` itself uses
 * for `_blokMiddlewareName`), NOT `ctx.state` / `ctx.vars` — a node must not
 * write those, and a history flag is request plumbing rather than step output.
 */

import { defineNode, step, workflow } from "@blokjs/core";
import { RESPOND_BRAND, type RespondEnvelope } from "@blokjs/shared";
import { z } from "zod";
import { type FlashPersistOptions, flashCookie } from "../flash.js";
import { redirect } from "../protocol.js";

// =============================================================================
// Adapter option — `history.encrypt`
// =============================================================================

/** The adapter's `history` option block. */
export interface HistoryOptions {
	/** Encrypt every history entry unless a page opts out. Default `false`. */
	encrypt: boolean;
}

let adapterHistory: HistoryOptions = { encrypt: false };

/**
 * Set the app-wide history defaults — the adapter's `history` option block.
 *
 * ```ts
 * configureHistory({ encrypt: true }); // every page: encryptHistory: true
 * ```
 *
 * Encryption needs `window.crypto.subtle`, which browsers expose only in a
 * secure context: HTTPS, or `localhost`. Over plain HTTP the client logs
 * "Encryption is not supported in this environment" and stores the page
 * UNENCRYPTED.
 */
export function configureHistory(options: Partial<HistoryOptions>): void {
	adapterHistory = { ...adapterHistory, ...options };
}

/** The current adapter-wide history defaults. */
export function historyOptions(): HistoryOptions {
	return { ...adapterHistory };
}

// =============================================================================
// Request-scoped marks
// =============================================================================

/** What a middleware (or `logoutResponse`) asked of this request's pages. */
export interface HistoryMarks {
	encrypt?: boolean;
	clear?: boolean;
}

/** A `ctx` carrying the marks. Structural, so this file needs no engine types. */
interface HistoryHost {
	_blokInertiaHistory?: HistoryMarks;
	request?: { method?: unknown };
}

/** Mark the live request so every page serialized after this call carries the flags. */
export function markHistory(ctx: unknown, marks: HistoryMarks): void {
	const host = ctx as HistoryHost;
	host._blokInertiaHistory = { ...host._blokInertiaHistory, ...marks };
}

/** The marks left on this request, `{}` when there are none. */
export function historyMarks(ctx: unknown): HistoryMarks {
	return { ...(ctx as HistoryHost)._blokInertiaHistory };
}

/**
 * Resolve the `encryptHistory` page flag: explicit input wins (including an
 * explicit `false`), then the request mark, then the adapter default.
 */
export function resolveEncryptHistory(ctx: unknown, input: boolean | undefined): boolean {
	if (input !== undefined) return input;
	return historyMarks(ctx).encrypt ?? adapterHistory.encrypt;
}

/** Resolve the `clearHistory` page flag: explicit input, else the request mark. */
export function resolveClearHistory(ctx: unknown, input: boolean | undefined): boolean {
	if (input !== undefined) return input;
	return historyMarks(ctx).clear ?? false;
}

// =============================================================================
// The marking node + the `inertia.encryptHistory` middleware
// =============================================================================

/**
 * Mark the request's history flags. One step, no output worth reading — it
 * exists so a MIDDLEWARE workflow can set `encryptHistory` for a whole route
 * group (Laravel's `inertia::encrypt` alias).
 */
export const historyNode = defineNode({
	name: "@blokjs/inertia.history",
	description:
		"Mark the current request so every Inertia page serialized after it carries encryptHistory / clearHistory.",
	input: z.object({
		encrypt: z.boolean().optional().describe("true encrypts every history entry produced by this request."),
		clear: z.boolean().optional().describe("true clears the client's history state on the next page."),
	}),
	output: z.object({ encrypt: z.boolean(), clear: z.boolean() }),

	async execute(ctx, input) {
		markHistory(ctx, input);
		const marks = historyMarks(ctx);
		return { encrypt: marks.encrypt ?? false, clear: marks.clear ?? false };
	},
});

/** The name `trigger.http.middleware` entries use. */
export const ENCRYPT_HISTORY_MIDDLEWARE = "inertia.encryptHistory";

/**
 * The `inertia.encryptHistory` middleware workflow — list it in a route's
 * `trigger.http.middleware` (or in the global chain) and every page that route
 * renders is encrypted client-side.
 *
 * ```ts
 * export default { "inertia.encryptHistory": encryptHistoryMiddleware(), ...  };
 * ```
 */
export function encryptHistoryMiddleware() {
	return workflow(ENCRYPT_HISTORY_MIDDLEWARE, { version: "1.0.0", middleware: true }, () => {
		step("encrypt-history", historyNode, { encrypt: true }, { ephemeral: true });
	});
}

// =============================================================================
// Logout
// =============================================================================

export interface LogoutOptions extends FlashPersistOptions {
	/** Where to send the browser after logging out. Default `/login`. */
	redirectTo?: string;
}

/**
 * The logout response: a redirect the browser CANNOT replay, plus the
 * `clearHistory` mark so the page the user lands on rotates the client's
 * history key and the pages behind the Back button stop being decryptable.
 *
 * The status is always `303` for an ordinary redirect (never `302`): logout is
 * a write, and a 302 makes the browser re-issue it with the original method.
 * A fragment target still answers `409` + `X-Inertia-Redirect`.
 *
 * The mark is request-scoped, so it lands on a page rendered LATER IN THE SAME
 * request (`logout` then a page step). To reach the page AFTER the redirect —
 * which is the normal case — the mark also rides the signed flash cookie
 * (#996), which `inertia.shared` reads back on the next request.
 */
export function logoutResponse(ctx: unknown, options: LogoutOptions = {}): RespondEnvelope {
	markHistory(ctx, { clear: true });
	const method = String((ctx as HistoryHost).request?.method ?? "POST");
	const env = redirect(options.redirectTo ?? "/login", { method });
	const redirected = env.status === 302 ? { ...env, status: 303 } : env;

	// ponytail: an app that never configured BLOK_FLASH_SECRET keeps the old
	// request-scoped-only behaviour rather than having its logout throw. The
	// cookie is an ADDITION here, not the security boundary — the boundary is
	// the client rotating its history key, which the mark already drives for a
	// page rendered in this same request.
	try {
		const cookie = flashCookie({ clearHistory: true }, options);
		return cookie ? { ...redirected, cookies: [...(redirected.cookies ?? []), cookie] } : redirected;
	} catch {
		return redirected;
	}
}

/** {@link logoutResponse} as a workflow step. */
export const logoutNode = defineNode({
	name: "@blokjs/inertia.logout",
	description: "Log out: a 303 redirect the browser cannot replay, plus the clearHistory mark for the next page.",
	input: z.object({
		redirectTo: z.string().optional().describe("Redirect target. Default '/login'."),
	}),
	output: z.object({
		[RESPOND_BRAND]: z.literal(true),
		body: z.unknown().optional(),
		status: z.number().optional(),
		contentType: z.string().optional(),
		headers: z.record(z.string()).optional(),
		cookies: z.array(z.string()).optional(),
	}),

	async execute(ctx, input): Promise<RespondEnvelope> {
		return logoutResponse(ctx, input);
	},
});
