/**
 * `inertia.shared` — the middleware every Inertia page route runs first (#996).
 *
 * Two steps, both persisted to the parent ctx's flat state so page workflows
 * read them straight back:
 *
 * - `auth`  — whatever the app's own `currentUser` node returns.
 * - `flash` — the signed one-shot cookie, VERIFIED and CLEARED: its output
 *   carries `{ errors, bag, flash, preserveFragment }` for the render path to
 *   merge, plus the `cookie` (a `Max-Age=0` `Set-Cookie`) the response has to
 *   emit for "one-shot" to mean anything.
 *
 * Register it by name and put it in the global chain:
 *
 * ```ts
 * // src/Workflows.ts
 * export default { "inertia.shared": await createSharedMiddleware({ currentUser }) };
 * setGlobalMiddleware(["inertia.shared"]);
 * ```
 */

import { type Handle, node, step, workflow } from "@blokjs/core";
import { FLASH_COOKIE } from "@blokjs/shared";

/** The `ctx.request` slice the middleware reads. */
type RequestHandle = Handle<{ headers: Record<string, string> }>;

export interface SharedMiddlewareOptions {
	/**
	 * The app's own "who is logged in" node. Its output lands in `ctx.state.auth`
	 * and is expected to expose `id` (absent/undefined = guest, which is what
	 * {@link createAuthMiddleware} gates on). It is called with `{ headers }`;
	 * a node whose input schema does not declare `headers` simply strips it.
	 */
	currentUser: { name: string };
	/** Workflow name, i.e. the chain entry. Default `inertia.shared`. */
	name?: string;
	/** Flash cookie name. Must match whatever `redirectBack()` wrote. */
	cookieName?: string;
	/** Signing secret. Defaults to `BLOK_FLASH_SECRET` inside the node. */
	secret?: string;
}

/** Reserved step ids this middleware claims in the workflow's flat namespace. */
export const SHARED_STEP_IDS = ["auth", "flash"] as const;

/**
 * Build the `inertia.shared` middleware workflow.
 *
 * Async because the callback DSL's `workflow()` is — `await` it once at
 * registration time.
 */
export function createSharedMiddleware(opts: SharedMiddlewareOptions) {
	const { currentUser, name = "inertia.shared", cookieName = FLASH_COOKIE, secret } = opts;
	return workflow(name, { version: "1.0.0", middleware: true }, (entry) => {
		// The middleware declares no trigger (middleware never has one), so the
		// callback's entry handle is the loose `TriggerHandle`. Every
		// request-shaped trigger funnels into `ctx.request`, so the cast is
		// type-only — it names the two fields we actually read.
		const req = entry as unknown as RequestHandle;
		step("auth", currentUser, { headers: req.headers });
		step("flash", node("@blokjs/flash"), {
			op: "read",
			cookieHeader: req.headers.cookie,
			name: cookieName,
			...(secret !== undefined ? { secret } : {}),
		});
	});
}
