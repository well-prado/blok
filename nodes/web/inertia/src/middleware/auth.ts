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

import { branch, defineNode, node, step, workflow } from "@blokjs/core";
import { z } from "zod";

/** Where the "this response is per-user" mark lives on the request. */
const PRIVATE_MARK = "_blokPrivateResponse";

/**
 * Mark this request's response as per-user: the page it renders must not be
 * stored by a shared cache or replayed from the browser's disk cache after
 * sign-out (#1018 security review H1).
 */
export function markPrivateResponse(ctx: unknown): void {
	const request = (ctx as { request?: Record<string, unknown> } | undefined)?.request;
	if (request && typeof request === "object") request[PRIVATE_MARK] = true;
}

/** Has something (the guest guard) marked this response as per-user? */
export function isPrivateResponse(ctx: unknown): boolean {
	const request = (ctx as { request?: Record<string, unknown> } | undefined)?.request;
	return request?.[PRIVATE_MARK] === true;
}

/**
 * The marking node. It exists so a MIDDLEWARE workflow can declare "everything
 * this route renders is private" — {@link createAuthMiddleware} runs it, and
 * the page serializer turns the mark into `Cache-Control: no-store` and
 * `Vary: …, Cookie`.
 */
export const privateResponseNode = defineNode({
	name: "@blokjs/inertia.private",
	description: "Mark the current request so the Inertia page it renders is never cached (no-store, Vary: Cookie).",
	input: z.object({}),
	output: z.object({ private: z.boolean() }),

	async execute(ctx) {
		markPrivateResponse(ctx);
		return { private: true };
	},
});

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
		// A guarded route's response is per-user by definition: no shared cache
		// may store it, and the browser must not replay it from disk after
		// sign-out. Marked BEFORE the gate so the guest redirect is covered too.
		step("inertiaPrivate", privateResponseNode, {}, { ephemeral: true });
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
