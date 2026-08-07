/**
 * refSyntax — the reference vocabulary shared by the schema-aware `$ref`
 * validator (#691).
 *
 * The workflow IR carries step-output references in two forms and this module
 * recognises both:
 *
 * - **Structural** — `{$ref: {step, path}}` and `{$tpl: [...]}` (ADR 0001
 *   Option C), minted by the typed-handle DSL and by Studio.
 * - **Wire strings** — what `lowerRefs` compiles those into, and what JSON
 *   workflows are hand-authored with: `js/ctx.state.<id>.<field>`,
 *   `${ctx.state...}` interpolations, and the bare-ctx `branch.when` form.
 *
 * **Kept in sync by hand with `core/shared/src/utils/lowerRefs.ts`** — the
 * canonical encoder. `@blokjs/helper` deliberately does not depend on
 * `@blokjs/shared` (it is the light authoring package, and this module must
 * stay importable by the Studio browser bundle), so the two sentinels and the
 * segment grammar are mirrored here rather than imported. Same pattern the
 * Studio canvas already uses for `encodeSegment`.
 */

/** The structural handle reference sentinel — mirrors `lowerRefs.StructuralRef`. */
export interface StructuralRef {
	$ref: {
		step: string;
		path?: (string | number)[];
	};
}

/** The structural template sentinel (#425) — alternating strings and `{$ref}`. */
export interface StructuralTpl {
	$tpl: unknown[];
}

/** The trigger entry-handle pseudo-step. Lowers to `ctx.request`, not state. */
export const TRIGGER_SENTINEL = "@trigger";

/** The tryCatch error-handle pseudo-step. Lowers to `ctx.error`, not state. */
export const ERROR_SENTINEL = "@error";

/** Single-key `{$ref}` object whose `$ref.step` is a string. */
export function isStructuralRef(value: object): value is StructuralRef {
	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== "$ref") return false;
	const ref = (value as { $ref?: unknown }).$ref;
	return typeof ref === "object" && ref !== null && typeof (ref as { step?: unknown }).step === "string";
}

/** Single-key `{$tpl: [...]}` object. */
export function isStructuralTpl(value: object): value is StructuralTpl {
	const keys = Object.keys(value);
	return keys.length === 1 && keys[0] === "$tpl" && Array.isArray((value as { $tpl?: unknown }).$tpl);
}

/** Render a ref path the way an author wrote it: `items[0].sku`. */
export function renderRefPath(path: readonly (string | number)[]): string {
	let out = "";
	for (const seg of path) {
		if (typeof seg === "number") out += `[${seg}]`;
		else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) out += out.length === 0 ? seg : `.${seg}`;
		else out += `[${JSON.stringify(seg)}]`;
	}
	return out;
}

/** A state read recovered from an expression string. */
export interface ParsedRef {
	/** The `ctx.state.<root>` key. */
	readonly root: string;
	/**
	 * Statically-readable field path under the root. A chain cut short by a
	 * dynamic index (`ctx.state.a[k].b`) or a method call is TRUNCATED, never
	 * extended — truncation checks less, it never invents a field.
	 */
	readonly path: readonly (string | number)[];
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*/;

/**
 * Consume the `.field` / `[0]` / `["key"]` chain starting at `pos`, tolerating
 * optional chaining (`?.`). Returns the parsed segments and where it stopped.
 */
function consumeSegments(code: string, pos: number): { path: (string | number)[]; end: number } {
	const path: (string | number)[] = [];
	let i = pos;
	for (;;) {
		let j = i;
		if (code.startsWith("?.", j)) j += 2;

		if (code[j] === ".") {
			const rest = code.slice(j + 1);
			const m = IDENT.exec(rest);
			if (!m) break;
			path.push(m[0]);
			i = j + 1 + m[0].length;
			continue;
		}
		if (code[j] === "[") {
			const close = code.indexOf("]", j);
			if (close === -1) break;
			const inner = code.slice(j + 1, close).trim();
			if (/^\d+$/.test(inner)) {
				path.push(Number(inner));
			} else if (/^"(?:[^"\\]|\\.)*"$/.test(inner) || /^'(?:[^'\\]|\\.)*'$/.test(inner)) {
				try {
					path.push(JSON.parse(inner.startsWith("'") ? `"${inner.slice(1, -1).replace(/"/g, '\\"')}"` : inner));
				} catch {
					break;
				}
			} else {
				// Dynamic index (`ctx.state[k]`) — not statically provable.
				break;
			}
			i = close + 1;
			continue;
		}
		break;
	}
	return { path, end: i };
}

/**
 * Match a state ROOT where it genuinely starts an expression (not
 * `req.body.state`). Only the roots the Mapper actually puts in scope count: it
 * compiles `Function("ctx", "data", "func", "vars", …)`, so `ctx.state`,
 * `ctx.vars` and a bare `vars` resolve — a bare `state` is a ReferenceError and
 * is deliberately NOT matched. The leading capture group keeps this
 * lookbehind-free for older JS engines.
 */
const STATE_ROOT = /(^|[^\w$.])(ctx\s*\.\s*(?:state|vars)|vars)(?![\w$])/g;

/**
 * Extract every statically-provable state read from a string.
 *
 * Deliberately syntax-agnostic: it scans for state member chains wherever they
 * appear, so ONE rule covers all of `js/ctx.state.a.b`, the `${ctx.state.a.b}`
 * interpolation, the bare-ctx `branch.when` / `loop.while` form (ADR 0004), and
 * a node whose input IS plain JS by contract (`@blokjs/expr`'s `expression`).
 * No per-site or per-node special casing.
 *
 * A plain data string is not at risk: a diagnostic only fires when the scanned
 * root ALSO names a real producing step in the same workflow. Free-text fields
 * (`ui`, `description`) are excluded by the caller so a human note mentioning
 * `ctx.state.x` can never masquerade as a reference.
 */
export function parseCtxExpression(value: string): ParsedRef[] {
	if (!value.includes("ctx.") && !value.includes("vars")) return [];
	const out: ParsedRef[] = [];
	STATE_ROOT.lastIndex = 0;
	let m = STATE_ROOT.exec(value);
	while (m !== null) {
		const prefix = m[1] ?? "";
		const start = m.index + prefix.length + (m[2]?.length ?? 0);
		const { path, end } = consumeSegments(value, start);
		// A trailing `(` means the last segment was a METHOD CALL, not a field
		// (`ctx.state.rows.filter(...)`). Drop it — walking `filter` against the
		// producer's schema would invent an error out of ordinary JavaScript.
		if (/^\s*\(/.test(value.slice(end))) path.pop();
		const root = path[0];
		if (typeof root === "string") {
			// The chain is statically readable even inside a bigger expression, so
			// the fields ARE checkable.
			out.push({ root, path: path.slice(1) });
		}
		m = STATE_ROOT.exec(value);
	}
	return out;
}
