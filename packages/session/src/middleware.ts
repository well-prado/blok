/**
 * `inertia.session` — load the session before anything else runs (#1018).
 *
 * One step, id `session`, whose output lands in `ctx.state.session` as
 * `{ id, data }`. `@blokjs/auth`'s `currentUser` reads the signed-in user id
 * from there, which is what makes `inertia.shared`'s `auth` step — and
 * therefore `inertia.auth`'s guest guard — work.
 *
 * ORDER MATTERS: this has to run before `inertia.shared`.
 *
 * ```ts
 * // src/Workflows.ts
 * export default {
 *   "inertia.session": await createSessionMiddleware(),
 *   "inertia.shared":  await createSharedMiddleware({ currentUser }),
 *   "inertia.csrf":    await createCsrfMiddleware(),
 * };
 * setGlobalMiddleware(["inertia.session", "inertia.shared", "inertia.csrf"]);
 * ```
 *
 * RESERVED STEP ID: `session`. Step ids are one flat namespace shared with the
 * page workflow, so a page step called `session` would overwrite this one.
 */

import { type Handle, step, workflow } from "@blokjs/core";
import { sessionLoadNode } from "./nodes.js";

/** The name `trigger.http.middleware` entries and `setGlobalMiddleware` use. */
export const SESSION_MIDDLEWARE = "inertia.session";

/** Reserved step id this middleware claims in the workflow's flat namespace. */
export const SESSION_STEP_ID = "session";

export interface SessionMiddlewareOptions {
	/** Workflow name, i.e. the chain entry. Default `inertia.session`. */
	name?: string;
}

/** The `ctx.request` slice the middleware reads. */
type RequestHandle = Handle<{ headers: Record<string, string> }>;

/**
 * Build the `inertia.session` middleware workflow. `await` it once at
 * registration time (the callback DSL's `workflow()` is async).
 */
export function createSessionMiddleware(opts: SessionMiddlewareOptions = {}) {
	const { name = SESSION_MIDDLEWARE } = opts;
	return workflow(name, { version: "1.0.0", middleware: true }, (entry) => {
		// Middleware declares no trigger, so the callback's entry handle is the
		// loose `TriggerHandle`; every request-shaped trigger funnels into
		// `ctx.request`, so this cast only NAMES the field we read.
		const req = entry as unknown as RequestHandle;
		step(SESSION_STEP_ID, sessionLoadNode, { headers: req.headers });
	});
}

/** Alias matching the registration examples. */
export const sessionMiddleware = createSessionMiddleware;
