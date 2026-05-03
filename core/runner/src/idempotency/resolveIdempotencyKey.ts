import type { Context } from "@blokjs/shared";

const JS_PREFIX = "js/";

/**
 * Resolve a step's `idempotencyKey` value against the live context.
 *
 * Authors may write a literal string (`"static-key"`) OR a `$ proxy`
 * expression that compiled to a `js/...` string at workflow-definition
 * time (`"js/ctx.req.body.requestId"` produced by `$.req.body.requestId`).
 * This helper handles both.
 *
 * Returns `null` when:
 * - the key is undefined / empty / not a string
 * - the `js/` expression evaluates to null/undefined
 * - the `js/` expression throws (treat as cache miss; the step still runs)
 *
 * The helper never throws — a failed key resolution falls back to "no
 * caching for this step on this run", which is the safest interpretation.
 *
 * @internal Used by `RunnerSteps` before consulting the idempotency cache.
 */
export function resolveIdempotencyKey(rawKey: string | undefined, ctx: Context): string | null {
	if (typeof rawKey !== "string" || rawKey.length === 0) return null;
	if (!rawKey.startsWith(JS_PREFIX)) return rawKey;

	const expr = rawKey.slice(JS_PREFIX.length);
	try {
		const fn = new Function("ctx", `"use strict"; return (${expr});`);
		const value = fn(ctx);
		if (value === null || value === undefined) return null;
		return String(value);
	} catch {
		return null;
	}
}
