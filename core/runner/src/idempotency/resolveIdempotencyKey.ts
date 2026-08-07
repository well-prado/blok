import { unresolvableKeyShape } from "@blokjs/helper";
import type { Context } from "@blokjs/shared";

const JS_PREFIX = "js/";

/**
 * Thrown when a resolved-key field holds a string (or object) that is shaped
 * like an expression but is not one the runner can evaluate (#706).
 *
 * Before this error existed, such a value was taken as a LITERAL key: an
 * `idempotencyKey` of `"$.req.body.requestId"` became one constant cache entry
 * replayed to every caller for the full 24h TTL, and a `concurrencyKey` of the
 * same shape collapsed every tenant into a single bucket. Nothing failed, so
 * nothing was reported — strictly worse than the documented fail-open contract,
 * which at least skips the gate.
 */
export class UnresolvableKeyExpressionError extends Error {
	override readonly name = "UnresolvableKeyExpressionError";
	constructor(
		readonly field: string,
		readonly where: string,
		readonly rawKey: unknown,
		shape: string,
	) {
		super(
			[
				`[blok] \`${field}\` on ${where} is ${shape}, not something the runner can resolve: ${JSON.stringify(rawKey)}.`,
				"  A key is either a `js/` expression or a DELIBERATE literal. Taking this one as a literal would make it a CONSTANT shared by every run — one cache entry replayed to every caller, or one concurrency bucket for every tenant.",
				"  fix: write the `js/` form (e.g. `js/ctx.request.body.requestId`) or, in the @blokjs/core DSL, pass the typed handle. If you really meant a constant, drop the expression syntax.",
			].join("\n"),
		);
	}
}

/**
 * One guard for every resolved-key field. Call it wherever such a field is READ
 * — the runtime resolver below, plus the two trigger-config readers, which
 * would otherwise coerce a non-string key to `""` and silently disable the gate
 * entirely.
 *
 * @param where - human location, e.g. `step "charge"` or `trigger "http"`.
 */
export function assertResolvableKey(rawKey: unknown, field: string, where: string): void {
	const shape = unresolvableKeyShape(rawKey);
	if (shape) throw new UnresolvableKeyExpressionError(field, where, rawKey, shape);
}

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

/** Where a resolved-key field lives, for the error message. */
export interface KeySite {
	/** Config field name — `idempotencyKey`, `concurrencyKey`, `debounce.key`. */
	readonly field: string;
	/** Human location — `step "charge"`, `the trigger of workflow "orders"`. */
	readonly where: string;
}

/**
 * Core resolver shared by {@link resolveIdempotencyKey} and
 * {@link resolveConcurrencyKey}. Reports evaluation failure via `threw` so each
 * caller picks its own fail-open / fail-fast policy.
 *
 * It DOES throw {@link UnresolvableKeyExpressionError} for an expression-shaped
 * key it cannot evaluate (#706) — that is a misconfiguration, not a runtime
 * resolution failure, and there is no safe default: guessing "literal" turns the
 * key into a constant. One guard here covers all three call sites (step
 * `idempotencyKey`, trigger `concurrencyKey`, trigger `debounce.key`).
 */
function resolveKey(rawKey: unknown, ctx: Context, site: KeySite): KeyResolution {
	assertResolvableKey(rawKey, site.field, site.where);
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
 * Authors may write a literal string (`"static-key"`) OR a `js/...`
 * expression (`"js/ctx.request.body.requestId"`, or a typed handle in the
 * `@blokjs/core` DSL that lowers to that same string). This helper handles
 * both.
 *
 * Returns `null` when:
 * - the key is undefined / empty / not a string
 * - the `js/` expression evaluates to null/undefined
 * - the `js/` expression throws (treat as cache miss; the step still runs)
 *
 * A failed `js/` evaluation falls back to "no caching for this step on this
 * run", which is the safest interpretation. An expression-shaped key the runner
 * cannot resolve at all throws {@link UnresolvableKeyExpressionError} (#706) —
 * see {@link resolveKey}.
 *
 * @internal Used by `RunnerSteps` before consulting the idempotency cache.
 */
export function resolveIdempotencyKey(
	rawKey: unknown,
	ctx: Context,
	site: KeySite = { field: "idempotencyKey", where: "this step" },
): string | null {
	return resolveKey(rawKey, ctx, site).key;
}

/**
 * Concurrency-gate variant: same resolution as {@link resolveIdempotencyKey},
 * but it preserves whether the key expression THREW so the gate can honor
 * `BLOK_MAPPER_MODE`. A throwing rate-limit key is a misconfiguration (or an
 * attacker probing for a bypass), so it must not silently disable the limit —
 * the gate fails fast in `strict` mode rather than falling open.
 */
export function resolveConcurrencyKey(
	rawKey: unknown,
	ctx: Context,
	site: KeySite = { field: "concurrencyKey", where: "the trigger" },
): KeyResolution {
	return resolveKey(rawKey, ctx, site);
}
