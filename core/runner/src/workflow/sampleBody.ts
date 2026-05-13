/**
 * Sample-body inference for the Studio empty-state curl snippet.
 *
 * Generates a JSON payload shape that a workflow's HTTP trigger
 * would accept, so the "no runs yet" curl example on the workflow
 * detail page can show an example body that actually exercises the
 * workflow — instead of the previous `-d '{}'` which immediately
 * crashed every workflow that read from `ctx.request.body`.
 *
 * Two layers (B + A in the design discussion):
 *
 *   B. Static analysis. Walk every step's inputs + control-flow
 *      expressions, collect every `ctx.request.body.<path>` and
 *      `$.req.body.<path>` reference, and build a nested object
 *      mirroring those paths. Array shapes are inferred from
 *      `forEach.in` references — if a path feeds a forEach, it's
 *      an array, and references to `ctx.state.<asVar>.<sub>` inside
 *      the body translate back into element-shape fields.
 *
 *   A. Author override. If the workflow declares
 *      `trigger.http.examples.body: {...}`, that value wins
 *      verbatim and the static inference is skipped.
 *
 * Inference is best-effort and intentionally permissive — the
 * placeholder values are "string" everywhere, since the goal is to
 * produce a payload that satisfies the workflow's *shape*, not its
 * semantics. A workflow author who cares about value semantics
 * declares an explicit example.
 */

interface PlainObject {
	[key: string]: unknown;
}

function isPlainObject(value: unknown): value is PlainObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Path segment describing one step of descent through the inferred
 * body tree. `array: true` means the value at this key is an array;
 * the next segment (if any) describes a field on the array's
 * elements. Mirrors the way `forEach.in` + the `as` binding declare
 * "the body has an array here; each element has these fields."
 */
interface PathSegment {
	key: string;
	array: boolean;
}

/**
 * Result of running inference + override resolution.
 *
 * - `body`: the inferred or author-supplied payload object.
 * - `source`: `"author"` if the workflow declared an explicit
 *   `trigger.http.examples.body`, `"inferred"` if we synthesized it
 *   from step references, `"empty"` if there were no references and
 *   no override (fallback to `{}`).
 */
export interface InferredSample {
	body: unknown;
	source: "author" | "inferred" | "empty";
}

/**
 * Read author-declared examples from the workflow's trigger config.
 * Returns the raw body value (whatever the author wrote) when
 * `trigger.http.examples.body` is set.
 */
function readAuthorOverride(workflow: unknown): unknown | undefined {
	if (!isPlainObject(workflow)) return undefined;
	const trigger = workflow.trigger;
	if (!isPlainObject(trigger)) return undefined;
	const http = trigger.http;
	if (!isPlainObject(http)) return undefined;
	const examples = http.examples;
	if (!isPlainObject(examples)) return undefined;
	return examples.body;
}

const BODY_REF_RE = /(?:ctx\.req(?:uest)?\.body|\$\.req\.body)\.([A-Za-z_][\w.]*)/g;
const STATE_REF_RE = /(?:ctx\.state\.|\$\.state\.)([A-Za-z_]\w*)(?:\.([\w.]+))?/g;

/**
 * Extract dotted paths from a single string value. Handles both the
 * `js/ctx.request.body.X.Y` form (used by JS expressions) and the
 * `$.req.body.X.Y` form (the v2 DSL). Same regex matches both.
 *
 * Also resolves `ctx.state.<asVar>.X.Y` references against the
 * current scope's `as` bindings — these come from inside a `forEach`
 * or `loop` body and mean "field X.Y on the source array's elements."
 */
function extractRefs(value: string, scope: Map<string, PathSegment[]>): PathSegment[][] {
	const out: PathSegment[][] = [];

	for (const m of value.matchAll(BODY_REF_RE)) {
		const raw = m[1];
		if (!raw) continue;
		out.push(raw.split(".").map((key) => ({ key, array: false })));
	}

	for (const m of value.matchAll(STATE_REF_RE)) {
		const asVar = m[1];
		const subPath = m[2];
		if (!asVar) continue;
		const sourcePath = scope.get(asVar);
		if (!sourcePath) continue;
		const tail: PathSegment[] = subPath ? subPath.split(".").map((key) => ({ key, array: false })) : [];
		out.push([...sourcePath, ...tail]);
	}

	return out;
}

/**
 * Recursively scan ANY value for body references. Strings get the
 * regex treatment. Objects and arrays are walked. Anything else is
 * a no-op.
 *
 * When `markArray` is true, every top-level path collected from this
 * value is flagged as referring to an array (used for `forEach.in`).
 */
function scanValueForRefs(
	value: unknown,
	scope: Map<string, PathSegment[]>,
	out: PathSegment[][],
	markArray: boolean,
): void {
	if (typeof value === "string") {
		const refs = extractRefs(value, scope);
		for (const ref of refs) {
			if (markArray && ref.length > 0) {
				// Clone + mark the LAST segment as the array. e.g. if `in`
				// was `ctx.request.body.subscribers`, we want the
				// `subscribers` segment marked as array — its children
				// (added later from the forEach body) descend into the
				// element shape.
				const tail = ref[ref.length - 1];
				if (tail) {
					const cloned = ref.map((s, i) => (i === ref.length - 1 ? { key: s.key, array: true } : s));
					out.push(cloned);
					continue;
				}
			}
			out.push(ref);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) scanValueForRefs(v, scope, out, markArray);
		return;
	}
	if (isPlainObject(value)) {
		for (const v of Object.values(value)) scanValueForRefs(v, scope, out, markArray);
	}
}

/**
 * Look at a `forEach.in` value and return the body-path it references,
 * so we can register that path as the source array for the `as`
 * variable. Returns undefined if the expression doesn't resolve to a
 * single body path (e.g. an inline literal array, a state-derived
 * value, or a complex expression we can't statically resolve).
 */
function extractSinglePath(value: unknown, scope: Map<string, PathSegment[]>): PathSegment[] | undefined {
	if (typeof value !== "string") return undefined;
	const refs = extractRefs(value, scope);
	if (refs.length !== 1) return undefined;
	return refs[0];
}

/**
 * Walk a list of v2 steps + accumulate every body-path reference.
 * Handles every v2 control-flow kind by recursing into the relevant
 * sub-pipelines with an updated scope.
 */
function collectPaths(steps: unknown, scope: Map<string, PathSegment[]>, out: PathSegment[][]): void {
	if (!Array.isArray(steps)) return;

	for (const raw of steps) {
		if (!isPlainObject(raw)) continue;

		// Regular step inputs.
		if (raw.inputs !== undefined) {
			scanValueForRefs(raw.inputs, scope, out, false);
		}

		// Branch (condition + then/else).
		if (isPlainObject(raw.branch)) {
			const b = raw.branch;
			if (typeof b.when === "string") scanValueForRefs(b.when, scope, out, false);
			collectPaths(b.then, scope, out);
			collectPaths(b.else, scope, out);
			continue;
		}

		// ForEach (in + as + do).
		if (isPlainObject(raw.forEach)) {
			const f = raw.forEach;
			// The `in` expression — paths there are arrays.
			scanValueForRefs(f.in, scope, out, true);

			// Compute the source path for the `as` element scope. When the
			// `in` expression resolves to a single body path, future
			// `ctx.state.<asVar>.X` references inside the body get
			// rewritten back into `<sourceArrayPath>[].X`.
			const sourcePath = extractSinglePath(f.in, scope);
			const innerScope = new Map(scope);
			if (typeof f.as === "string" && sourcePath) {
				// Mark the source path's tail as an array so descendants
				// land inside the element shape.
				const arrayPath: PathSegment[] = sourcePath.map((s, i) => ({
					key: s.key,
					array: i === sourcePath.length - 1 ? true : s.array,
				}));
				innerScope.set(f.as, arrayPath);
			}
			collectPaths(f.do, innerScope, out);
			continue;
		}

		// Loop (while + do).
		if (isPlainObject(raw.loop)) {
			const l = raw.loop;
			if (typeof l.while === "string") scanValueForRefs(l.while, scope, out, false);
			collectPaths(l.do, scope, out);
			continue;
		}

		// Switch (on + cases + default).
		if (isPlainObject(raw.switch)) {
			const s = raw.switch;
			scanValueForRefs(s.on, scope, out, false);
			if (Array.isArray(s.cases)) {
				for (const c of s.cases) {
					if (!isPlainObject(c)) continue;
					scanValueForRefs(c.when, scope, out, false);
					collectPaths(c.do, scope, out);
				}
			}
			collectPaths(s.default, scope, out);
			continue;
		}

		// TryCatch (try + catch + finally). Last kind in the loop body,
		// so no `continue` needed.
		if (isPlainObject(raw.tryCatch)) {
			const tc = raw.tryCatch;
			collectPaths(tc.try, scope, out);
			collectPaths(tc.catch, scope, out);
			collectPaths(tc.finally, scope, out);
		}
	}
}

/**
 * Build a nested JSON value from the collected path segments. Each
 * path adds one branch to the tree. Array segments become `[{...}]`
 * containers; scalar leaves become the literal string `"string"`.
 *
 * Merging is conservative — a path that ends at a leaf where an
 * object already exists doesn't overwrite the object (a leaf is
 * "we know this exists" not "this is a primitive"); a path that
 * descends through a key currently set to `"string"` upgrades it
 * to an object.
 */
function buildTreeFromPaths(paths: readonly PathSegment[][]): PlainObject {
	const root: PlainObject = {};

	for (const path of paths) {
		if (path.length === 0) continue;
		setPath(root, path);
	}

	return root;
}

function setPath(root: PlainObject, path: PathSegment[]): void {
	// Cursor that "node" walks. At each step it either steps into an
	// object's key or into an array element.
	let node: PlainObject = root;

	for (let i = 0; i < path.length; i++) {
		const seg = path[i];
		if (!seg) continue;
		const isLast = i === path.length - 1;
		const existing = node[seg.key];

		if (seg.array) {
			// The value at this key must be an array; descend into its
			// (single) element so further segments add to the element's
			// shape.
			let arr: unknown[];
			if (Array.isArray(existing)) {
				arr = existing;
			} else {
				arr = [];
				node[seg.key] = arr;
			}
			if (arr.length === 0) arr.push({});
			let elem = arr[0];
			if (!isPlainObject(elem)) {
				elem = {};
				arr[0] = elem;
			}
			if (isLast) {
				// `subscribers` referenced as the WHOLE array — no further
				// segment to add. Leave the element as `{}`.
				return;
			}
			node = elem as PlainObject;
			continue;
		}

		if (isLast) {
			if (existing === undefined) {
				node[seg.key] = "string";
			}
			// Already an object/array → leave it; "string" → leave it.
			return;
		}

		// Non-terminal scalar key — descend into the (possibly new) object.
		if (existing === undefined || existing === "string") {
			node[seg.key] = {};
		}
		const next = node[seg.key];
		if (!isPlainObject(next)) {
			// Existing value is an array or other shape we can't descend
			// into via a scalar key — bail out for this path.
			return;
		}
		node = next;
	}
}

/**
 * Infer a sample HTTP body for a workflow, or return the author's
 * declared example. Returns `null` only when the workflow value is
 * not a recognisable object — every other shape gets at least an
 * `empty` result with `body: {}`.
 *
 * @param workflow The raw workflow JSON (the same value the
 *   `WorkflowRegistry` stores). Accepts `unknown` because the API
 *   surface that calls this — `TraceRouter` — keeps `definition`
 *   typed loosely.
 */
export function inferSampleBody(workflow: unknown): InferredSample | null {
	if (!isPlainObject(workflow)) return null;

	const override = readAuthorOverride(workflow);
	if (override !== undefined) {
		return { body: override, source: "author" };
	}

	const paths: PathSegment[][] = [];
	collectPaths(workflow.steps, new Map(), paths);

	if (paths.length === 0) {
		return { body: {}, source: "empty" };
	}

	return { body: buildTreeFromPaths(paths), source: "inferred" };
}
