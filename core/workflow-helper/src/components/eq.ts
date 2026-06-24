import { JS_EXPR_TAG } from "../proxy/$";

/**
 * First-class equality for `branch`/`switchOn`/`loop` conditions.
 *
 * `branch({ when })` is evaluated at runtime by the if-else node via a raw
 * `Function("ctx", …)` — it does NOT go through the Mapper, so a `$` proxy
 * (`$.req.method`, which compiles to `"js/ctx.req.method"`) or a `$.`-prefixed
 * string never gets its `js/` prefix stripped and the condition silently
 * mis-evaluates. `eq()` sidesteps that footgun: it reads the proxy's raw path
 * and emits a plain `ctx.* === <literal>` string the runtime evaluates directly.
 *
 * @example
 *   import { branch, eq, $ } from "@blokjs/helper";
 *
 *   branch({
 *     id: "route",
 *     when: eq($.req.method, "POST"),   // → 'ctx.request.method === "POST"'
 *     then: [ ... ],
 *     else: [ ... ],
 *   });
 *
 * Left/right may each be a `$` proxy path or a literal (string, number,
 * boolean, null). Proxy paths are normalized to their canonical ctx field
 * (`$.req`→`ctx.request`, `$.prev`→`ctx.response`, `$.vars`→`ctx.state`) so the
 * expression resolves against the real ctx regardless of the alias.
 */
export function eq(left: unknown, right: unknown): string {
	return `${operandToExpr(left)} === ${operandToExpr(right)}`;
}

function operandToExpr(value: unknown): string {
	// A `$` proxy is a function carrying its raw `ctx.<path>` in JS_EXPR_TAG.
	// Read the tag directly so we get the bare path WITHOUT the `js/` prefix
	// (that prefix is only added by the proxy's toString/unwrapProxies, and it
	// would break the raw-ctx evaluation the if-else node performs).
	if (typeof value === "function") {
		const tag = (value as { [JS_EXPR_TAG]?: string })[JS_EXPR_TAG];
		if (typeof tag === "string") return canonicalizeCtxPath(tag);
	}
	// Literal: JSON-encode so strings are quoted and number/bool/null are bare.
	return JSON.stringify(value);
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
