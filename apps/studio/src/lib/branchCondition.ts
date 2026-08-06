/**
 * Phase 5.3 — branch `when` structural editor: pure lowering/parsing, no
 * React.
 *
 * ADR 0004 (`specs/blok-vision/adr/0004-branch-when-lowering.md`) is the
 * frozen contract: `@blokjs/if-else` evaluates `when` as RAW JavaScript via
 * `Function("ctx", ...)`. Unlike step *inputs* (which use the `js/` mapper
 * prefix — see `upstreamSources.ts`), a branch condition must be a bare
 * `ctx.*` expression string. A `js/`-prefixed `when` typechecks and passes
 * WorkflowTestRunner but 500s at runtime, so every operand that reaches
 * `lowerCondition` is defensively stripped of that prefix.
 *
 * Negation format `!(<expr>)` (WITH parens) matches the real, already-shipped
 * lowering in `core/workflow-helper/src/components/eq.ts`'s `not()` and
 * `core/runner/src/stepBuilder.ts`'s `lowerCondition` — not the unparenthesized
 * `!expr` shorthand mentioned in passing elsewhere, which no runtime code
 * actually emits.
 */

export type Comparator = "===" | "!==" | ">" | ">=" | "<" | "<=";

export interface StructuredCondition {
	left: string;
	comparator?: Comparator;
	right?: string;
	negated?: boolean;
}

/** `"js/ctx.state.a"` → `"ctx.state.a"`. Leaves unprefixed input alone. */
export function stripJsPrefix(expr: string): string {
	return expr.startsWith("js/") ? expr.slice(3) : expr;
}

const CTX_EXPR_RE = /^ctx[.[]/;

function looksLikeCtxExpr(text: string): boolean {
	return CTX_EXPR_RE.test(text.trim());
}

/** True for JSON literal text: a number, `true`/`false`/`null`, or a `"..."` string. */
function isJsonLiteralText(text: string): boolean {
	if (text === "") return false;
	try {
		const parsed = JSON.parse(text);
		return parsed === null || typeof parsed === "number" || typeof parsed === "boolean" || typeof parsed === "string";
	} catch {
		return false;
	}
}

/**
 * Right-operand emission rule (deliberately conservative — see module doc):
 * a JSON literal or a `ctx.`/`ctx[`-looking expression is emitted verbatim;
 * anything else (a bare word like `active`) is JSON-quoted so it becomes a
 * valid string literal instead of a bare identifier that throws
 * `ReferenceError` at runtime.
 */
function lowerRightOperand(text: string): string {
	const right = stripJsPrefix(text).trim();
	if (isJsonLiteralText(right) || looksLikeCtxExpr(right)) return right;
	return JSON.stringify(right);
}

export function lowerCondition(c: StructuredCondition): string {
	const left = stripJsPrefix(c.left).trim();
	const base = c.comparator ? `${left} ${c.comparator} ${lowerRightOperand(c.right ?? "")}` : left;
	return c.negated ? `!(${base})` : base;
}

// === Parsing ===
//
// Best-effort round-trip of the simple shapes ONLY: a bare `ctx...`
// expression, a `!`-negated one, and `<expr> <comparator> <literal-or-expr>`
// (optionally negated as a whole). Anything with `&&`, `||`, `?` (ternary),
// a backtick (template literal), or `(`/`)` (a call, or grouping beyond the
// one optional outer negation) returns null — the UI falls back to the raw
// editor rather than risk silently rewriting a condition it can't represent.

const COMPLEX_SYNTAX_RE = /&&|\|\||\?|`|\(|\)/;
const COMPARATOR_RE = /(===|!==|>=|<=|>|<)/;

/** A bare `ctx...` expression — the only shape a structural left/no-comparator value may take. */
function isSimpleExpr(text: string): boolean {
	return looksLikeCtxExpr(text);
}

/**
 * A right operand is only safe to round-trip if `lowerRightOperand` would
 * reproduce it verbatim: a JSON literal or a `ctx...` expression. Anything
 * else — e.g. the bare keyword `undefined` (real case: `ctx.state['book-car']
 * !== undefined` in v05-travel-booking.json) or a single-quoted JS string
 * (real case: `ctx.request.body.event === 'connect'` in v07-ws-echo.json) —
 * would silently get JSON-quoted into a different value on save, so it's
 * rejected here rather than mis-parsed.
 */
function isSimpleRight(text: string): boolean {
	return isJsonLiteralText(text) || looksLikeCtxExpr(text);
}

/** Brackets and quotes balance across the whole text (guards against splitting inside a `ctx.state['a>b']`-style key). */
function isBalanced(text: string): boolean {
	let depth = 0;
	let inQuote: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inQuote) {
			if (ch === "\\") i++;
			else if (ch === inQuote) inQuote = null;
			continue;
		}
		if (ch === '"' || ch === "'") inQuote = ch;
		else if (ch === "[") depth++;
		else if (ch === "]") {
			depth--;
			if (depth < 0) return false;
		}
	}
	return depth === 0 && inQuote === null;
}

export function parseCondition(when: string): StructuredCondition | null {
	const trimmed = when.trim();
	if (trimmed === "") return null;

	let negated = false;
	let body = trimmed;
	const parenNegation = /^!\((.*)\)$/s.exec(trimmed);
	if (parenNegation) {
		negated = true;
		body = (parenNegation[1] ?? "").trim();
	} else if (trimmed.startsWith("!") && !trimmed.startsWith("!==")) {
		negated = true;
		body = trimmed.slice(1).trim();
	}
	if (body === "" || COMPLEX_SYNTAX_RE.test(body) || !isBalanced(body)) return null;

	const comparatorMatch = COMPARATOR_RE.exec(body);
	if (comparatorMatch) {
		const left = body.slice(0, comparatorMatch.index).trim();
		const right = body.slice(comparatorMatch.index + comparatorMatch[0].length).trim();
		if (!isSimpleExpr(left) || !isSimpleRight(right)) return null;
		return { left, comparator: comparatorMatch[0] as Comparator, right, ...(negated ? { negated } : {}) };
	}

	if (!isSimpleExpr(body)) return null;
	return { left: body, ...(negated ? { negated } : {}) };
}
