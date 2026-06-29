/**
 * Structural edit ops on the workflow JSON IR (#406/#407/#412).
 *
 * Pure functions on the raw v2 workflow definition — no Zod, no React, no
 * dagre. They power the canvas write-path: a UI gesture clones the draft,
 * applies one op, and re-renders with `buildWorkflowDag(draft)`. Every op
 * operates on a `structuredClone` and RETURNS the mutated copy, so the input
 * is never touched.
 *
 * Step-kind discrimination is derived locally from the union keys (the same
 * discriminators `classifyStep` in workflowDag.ts uses) so this module does
 * NOT import from the read-only renderer:
 *
 *   branch.then / branch.else
 *   switch.cases[n].do / switch.default
 *   forEach.do
 *   loop.do
 *   tryCatch.try / tryCatch.catch / tryCatch.finally
 *
 * The arm-walk mirrors `WorkflowNormalizer.normalizeStepBlock` /
 * `assertNoDuplicateStepIds`: every nested sub-pipeline array is visited
 * recursively. Refs and inline `ui:{x,y}` ride along untouched as plain step
 * fields — no special handling needed (M3 canvas decision: refs are
 * `js/ctx.state...` strings, layout is inline `ui`).
 */

// === Narrowing helpers (local — mirror workflowDag.ts, kept private) ===

type Step = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSteps(value: unknown): Step[] | undefined {
	return Array.isArray(value) ? (value as Step[]) : undefined;
}

/**
 * Every sub-pipeline array reachable from a step, in renderer order. This is
 * the single source of truth for "which arms exist" — every traversal op
 * below funnels through it, so a new step kind only needs one edit here.
 *
 * Returns the live arrays (NOT copies) so callers can splice into them.
 */
function armArrays(step: Step): Step[][] {
	const arms: Step[][] = [];
	const push = (v: unknown) => {
		const arr = asSteps(v);
		if (arr) arms.push(arr);
	};
	if (isObject(step.branch)) {
		push(step.branch.then);
		push(step.branch.else);
	}
	if (isObject(step.switch)) {
		const cases = asSteps(step.switch.cases);
		if (cases) for (const c of cases) if (isObject(c)) push(c.do);
		push(step.switch.default);
	}
	if (isObject(step.forEach)) push(step.forEach.do);
	if (isObject(step.loop)) push(step.loop.do);
	if (isObject(step.tryCatch)) {
		push(step.tryCatch.try);
		push(step.tryCatch.catch);
		push(step.tryCatch.finally);
	}
	return arms;
}

// === Public types ===

export interface StepLocation {
	/** The step object itself. */
	step: Step;
	/** The live array the step lives in (top-level `steps` or a nested arm). */
	parentArray: Step[];
	/** Index of the step within `parentArray`. */
	index: number;
}

/** Identifies an insertion target: a named arm of a parent step, or top-level. */
export type InsertTarget = { topLevel: true } | { parentId: string; arm: ArmName; caseIndex?: number };

/** The named arms an insert/connect op can address. */
export type ArmName = "then" | "else" | "do" | "try" | "catch" | "finally" | "default" | "case";

// === Traversal ===

/**
 * Visit every step in the IR (top-level + all nested arms), depth-first,
 * calling `cb` for each. Mirrors `normalizeStepBlock`'s recursion. The visit
 * order is: a step, then each of its arms in renderer order (so a parent is
 * seen before its children). Mutating `parentArray` during the walk is the
 * caller's responsibility — the built-in ops clone first.
 */
export function walkSteps(
	ir: unknown,
	cb: (step: Step, parentArray: Step[], index: number, path: string) => void,
): void {
	const top = isObject(ir) ? asSteps(ir.steps) : undefined;
	if (!top) return;
	walkArray(top, cb, "steps");
}

function walkArray(
	arr: Step[],
	cb: (step: Step, parentArray: Step[], index: number, path: string) => void,
	path: string,
): void {
	for (let i = 0; i < arr.length; i++) {
		const step = arr[i];
		if (!isObject(step)) continue;
		cb(step, arr, i, `${path}[${i}]`);
		for (const arm of armArrays(step)) {
			walkArray(arm, cb, `${path}[${i}]:arm`);
		}
	}
}

/**
 * Find a step by id anywhere in the tree. Returns the live location (the
 * actual array + index) so callers can splice. `null` if no step has that id.
 *
 * Matches on `step.id` only — `as:` aliases are NOT ids and never collide with
 * an id (issue #412 edge case: id reused via `as:` is allowed).
 */
export function findStepLocation(ir: unknown, id: string): StepLocation | null {
	let found: StepLocation | null = null;
	walkSteps(ir, (step, parentArray, index) => {
		if (found === null && step.id === id) {
			found = { step, parentArray, index };
		}
	});
	return found;
}

/** Collect every `step.id` in the tree (for global-uniqueness checks). */
function collectIds(ir: unknown): Set<string> {
	const ids = new Set<string>();
	walkSteps(ir, (step) => {
		if (typeof step.id === "string") ids.add(step.id);
	});
	return ids;
}

// === Arm resolution (for insert) ===

/**
 * Resolve the live array an InsertTarget points at, creating empty arms on
 * demand so inserting into a not-yet-existing `else`/`default`/`finally`
 * works. Throws on a malformed target (unknown parent, wrong arm for the
 * parent's kind) — a clear error beats a silent mis-insert.
 */
function resolveTargetArray(ir: Step, target: InsertTarget): Step[] {
	if ("topLevel" in target) {
		const top = asSteps(ir.steps);
		if (top) return top;
		const created: Step[] = [];
		ir.steps = created;
		return created;
	}

	const loc = findStepLocation(ir, target.parentId);
	if (!loc) {
		throw new Error(`[irEditOps] insert target parent "${target.parentId}" not found`);
	}
	const parent = loc.step;
	const { arm } = target;

	const ensureArm = (container: Record<string, unknown>, key: string): Step[] => {
		const existing = asSteps(container[key]);
		if (existing) return existing;
		const created: Step[] = [];
		container[key] = created;
		return created;
	};

	if ((arm === "then" || arm === "else") && isObject(parent.branch)) {
		return ensureArm(parent.branch, arm);
	}
	if (arm === "do" && isObject(parent.forEach)) {
		return ensureArm(parent.forEach, "do");
	}
	if (arm === "do" && isObject(parent.loop)) {
		return ensureArm(parent.loop, "do");
	}
	if ((arm === "try" || arm === "catch" || arm === "finally") && isObject(parent.tryCatch)) {
		return ensureArm(parent.tryCatch, arm);
	}
	if (isObject(parent.switch)) {
		if (arm === "default") return ensureArm(parent.switch, "default");
		if (arm === "case") {
			const cases = asSteps(parent.switch.cases);
			const ci = target.caseIndex ?? 0;
			const c = cases?.[ci];
			if (!isObject(c)) {
				throw new Error(`[irEditOps] switch "${target.parentId}" has no case at index ${ci}`);
			}
			return ensureArm(c, "do");
		}
	}

	throw new Error(`[irEditOps] arm "${arm}" is not valid for step "${target.parentId}"`);
}

// === Edit ops ===

/**
 * Insert `newStep` at `index` into the target arm (top-level or a named arm of
 * a parent step). REJECTS a step whose id already exists anywhere in the tree
 * — this is the #412 write-path guard, mirroring the runner's load-time
 * `assertNoDuplicateStepIds` throw. Returns a new IR; input untouched.
 *
 * `index` is clamped to `[0, arm.length]` so an out-of-range index appends
 * rather than producing a sparse array.
 */
export function insertStep<T>(ir: T, target: InsertTarget, index: number, newStep: Step): T {
	const draft = structuredClone(ir) as Step;
	const newId = newStep.id;
	if (typeof newId === "string" && collectIds(draft).has(newId)) {
		throw new Error(
			`[irEditOps] duplicate id "${newId}": a step with this id already exists in the workflow — step ids must be globally unique across all arms (the runner throws at load time). Use nextId() to mint a fresh id, or \`as:\` to alias an existing one.`,
		);
	}
	const arm = resolveTargetArray(draft, target);
	const at = Math.max(0, Math.min(index, arm.length));
	arm.splice(at, 0, newStep);
	return draft as T;
}

/**
 * Remove the step with `id` from whichever arm owns it. The arm is left a
 * valid (possibly empty) array — never `undefined`. Throws if the id is not
 * found. Returns a new IR; input untouched.
 */
export function deleteStep<T>(ir: T, id: string): T {
	const draft = structuredClone(ir);
	const loc = findStepLocation(draft, id);
	if (!loc) {
		throw new Error(`[irEditOps] cannot delete: no step with id "${id}"`);
	}
	loc.parentArray.splice(loc.index, 1);
	return draft;
}

/**
 * Move the step with `id` to `newIndex` WITHIN its own arm. Cross-arm moves
 * are NOT supported here — they change the step's semantic scope (a `try` step
 * is not a `catch` step) and need a delete+insert with an explicit target.
 * `newIndex` is clamped to the arm bounds. Throws if the id is not found.
 * Returns a new IR; input untouched.
 *
 * ponytail: same-arm only; cross-arm = deleteStep + insertStep with a target.
 */
export function reorderStep<T>(ir: T, id: string, newIndex: number): T {
	const draft = structuredClone(ir);
	const loc = findStepLocation(draft, id);
	if (!loc) {
		throw new Error(`[irEditOps] cannot reorder: no step with id "${id}"`);
	}
	const { parentArray, index } = loc;
	// `index` came from findStepLocation, so the splice always yields one step.
	const moved = parentArray.splice(index, 1)[0] as Step;
	const at = Math.max(0, Math.min(newIndex, parentArray.length));
	parentArray.splice(at, 0, moved);
	return draft;
}

/**
 * Mint a globally-unique step id of the form `<kind>-<n>`. Walks the WHOLE
 * tree (every nested arm) and bumps the counter past any collision, so the
 * result is guaranteed not to clash with any existing id — matching the
 * runner's cross-arm uniqueness requirement. Pure read; does not mutate.
 */
export function nextId(ir: unknown, kind: string): string {
	const ids = collectIds(ir);
	const base = kind.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "step";
	let n = 1;
	let candidate = `${base}-${n}`;
	while (ids.has(candidate)) {
		n += 1;
		candidate = `${base}-${n}`;
	}
	return candidate;
}

/**
 * Validate that a `source → target` connection is legal: both steps must
 * exist and must live in the SAME arm (same `parentArray`). A cross-arm
 * connection is meaningless in this IR — sequencing is implied by array order
 * within an arm, so you cannot wire a `then`-arm step to an `else`-arm step.
 * Throws on violation. Returns the IR unchanged on success (connection is
 * structural adjacency, already implied by array position; this op is the
 * write-path GUARD the canvas calls before allowing a drag-connect).
 *
 * ponytail: no edge list to mutate — sequencing IS array order. This guards
 * the gesture; reordering is reorderStep's job. Full cross-arm move = TODO.
 */
export function connect<T>(ir: T, sourceId: string, targetId: string): T {
	const source = findStepLocation(ir, sourceId);
	const target = findStepLocation(ir, targetId);
	if (!source) throw new Error(`[irEditOps] connect: source step "${sourceId}" not found`);
	if (!target) throw new Error(`[irEditOps] connect: target step "${targetId}" not found`);
	if (source.parentArray !== target.parentArray) {
		throw new Error(
			`[irEditOps] connect: "${sourceId}" and "${targetId}" are in different arms — steps can only connect within the same sub-pipeline (sequencing is array order). To move a step across arms, delete it and insert into the target arm.`,
		);
	}
	return ir;
}

// === Rename + reference propagation (#408) ===

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the boundary-safe rewriter that turns every reference to `oldId` into a
 * reference to `newId`, inside any `ctx.state...` expression string.
 *
 * References in this IR are `js/ctx.state.<id>...` strings (no `{$ref}` objects).
 * A reference to `<oldId>` shows up as:
 *   - dot form    `ctx.state.<oldId>`  (optionally `js/`-prefixed, optionally a
 *                 trailing `.field…` path) — `<oldId>` must be a COMPLETE key.
 *   - bracket form `ctx.state["<oldId>"]` / `ctx.state['<oldId>']`.
 *   - loop counter `ctx.state.<oldId>Index` (a loop publishes its index at
 *                 `<id>Index`).
 *
 * TOKEN-BOUNDARY: in dot form, `<oldId>` matches ONLY when the next char ends
 * the key — `.` `[` `"` `'` `)` whitespace, an operator, or end-of-string — OR
 * it's the literal `Index` counter suffix. So renaming `old` rewrites
 * `state.old`, `state.old.x`, `state.oldIndex`, `state["old"]` but NEVER
 * `state.old2`, `state.oldFoo`, `state.olds`. A naive string replace would hit
 * those false positives — hence the explicit boundary class.
 */
function makeRefRewriter(oldId: string, newId: string): (s: string) => string {
	const o = escapeRegExp(oldId);
	// Dot form: ctx.state.<oldId>  — boundary is `Index` suffix, a key-ending
	// char, or end-of-string. The lookahead consumes nothing so the trailing
	// path / counter is preserved verbatim.
	const dot = new RegExp(`(ctx\\.state\\.)${o}(?=Index|[.\\[\\])"'\\s+\\-*/%<>=!&|,?:;}]|$)`, "g");
	// Bracket form: ctx.state["<oldId>"] or ctx.state['<oldId>'] (quote matched).
	const bracket = new RegExp(`(ctx\\.state\\[)(["'])${o}\\2(\\])`, "g");
	return (s: string) =>
		s.replace(dot, `$1${newId}`).replace(bracket, (_m, pre, q, post) => `${pre}${q}${newId}${q}${post}`);
}

/** Deep-rewrite every string in a value (objects/arrays/strings) in place. */
function rewriteDeep(value: unknown, rewrite: (s: string) => string): unknown {
	if (typeof value === "string") return rewrite(value);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) value[i] = rewriteDeep(value[i], rewrite);
		return value;
	}
	if (isObject(value)) {
		for (const k of Object.keys(value)) value[k] = rewriteDeep(value[k], rewrite);
		return value;
	}
	return value;
}

/**
 * Rename the step with `oldId` to `newId` and PROPAGATE the rename to every
 * reference site across the whole IR. Pure: clones the input, returns the copy.
 *
 * 1. The target step's `id` is rewritten.
 * 2. Every step's `inputs` is deep-rewritten (nested objects/arrays/strings).
 * 3. Step-level expression fields that can carry `js/ctx.state.<id>` refs:
 *    `branch.when`, `loop.while`, `forEach.in`, `switch.on`, each switch
 *    `case.when` (only when it references state — plain match literals are
 *    skipped), and the key sites `idempotencyKey` / `concurrencyKey` (#523).
 *
 * Boundary-safe (see `makeRefRewriter`): `<oldId>` matches only as a complete
 * `ctx.state` key (or its `Index` counter), never as a prefix of a longer id.
 *
 * Out-of-scope boundary: a TRIGGER-level `concurrencyKey` lives under the
 * workflow's `trigger` config, not in the step tree `walkSteps` traverses, so
 * it is NOT rewritten here. In practice a trigger concurrencyKey keys off
 * request data (`ctx.req...`), not a step output, so this is a non-issue.
 *
 * Throws if `oldId` is not found, or if `newId` already exists anywhere in the
 * tree (mirrors the #412 duplicate-id guard).
 *
 * Note: a step renamed via `as:`/`spread:` publishes under the as-name / spread
 * keys, NOT its id — so a boundary-safe rewrite of `state.<oldId>` correctly
 * finds nothing to change for those downstream refs. No special-casing.
 */
export function renameStep<T>(ir: T, oldId: string, newId: string): T {
	const draft = structuredClone(ir);
	const loc = findStepLocation(draft, oldId);
	if (!loc) {
		throw new Error(`[irEditOps] cannot rename: no step with id "${oldId}"`);
	}
	if (oldId === newId) return draft;
	if (collectIds(draft).has(newId)) {
		throw new Error(
			`[irEditOps] cannot rename to "${newId}": a step with this id already exists in the workflow — step ids must be globally unique across all arms (the runner throws at load time). Pick a fresh id or use nextId().`,
		);
	}

	loc.step.id = newId;

	const rewrite = makeRefRewriter(oldId, newId);
	// Rewrite a step-level field in place only if it's an expression STRING that
	// references state (skips plain literals — a switch case `when: "a"` is a
	// match value, not an expression, so it must be left alone).
	const rewriteExprField = (container: Record<string, unknown>, key: string) => {
		const v = container[key];
		if (typeof v === "string" && v.includes("ctx.state.")) container[key] = rewrite(v);
	};
	walkSteps(draft, (step) => {
		if (isObject(step.inputs)) rewriteDeep(step.inputs, rewrite);
		// branch.when / loop.while raw conditions (always expressions).
		if (isObject(step.branch) && typeof step.branch.when === "string") {
			step.branch.when = rewrite(step.branch.when);
		}
		if (isObject(step.loop) && typeof step.loop.while === "string") {
			step.loop.while = rewrite(step.loop.while);
		}
		// forEach.in iterable + switch.on discriminant: step-level expression
		// fields that live OUTSIDE inputs and can carry js/ctx.state.<id> refs.
		if (isObject(step.forEach)) rewriteExprField(step.forEach, "in");
		if (isObject(step.switch)) {
			rewriteExprField(step.switch, "on");
			// case `when` may be an expression OR a plain match literal — only
			// rewrite the ones that reference state (the includes-guard above).
			const cases = asSteps(step.switch.cases);
			if (cases) for (const c of cases) if (isObject(c)) rewriteExprField(c, "when");
		}
		// Key sites (#523): idempotencyKey / concurrencyKey can be js/ctx.state.<id>
		// refs. Both are step-level string fields when present.
		rewriteExprField(step, "idempotencyKey");
		rewriteExprField(step, "concurrencyKey");
	});

	return draft;
}
