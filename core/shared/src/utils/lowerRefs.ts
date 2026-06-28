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
 * Scope (this task — #416): the STEP-INPUTS and TPL positions only.
 *   - step input value: `"js/ctx.state.<root>" + path`
 *   - `path` mapping: string segment → `.seg`, numeric → `[n]`,
 *     empty `path: []` (whole-output ref) → `"js/ctx.state.<root>"`.
 *   - recurses into plain arrays/objects; lowers nested `{$ref}`; leaves
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
function lowerRef(ref: StructuralRef): string {
	const suffix = encodePath(ref.$ref.path ?? []);
	// Trigger-root: the `@trigger` pseudo-step's payload lives at `ctx.request`,
	// NOT `ctx.state["@trigger"]` (the runner never populates that). Lower to
	// `js/ctx.request` + the same encoded path so `req.body.name` resolves.
	if (ref.$ref.step === TRIGGER_SENTINEL) {
		return `js/ctx.request${suffix}`;
	}
	const root = encodeSegment(ref.$ref.step); // `.fanOut` or `["fan-out"]`
	return `js/ctx.state${root}${suffix}`;
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

	const out: Record<string, unknown> = {};
	for (const k of Object.keys(value)) {
		out[k] = lower((value as Record<string, unknown>)[k]);
	}
	return out;
}
