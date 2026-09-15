/**
 * The kit's middleware wiring (#1018).
 *
 * There is no new middleware SYSTEM here: `requireAuth` is `inertia.auth`
 * (#996) with the kit's redirect target filled in, and {@link authKitMiddleware}
 * is the four workflows an auth'd Inertia app registers, in the one order that
 * works.
 */

import {
	type AuthMiddlewareOptions,
	createAuthMiddleware,
	createCsrfMiddleware,
	createSharedMiddleware,
	encryptHistoryMiddleware,
} from "@blokjs/inertia";
import { createSessionMiddleware } from "@blokjs/session";
import { authOptions } from "./config.js";
import { currentUserNode } from "./nodes.js";

/** The name `trigger.http.middleware` entries use for the guard. */
export const AUTH_GUARD = "inertia.auth";

/**
 * The guest guard — `inertia.auth`, redirecting to `configureAuth`'s
 * `redirectAfterLogout` (default `/login`) unless told otherwise.
 *
 * ```ts
 * trigger: http.get("/dashboard", { middleware: [AUTH_GUARD] })
 * ```
 */
export function requireAuth(opts: AuthMiddlewareOptions = {}) {
	return createAuthMiddleware({ redirectTo: authOptions().redirectAfterLogout, ...opts });
}

/**
 * Every middleware the kit needs, keyed by name and IN ORDER.
 *
 * `inertia.session` has to run first (it fills `ctx.state.session`, which the
 * `auth` step reads); `inertia.csrf` runs after `inertia.shared` so a rejected
 * write can already flash; `inertia.encryptHistory` runs last, marking the
 * request so every page serialized afterwards carries `encryptHistory: true`.
 * `inertia.auth` is per-route, so it is registered but deliberately NOT in
 * {@link AUTH_KIT_CHAIN}.
 *
 * ```ts
 * // src/Workflows.ts
 * export default { ...(await authKitMiddleware()), ...myWorkflows };
 * setGlobalMiddleware(AUTH_KIT_CHAIN);
 * ```
 */
export async function authKitMiddleware(): Promise<Record<string, unknown>> {
	return {
		"inertia.session": await createSessionMiddleware(),
		"inertia.shared": await createSharedMiddleware({ currentUser: currentUserNode }),
		"inertia.csrf": await createCsrfMiddleware(),
		"inertia.encryptHistory": await encryptHistoryMiddleware(),
		"inertia.auth": await requireAuth(),
	};
}

/**
 * The GLOBAL chain, in order. `inertia.auth` is per-route and not in it.
 *
 * `inertia.encryptHistory` is what makes logout's `clearHistory` mean anything
 * (#1018 security review B3): without it the page object carries no
 * `encryptHistory`, nothing in the client's history is encrypted, and the key
 * rotation on sign-out rotates a key that was never protecting anything — the
 * signed-in pages behind the Back button stay readable in history state.
 * It runs AFTER `inertia.csrf` (a rejected write never reaches a page, so the
 * mark would be wasted work) and before any page step.
 */
export const AUTH_KIT_CHAIN = ["inertia.session", "inertia.shared", "inertia.csrf", "inertia.encryptHistory"] as const;
