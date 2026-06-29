import type { Context } from "@blokjs/shared";

const JS_PREFIX = "js/";

/**
 * Detailed resolution result. `threw` distinguishes "the `js/` expression
 * raised" (a real resolution failure — typo'd path, undefined access) from
 * "the key is legitimately absent / null". The idempotency path collapses both
 * to a cache miss, but the concurrency gate must NOT silently bypass a rate
 * limit just because the key expression threw — see {@link resolveConcurrencyKey}.
 */
export interface KeyResolution {
	key: string | null;
	threw: boolean;
}

/**
 * Core resolver shared by {@link resolveIdempotencyKey} and
 * {@link resolveConcurrencyKey}. Never throws — it reports failure via `threw`
 * so each caller picks its own fail-open / fail-fast policy.
 */
function resolveKey(rawKey: string | undefined, ctx: Context): KeyResolution {
	if (typeof rawKey !== "string" || rawKey.length === 0) return { key: null, threw: false };
	if (!rawKey.startsWith(JS_PREFIX)) return { key: rawKey, threw: false };

	const expr = rawKey.slice(JS_PREFIX.length);
	try {
		const fn = new Function("ctx", `"use strict"; return (${expr});`);
		const value = fn(ctx);
		if (value === null || value === undefined) return { key: null, threw: false };
		return { key: String(value), threw: false };
	} catch {
		return { key: null, threw: true };
	}
}

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
	return resolveKey(rawKey, ctx).key;
}

/**
 * Concurrency-gate variant: same resolution as {@link resolveIdempotencyKey},
 * but it preserves whether the key expression THREW so the gate can honor
 * `BLOK_MAPPER_MODE`. A throwing rate-limit key is a misconfiguration (or an
 * attacker probing for a bypass), so it must not silently disable the limit —
 * the gate fails fast in `strict` mode rather than falling open.
 */
export function resolveConcurrencyKey(rawKey: string | undefined, ctx: Context): KeyResolution {
	return resolveKey(rawKey, ctx);
}
