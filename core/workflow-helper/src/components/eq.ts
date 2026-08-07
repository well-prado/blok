/**
 * First-class comparators for `branch`/`switchOn`/`loop` conditions.
 *
 * `branch({ when })` is evaluated at runtime by the if-else node via a raw
 * `Function("ctx", …)` — it does NOT go through the Mapper. These helpers emit
 * plain `ctx.*` strings the runtime evaluates directly.
 *
 * @example
 *   import { branch, eq, ne, gt } from "@blokjs/helper";
 *
 *   branch({
 *     id: "route",
 *     when: eq("ctx.request.method", "POST"),   // → 'ctx.request.method === "POST"'
 *     then: [ ... ],
 *     else: [ ... ],
 *   });
 *   // ne("ctx.state.fetch.error", null) → 'ctx.state.fetch.error !== null'
 *   // gt("ctx.state.count", 10)         → 'ctx.state.count > 10'
 *
 * Left/right may each be a raw `ctx.*` path string or a literal (string,
 * number, boolean, null) — a string operand is treated as a path when it
 * starts with `ctx.`/`ctx[`, and as a literal otherwise. Path aliases
 * (`ctx.req`→`ctx.request`, `ctx.prev`→`ctx.response`, `ctx.vars`→`ctx.state`)
 * are normalized to the canonical field.
 */
export function eq(left: unknown, right: unknown): string {
	return cmp(left, "===", right);
}

/** Strict not-equal. `ne("ctx.state.x", null)` → `ctx.state.x !== null`. */
export function ne(left: unknown, right: unknown): string {
	return cmp(left, "!==", right);
}

/** Greater-than. `gt("ctx.state.count", 10)` → `ctx.state.count > 10`. */
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

/** Truthiness/negation helper. `not("ctx.state.ready")` → `!(ctx.state.ready)`. */
export function not(value: unknown): string {
	return `!(${conditionToExpr(value)})`;
}

/** Convert a branch/loop condition value to the raw string those runtimes eval. */
export function conditionToExpr(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? String(value);
}

function cmp(left: unknown, op: string, right: unknown): string {
	return `${operandToExpr(left)} ${op} ${operandToExpr(right)}`;
}

// ponytail: a string operand is a ctx path iff it looks like one (`ctx.` /
// `ctx[` prefix) — everything else, including any other string, is a JSON
// literal. This is the same convention branch.when raw strings already use
// (see analyzeBranchWhen in packages/cli/src/commands/migrate/refs.ts); it
// replaces the old `$`-proxy-vs-string type distinction with a naming
// convention. Upgrade path if that ever collides with a real literal that
// starts with "ctx.": none needed today — zero in-repo callers hit it.
function operandToExpr(value: unknown): string {
	if (typeof value === "string" && /^ctx[.[]/.test(value)) return canonicalizeCtxPath(value);
	return JSON.stringify(value) ?? String(value);
}

/**
 * Rewrite a path's leading alias segment to the canonical ctx field
 * (`ctx.req`→`ctx.request`, `ctx.prev`→`ctx.response`, `ctx.vars`→`ctx.state`).
 * Both forms already resolve at runtime (`ctx.req` is a real alias — see
 * `core/shared/src/types/Context.ts`); this just prefers the canonical spelling.
 */
function canonicalizeCtxPath(path: string): string {
	return path
		.replace(/^ctx\.req(?=\.|\[|$)/, "ctx.request")
		.replace(/^ctx\.prev(?=\.|\[|$)/, "ctx.response")
		.replace(/^ctx\.vars(?=\.|\[|$)/, "ctx.state");
}
