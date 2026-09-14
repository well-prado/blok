/**
 * The session nodes (#1018) — `session.get` / `set` / `forget` / `regenerate`,
 * plus the `session.load` step the `inertia.session` middleware runs.
 *
 * Canonical `use:` refs are `@blokjs/session.<op>`, matching the
 * `@blokjs/inertia.logout` / `@blokjs/inertia.history` precedent. Register them
 * in the app's `Nodes.ts`:
 *
 * ```ts
 * import { SESSION_NODES } from "@blokjs/session";
 * export default { ...SESSION_NODES, ...myNodes };
 * ```
 *
 * None of them writes `ctx.state` or `ctx.vars`: each returns its output and
 * the runner persists it, exactly like any other node.
 */

import { defineNode } from "@blokjs/core";
import { z } from "zod";
import {
	destroySession,
	loadSession,
	regenerateSession,
	replaceSession,
	saveSession,
	startSession,
} from "./session.js";

/** The shape every session node reports: the id (or `null`) and the stored data. */
const stateSchema = z.object({
	id: z.string().nullable().describe("The session id, or null when the request has no session."),
	data: z.record(z.unknown()).describe("The stored session data. {} when there is no session."),
});

/**
 * `session.load` — read the signed cookie and the store, once per request.
 *
 * This is what the `inertia.session` middleware runs; its output lands in
 * `ctx.state.session`, which is where `@blokjs/auth`'s `currentUser` reads the
 * signed-in user id from.
 */
export const sessionLoadNode = defineNode({
	name: "@blokjs/session.load",
	description: "Load the current session from the signed cookie into ctx.state.session.",
	input: z.object({
		headers: z.record(z.unknown()).optional().describe("Request headers. Defaults to ctx.request.headers."),
	}),
	output: stateSchema,

	async execute(ctx) {
		return loadSession(ctx);
	},
});

/** `session.get` — the whole session data, or one key's value. */
export const sessionGetNode = defineNode({
	name: "@blokjs/session.get",
	description: "Read the current session: the whole data bag, or the value at `key`.",
	input: z.object({
		key: z.string().optional().describe("Read a single key instead of the whole bag."),
	}),
	output: z.object({
		id: z.string().nullable(),
		data: z.record(z.unknown()),
		value: z.unknown().describe("The value at `key`, or undefined. Always undefined when no `key` was given."),
	}),

	async execute(ctx, input) {
		const state = await loadSession(ctx);
		return { ...state, value: input.key === undefined ? undefined : state.data[input.key] };
	},
});

/**
 * `session.set` — merge values into the session.
 *
 * Creates a session (and issues the cookie) when the request has none, so a
 * guest flow that stashes an intended URL works without a login first.
 */
export const sessionSetNode = defineNode({
	name: "@blokjs/session.set",
	description: "Merge values into the session, creating one (and its cookie) when the request has none.",
	input: z.object({
		key: z.string().optional().describe("Single key to write. Use `data` to write several at once."),
		value: z.unknown().optional().describe("Value for `key`."),
		data: z.record(z.unknown()).optional().describe("Several keys at once, merged over the existing data."),
	}),
	output: stateSchema.extend({
		cookie: z.string().optional().describe("The Set-Cookie emitted when a NEW session was created."),
	}),

	async execute(ctx, input) {
		const patch: Record<string, unknown> = { ...input.data };
		if (input.key !== undefined) patch[input.key] = input.value;
		if (Object.keys(patch).length === 0) {
			throw new Error("@blokjs/session.set: pass `key` (with `value`) or `data` — there is nothing to write.");
		}
		const { state, cookie } = await saveSession(ctx, patch);
		return { ...state, ...(cookie ? { cookie } : {}) };
	},
});

/**
 * `session.forget` — drop one key, or the whole session.
 *
 * With `key`, it removes that entry (Laravel's `forget`). Without one it
 * DESTROYS the session and returns the clearing cookie (Laravel's `flush` +
 * `invalidate`), which is what `@blokjs/auth`'s logout uses.
 */
export const sessionForgetNode = defineNode({
	name: "@blokjs/session.forget",
	description: "Remove one key from the session, or destroy the whole session when no key is given.",
	input: z.object({
		key: z.string().optional().describe("Key to remove. Omit to destroy the entire session."),
	}),
	output: stateSchema.extend({
		cookie: z.string().optional().describe("The clearing Set-Cookie, emitted when the session was destroyed."),
	}),

	async execute(ctx, input) {
		if (input.key === undefined) {
			const cookie = await destroySession(ctx);
			return { id: null, data: {}, cookie };
		}
		const current = await loadSession(ctx);
		if (!current.id || !(input.key in current.data)) return current;
		const data = { ...current.data };
		// `delete`, not `= undefined`: the key must be ABSENT from the stored bag,
		// because `"key" in data` is what the next read checks.
		delete data[input.key];
		// Replace rather than merge — `saveSession` cannot express a deletion.
		return replaceSession(ctx, data);
	},
});

/**
 * `session.regenerate` — a fresh session id carrying the same data.
 *
 * The anti-session-fixation step: a cookie an attacker planted before sign-in
 * names a session that no longer exists. `@blokjs/auth`'s login calls it.
 */
export const sessionRegenerateNode = defineNode({
	name: "@blokjs/session.regenerate",
	description: "Rotate the session id, keeping the data. Issues the new signed cookie.",
	input: z.object({
		fresh: z.boolean().optional().describe("true starts an EMPTY session instead of carrying the data over."),
	}),
	output: stateSchema.extend({ cookie: z.string().describe("The Set-Cookie carrying the new session id.") }),

	async execute(ctx, input) {
		const { state, cookie } = input.fresh === true ? await startSession(ctx, {}) : await regenerateSession(ctx);
		return { ...state, cookie };
	},
});

/** Every session node, keyed by its canonical `use:` ref — spread into `Nodes.ts`. */
export const SESSION_NODES = {
	"@blokjs/session.load": sessionLoadNode,
	"@blokjs/session.get": sessionGetNode,
	"@blokjs/session.set": sessionSetNode,
	"@blokjs/session.forget": sessionForgetNode,
	"@blokjs/session.regenerate": sessionRegenerateNode,
} as const;
