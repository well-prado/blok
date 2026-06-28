import { JS_EXPR_TAG } from "../proxy/$";

/**
 * First-class comparators for `branch`/`switchOn`/`loop` conditions.
 *
 * `branch({ when })` is evaluated at runtime by the if-else node via a raw
 * `Function("ctx", …)` — it does NOT go through the Mapper. A `$` proxy used
 * as a truthiness condition also needs the same raw form.
 * These helpers read the proxy's raw path and emit plain `ctx.*` strings the
 * runtime evaluates directly.
 *
 * @example
 *   import { branch, eq, ne, gt, $ } from "@blokjs/helper";
 *
 *   branch({
 *     id: "route",
 *     when: eq($.req.method, "POST"),   // → 'ctx.request.method === "POST"'
 *     then: [ ... ],
 *     else: [ ... ],
 *   });
 *   // ne($.state.fetch.error, null) → 'ctx.state.fetch.error !== null'
 *   // gt($.state.count, 10)         → 'ctx.state.count > 10'
 *
 * Left/right may each be a `$` proxy path or a literal (string, number,
 * boolean, null). Proxy paths are normalized to their canonical ctx field
 * (`$.req`→`ctx.request`, `$.prev`→`ctx.response`, `$.vars`→`ctx.state`) so the
 * expression resolves against the real ctx regardless of the alias.
 */
export function eq(left: unknown, right: unknown): string {
	return cmp(left, "===", right);
}

/** Strict not-equal. `ne($.state.x, null)` → `ctx.state.x !== null`. */
export function ne(left: unknown, right: unknown): string {
	return cmp(left, "!==", right);
}

/** Greater-than. `gt($.state.count, 10)` → `ctx.state.count > 10`. */
export function gt(left: unknown, right: unknown): string {
	return cmp(left, ">", right);
}

/** Greater-than-or-equal. */
export function gte(left: unknown, right: unknown): string {
	return cmp(left, ">=", right);
}

/** Less-than. */
export function lt(left: unknown, right: unknown): string {
	return cmp(left, "<", right);
}

/** Less-than-or-equal. */
export function lte(left: unknown, right: unknown): string {
	return cmp(left, "<=", right);
}

/** Truthiness/negation helper. `not($.state.ready)` → `!(ctx.state.ready)`. */
export function not(value: unknown): string {
	return `!(${conditionToExpr(value)})`;
}

/** Convert a branch/loop condition value to the raw string those runtimes eval. */
export function conditionToExpr(value: unknown): string {
	const proxy = proxyToExpr(value);
	if (proxy) return proxy;
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? String(value);
}

function cmp(left: unknown, op: string, right: unknown): string {
	return `${operandToExpr(left)} ${op} ${operandToExpr(right)}`;
}

function operandToExpr(value: unknown): string {
	// A `$` proxy is a function carrying its raw `ctx.<path>` in JS_EXPR_TAG.
	// Read the tag directly so we get the bare path WITHOUT the `js/` prefix
	// (that prefix is only added by the proxy's toString/unwrapProxies, and it
	// would break the raw-ctx evaluation the if-else node performs).
	const proxy = proxyToExpr(value);
	if (proxy) return proxy;
	// Literal: JSON-encode so strings are quoted and number/bool/null are bare.
	return JSON.stringify(value) ?? String(value);
}

function proxyToExpr(value: unknown): string | undefined {
	if (typeof value !== "function") return undefined;
	const tag = (value as { [JS_EXPR_TAG]?: string })[JS_EXPR_TAG];
	return typeof tag === "string" ? canonicalizeCtxPath(tag) : undefined;
}

/**
 * Rewrite a proxy path's leading alias segment to the canonical ctx field.
 * The `$` proxy emits `ctx.req`/`ctx.prev`/`ctx.vars` verbatim, but the if-else
 * node evaluates against the real ctx whose canonical fields are
 * `request`/`response`/`state`. Only the leading segment is rewritten.
 */
function canonicalizeCtxPath(path: string): string {
	return path
		.replace(/^ctx\.req(?=\.|\[|$)/, "ctx.request")
		.replace(/^ctx\.prev(?=\.|\[|$)/, "ctx.response")
		.replace(/^ctx\.vars(?=\.|\[|$)/, "ctx.state");
}
