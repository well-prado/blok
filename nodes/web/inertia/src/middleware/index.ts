/**
 * The Inertia middleware pack (#996) — `inertia.shared` and `inertia.auth`.
 *
 * These are ordinary Blok middleware workflows (`middleware: true`, run on the
 * parent ctx before the page workflow). They add no second middleware system:
 * register them by name and list them in `setGlobalMiddleware([...])` or a
 * route's `trigger.http.middleware`.
 *
 * RESERVED STEP IDS: `auth`, `flash` and `csrf`. Step ids are ONE flat
 * namespace shared with the page workflow (footgun 3), and middleware runs on
 * the same ctx — so a page step called `auth` would overwrite the shared user.
 */

export { authMiddleware, createAuthMiddleware } from "./auth.js";
export type { AuthMiddlewareOptions } from "./auth.js";
export {
	CSRF_COOKIE,
	CSRF_HEADER,
	CSRF_MIDDLEWARE,
	CSRF_STEP_ID,
	createCsrfMiddleware,
	csrfMiddleware,
	rotateCsrf,
} from "./csrf.js";
export type { CsrfMiddlewareOptions } from "./csrf.js";
export { SHARED_STEP_IDS, createSharedMiddleware } from "./shared.js";
export type { SharedMiddlewareOptions } from "./shared.js";
