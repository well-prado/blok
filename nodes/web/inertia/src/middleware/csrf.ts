/**
 * `inertia.csrf` — the double-submit CSRF guard (#1012).
 *
 * ```ts
 * // src/Workflows.ts
 * export default { "inertia.csrf": await createCsrfMiddleware() };
 * setGlobalMiddleware(["inertia.shared", "inertia.csrf"]);
 * ```
 *
 * One step: the `@blokjs/csrf` node (in `@blokjs/helpers`, so it resolves in a
 * middleware chain the same way `@blokjs/throw` and `@blokjs/expr` do). The
 * node issues the `XSRF-TOKEN` cookie when the request arrives without one,
 * verifies `X-XSRF-TOKEN` (or the legacy `_token` body field) on every
 * POST/PUT/PATCH/DELETE, and throws the rejection — by default a `303` back to
 * the referring page carrying the expiry message in the signed flash cookie,
 * which `inertia.shared` reads back on the next request and the serializer puts
 * on `page.flash`. `onMismatch: "419"` swaps that for a raw `419` JSON body.
 *
 * ## Why the cookie does not go through the serializer
 *
 * Middleware runs BEFORE the page workflow, so there is no response to attach a
 * `Set-Cookie` to yet — and the answer may not come from the Inertia serializer
 * at all (a redirect, an error page, `@blokjs/respond`). The node therefore
 * calls `issueCsrfCookie(ctx, …)` (`@blokjs/shared`), which hangs a one-time
 * accessor on `ctx.response`: whatever the workflow finally assigns there gets
 * the pending `Set-Cookie` appended. A rejection never reaches `ctx.response`,
 * so the thrown error carries the same cookie itself.
 *
 * ## The `csrfToken` shared prop
 *
 * {@link createCsrfMiddleware} also registers `share("csrfToken", …)` (#1015),
 * so `usePage().props.csrfToken` is available for the legacy hidden-field
 * pattern (`<input type="hidden" name="_token" :value="csrfToken">`). The stock
 * client needs none of that — axios reads the cookie and sets the header by
 * itself — but a plain HTML `<form>` that never goes through Inertia does.
 */

import { node, step, workflow } from "@blokjs/core";
import {
	CSRF_COOKIE,
	CSRF_HEADER,
	type CsrfCookieOptions,
	csrfSecureFor,
	csrfSetCookie,
	csrfTokenOf,
	issueCsrfCookie,
	markCsrfToken,
	newCsrfToken,
} from "@blokjs/shared";
import { share } from "../shared.js";

/** The name `trigger.http.middleware` entries use. */
export const CSRF_MIDDLEWARE = "inertia.csrf";

/** Reserved step id this middleware claims in the workflow's flat namespace. */
export const CSRF_STEP_ID = "csrf";

export interface CsrfMiddlewareOptions {
	/** Workflow name, i.e. the chain entry. Default `inertia.csrf`. */
	name?: string;
	/** Cookie name. Default `XSRF-TOKEN` — what the stock client reads. */
	cookieName?: string;
	/** Header name. Default `X-XSRF-TOKEN` — what the stock client sends. */
	headerName?: string;
	/** Legacy body field accepted instead of the header. Default `_token`. */
	field?: string;
	/** Path globs exempt from verification, e.g. `["webhooks/*"]`. */
	except?: string[];
	/** `true` exempts non-Inertia requests (no `X-Inertia` header). Off by default. */
	apiExempt?: boolean;
	/** `"419"` returns the raw status instead of bouncing back with a flash. */
	onMismatch?: "redirect" | "419";
	/** Redirect target when the rejected request carried no `Referer`. Default `/`. */
	fallback?: string;
	/** Flash/error message. Default "The page expired, please try again.". */
	message?: string;
	/** Cookie `Path`. Default `/`. */
	path?: string;
	/** Cookie `SameSite`. Default `Lax`. */
	sameSite?: "Lax" | "Strict" | "None";
	/** Cookie `Max-Age` in seconds. Default: a session cookie. */
	maxAge?: number;
	/** Force `Secure`. Default: set when the request arrived over HTTPS. */
	secure?: boolean;
	/** Flash signing secret for the bounce-back. Defaults to `BLOK_FLASH_SECRET`. */
	secret?: string;
	/** `false` skips registering the `csrfToken` shared prop. */
	shareToken?: boolean;
}

/**
 * Build the `inertia.csrf` middleware workflow. `await` it once at
 * registration time (the callback DSL's `workflow()` is async).
 */
export function createCsrfMiddleware(opts: CsrfMiddlewareOptions = {}) {
	const { name = CSRF_MIDDLEWARE, shareToken = true, cookieName, ...rest } = opts;
	if (shareToken) share("csrfToken", (req: unknown) => csrfTokenOf(req, cookieName ?? CSRF_COOKIE));

	const inputs: Record<string, unknown> = {};
	if (cookieName !== undefined) inputs.cookieName = cookieName;
	for (const [key, value] of Object.entries(rest)) {
		if (value !== undefined) inputs[key] = value;
	}

	return workflow(name, { version: "1.0.0", middleware: true }, () => {
		// Ephemeral: the guard's verdict is not page data, and a `csrf` state slot
		// would collide with a page step of the same name (footgun 3).
		step(CSRF_STEP_ID, node<{ issued: boolean; verified: boolean; exempt: boolean }>("@blokjs/csrf"), inputs, {
			ephemeral: true,
		});
	});
}

/** Alias matching the registration examples. */
export const csrfMiddleware = createCsrfMiddleware;

/**
 * Rotate the token — call it on login and logout, from inside a node.
 *
 * A session boundary should not keep the pre-authentication token: an attacker
 * who fixed a victim's cookie before login would otherwise still know it
 * afterwards. The new cookie rides this request's response (same accessor the
 * middleware uses), so the very next write must carry the new value and a
 * replay of the old one is rejected.
 *
 * ```ts
 * async execute(ctx) {
 *   rotateCsrf(ctx);
 *   return logoutResponse(ctx);
 * }
 * ```
 *
 * Returns the new token, for a response that wants to hand it over directly.
 */
export function rotateCsrf(ctx: unknown, opts: CsrfCookieOptions = {}): string {
	const request = (ctx as { request?: unknown } | undefined)?.request;
	const token = newCsrfToken();
	issueCsrfCookie(ctx, csrfSetCookie(token, { ...opts, secure: opts.secure ?? csrfSecureFor(request) }));
	markCsrfToken(request, token);
	return token;
}

export { CSRF_COOKIE, CSRF_HEADER };
