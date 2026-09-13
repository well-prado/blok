/**
 * `inertia.auth` — the guest guard (#996).
 *
 * Reads the `auth` state slot `inertia.shared` filled in and, when it carries
 * no `id`, short-circuits the chain with a REDIRECT rather than a 401: an
 * Inertia visit that gets a bare 401 has nothing to render, while a
 * `302 Location: /login` is a normal visit the client follows. (`@blokjs/throw`
 * gained `headers` in this same issue precisely so a middleware can do that;
 * the trigger's 303 safety net promotes the 302 on non-GET Inertia writes.)
 *
 * ```ts
 * // per route
 * trigger: http.get("/orders", { middleware: ["inertia.auth"] })
 * ```
 */

import { branch, node, step, workflow } from "@blokjs/core";

export interface AuthMiddlewareOptions {
	/** Where a guest is sent. Default `/login`. */
	redirectTo?: string;
	/** Workflow name, i.e. the chain entry. Default `inertia.auth`. */
	name?: string;
	/** HTTP status. Default 302 (the trigger promotes it to 303 where required). */
	status?: number;
}

/**
 * Build the `inertia.auth` middleware workflow. `await` it once at
 * registration time (the callback DSL's `workflow()` is async).
 */
export function createAuthMiddleware(opts: AuthMiddlewareOptions = {}) {
	const { redirectTo = "/login", name = "inertia.auth", status = 302 } = opts;
	return workflow(name, { version: "1.0.0", middleware: true }, () => {
		// ponytail: the guest test goes through `@blokjs/expr` rather than a
		// handle condition (`not(shared(currentUser, "auth").id)`) so it
		// OPTIONAL-CHAINS. A branch condition lowers to a bare
		// `ctx.state.auth.id` string evaluated with `new Function` — with
		// `inertia.shared` missing from the chain that is a TypeError and a 500,
		// instead of the redirect the author asked for. `shared()` (#995) IS the
		// typed read path everywhere the slot is known to exist — page workflows
		// read `auth` with it; it just cannot express the guard's own absence.
		const guest = step("inertiaGuest", node<boolean>("@blokjs/expr"), {
			expression: "!ctx.state.auth?.id",
		});
		branch("inertiaAuthGate", guest, {
			then: () => {
				step("inertiaAuthRedirect", node("@blokjs/throw"), {
					message: "Unauthenticated.",
					name: "Unauthenticated",
					code: status,
					headers: { Location: redirectTo },
				});
			},
		});
	});
}

/** Alias matching the issue's registration example. */
export const authMiddleware = createAuthMiddleware;
