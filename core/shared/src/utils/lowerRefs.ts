/**
 * lowerRefs — ADR 0001 Option C load-boundary lowering pass.
 *
 * The published/serialized IR carries STRUCTURAL handle references —
 * `{ $ref: { step, path } }` — so the canvas, JSON twin, and AI can derive
 * edges and catch dangling refs WITHOUT executing. The runtime, however, is
 * byte-identical to today: the {@link Mapper} only resolves `js/ctx....`
 * strings and raw `ctx.*` `when` strings. It has no idea what a `{$ref}` is —
 * it walks INTO the plain object and string-resolves the inner `step`/`path`
 * fields, never treating the node as a reference (verified by ADR 0001 probe
 * S1 + the falsification test).
 *
 * This pass bridges the two layers. It runs at the workflow LOAD BOUNDARY,
 * BEFORE the Mapper, and compiles every structural `{$ref}` into EXACTLY the
 * wire string today's engine already resolves. The Mapper stays untouched.
 *
 * Scope: the STEP-INPUTS, TRIGGER-ROOT, and TPL positions.
 *   - step input value: `"js/ctx.state.<root>" + path`
 *   - `path` mapping: string segment → `.seg`, numeric → `[n]`,
 *     empty `path: []` (whole-output ref) → `"js/ctx.state.<root>"`.
 *   - `{$tpl}` (#425): a ref embedded in a string → a `js/\`…${ctx.state…}…\``
 *     template literal; string/literal segments embedded as escaped text.
 *   - recurses into plain arrays/objects; lowers nested `{$ref}`/`{$tpl}`; leaves
 *     everything else (primitives, class instances, functions) untouched.
 *
 * Out of scope (separate tasks):
 *   - `branch.when` bare-ctx lowering → ADR 0004.
 *
 * Pure + deterministic — never mutates its input. Determinism keeps the
 * idempotency-cache key stable run-to-run (ADR 0001 "hash stability").
 */

/** The structural handle reference sentinel. */
export interface StructuralRef {
	$ref: {
		step: string;
		path?: (string | number)[];
	};
}

/**
 * Is `value` the reserved `{$ref}` sentinel — a single-key object whose only
 * key is `$ref` and whose `$ref.step` is a string?
 *
 * The single-key + string-step guard is what makes `$ref` safe to reserve:
 * a step-inputs object that legitimately carries unrelated data (even data
 * with the literal keys `step`/`path`) is NOT a ref and passes through
 * untouched. ADR 0001 confirmed no current workflow uses `$ref` as user data.
 */
function isStructuralRef(value: object): value is StructuralRef {
	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== "$ref") return false;
	const ref = (value as { $ref?: unknown }).$ref;
	return typeof ref === "object" && ref !== null && typeof (ref as { step?: unknown }).step === "string";
}

/**
 * The trigger/entry-handle sentinel. The callback `workflow()` mints the
 * trigger-payload handle (`req`) rooted at this pseudo-step (see
 * `core/runner/src/stepBuilder.ts:makeHandle("@trigger")`). It is NOT a real
 * step — the runner never writes `ctx.state["@trigger"]`; the trigger payload
 * lives at `ctx.request` (TriggerBase.createContext sets `ctx.state = {}`).
 * So a ref rooted here lowers to `js/ctx.request`, mirroring the existing
 * `$.req` proxy. Keep this string in sync with stepBuilder's sentinel.
 *
 * Scope: HTTP `req` → `ctx.request` only. Per-trigger entry handles for
 * event/job/msg/etc. roots are #336 (follow-up) — not built here.
 */
const TRIGGER_SENTINEL = "@trigger";

/** Valid JS identifier — same shape `$.ts`'s proxy encoder accepts for `.k`. */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Encode a single path segment into its wire-string suffix, mirroring
 * `unwrapProxies` (core/workflow-helper/src/proxy/$.ts) EXACTLY — three
 * branches, not two: numeric → `[n]`; valid JS identifier → `.k`; anything
 * else (dash, dot, space, leading digit on a string key) → `[${JSON.stringify(k)}]`.
 * The bracket-quote form is the only one that survives the Mapper's `js/...`
 * eval — `.fan-out` would parse as `fan - out`.
 */
function encodeSegment(seg: string | number): string {
	if (typeof seg === "number") return `[${seg}]`;
	if (IDENT_RE.test(seg)) return `.${seg}`;
	return `[${JSON.stringify(seg)}]`;
}

/**
 * Compile a `path` array into the wire-string suffix the Mapper resolves.
 * Empty path produces the empty suffix (whole-output ref).
 */
function encodePath(path: (string | number)[]): string {
	return path.map(encodeSegment).join("");
}

/**
 * Lower a single structural `{$ref}` into its `js/ctx.state.<root>...` wire
 * string.
 *
 * ponytail: `<root>` is `ref.step` LITERALLY for now. Resolving the root
 * against the target step's `as`/`spread`/`ephemeral` persistence (a ref to a
 * step that renamed its output with `as:` must point at the renamed slot) is
 * #327/#339's job. Until then a ref to an `as:`/`spread:` step lowers to the
 * step id, which won't be in `ctx.state`. Upgrade path: thread the workflow's
 * resolved step→state-key map into this pass.
 */
function refExpr(ref: StructuralRef): string {
	const suffix = encodePath(ref.$ref.path ?? []);
	// Trigger-root: the `@trigger` pseudo-step's payload lives at `ctx.request`,
	// NOT `ctx.state["@trigger"]` (the runner never populates that). Lower to
	// `ctx.request` + the same encoded path so `req.body.name` resolves.
	if (ref.$ref.step === TRIGGER_SENTINEL) {
		return `ctx.request${suffix}`;
	}
	const root = encodeSegment(ref.$ref.step); // `.fanOut` or `["fan-out"]`
	return `ctx.state${root}${suffix}`;
}

function lowerRef(ref: StructuralRef): string {
	return `js/${refExpr(ref)}`;
}

/**
 * The structural template sentinel (#425) — a single-key `{$tpl: [...]}` whose
 * segments alternate raw strings and `{$ref}` nodes (plus the occasional literal
 * non-string interpolation). Mirrors `tpl\`...\`` in `core/runner/src/stepBuilder.ts`.
 */
interface StructuralTpl {
	$tpl: unknown[];
}

function isStructuralTpl(value: object): value is StructuralTpl {
	const keys = Object.keys(value);
	return keys.length === 1 && keys[0] === "$tpl" && Array.isArray((value as { $tpl?: unknown }).$tpl);
}

/**
 * Lower a `{$tpl}` node to a `js/\`…${ctx.state…}…\`` template-literal string the
 * Mapper resolves (`return (\`…\`)`). String segments are embedded as literal text
 * (escaped for the backtick context); `{$ref}` segments become `${<refExpr>}` so
 * the value's native type drives the interpolation (number/0/false preserved by
 * JS template coercion — and falsy values are NOT dropped, unlike `||`-based code);
 * any other literal segment is escaped into the literal text.
 */
function lowerTpl(node: StructuralTpl): string {
	let body = "";
	for (const seg of node.$tpl) {
		if (seg !== null && typeof seg === "object" && isStructuralRef(seg)) {
			body += `\${${refExpr(seg)}}`;
		} else {
			body += escapeTemplateText(typeof seg === "string" ? seg : String(seg));
		}
	}
	return `js/\`${body}\``;
}

/** Escape the three chars that are special inside a backtick template literal. */
function escapeTemplateText(text: string): string {
	return text.replace(/[\\`$]/g, (c) => `\\${c}`);
}

/**
 * Recursively lower every structural `{$ref}` inside `value` to its wire
 * string. Pure — returns a NEW value, never mutates the input. Plain
 * objects/arrays are walked; everything else (primitives, class instances,
 * functions, null/undefined) passes through untouched.
 */
export function lowerRefs<T>(value: T): T {
	return lower(value) as T;
}

function lower(value: unknown): unknown {
	if (value === null || value === undefined || typeof value !== "object") {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map(lower);
	}

	// Plain object only — class instances (custom prototype) pass through.
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) {
		return value;
	}

	if (isStructuralRef(value)) {
		return lowerRef(value);
	}

	if (isStructuralTpl(value)) {
		return lowerTpl(value);
	}

	const out: Record<string, unknown> = {};
	for (const k of Object.keys(value)) {
		out[k] = lower((value as Record<string, unknown>)[k]);
	}
	return out;
}
