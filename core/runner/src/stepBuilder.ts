/**
 * The handle-DSL authoring runtime (issue #421) — typed `step()`, the
 * callback-style `workflow()` overload, the `{$ref}`-recording handle Proxy,
 * and the `AsyncLocalStorage` builder stack from ADR 0003.
 *
 * This lives in `core/runner` (NOT `core/workflow-helper`) because `step()`
 * references a node's TS type + `Handle<OutputOf<node>>` from `./handles`, and
 * runner depends on helper — helper cannot depend on runner. This module is the
 * eventual `@blokjs/core` authoring surface; the package merge (#374) is a
 * separate task. For now these are exported from runner's public index.
 *
 * Layering: at runtime the callback `workflow()` collects the registered step
 * records (with handles lowered to structural `{$ref}` in `inputs`) and hands
 * them to the EXISTING object-style `workflow()` factory from `@blokjs/helper`,
 * so it produces the byte-identical v2 IR envelope the runner already executes.
 * The `{$ref}` sentinels flow through normalize + `lowerRefs` (ADR 0001) at
 * load time, turning into the `js/ctx.state...` wire strings the Mapper resolves.
 *
 * SCOPE (this task): linear `step()` chains + the builder stack + IR emission.
 * `branch()` (#418) layers on top: it pushes child builder scopes for its
 * then/else arms (ADR 0003) and lowers its condition to a BARE `ctx.state...`
 * when-string (ADR 0004). `forEach()`/`switch`/`loop`/`tryCatch` handle-ARM
 * integration and `tpl` remain SEPARATE follow-ups (#425/#329).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	type EmptyEventMap,
	type EventMap,
	type EventUnion,
	type InferOr,
	type TypedWorkflow,
	type WorkflowV2Opts as WorkflowOpts,
	workflow as objectWorkflow,
} from "@blokjs/helper";
import type { z } from "zod";
import type { EphemeralHandle, ErrorHandle, Handle, OutputOf, SpreadHandle } from "./handles";

/** The structural handle reference sentinel — mirrors `@blokjs/shared`'s `StructuralRef`. */
interface StructuralRef {
	$ref: { step: string; path: (string | number)[] };
}

/**
 * A structural template node (#425): the alternating string/ref segments a
 * `tpl\`...${handle}...\`` captures. Mirrors `@blokjs/shared`'s `StructuralTpl`.
 * lowerRefs compiles it to a `js/\`...${ctx.state...}...\`` template literal.
 */
interface StructuralTpl {
	$tpl: unknown[];
}

/** Detect a handle Proxy when walking step inputs. Private — never user-visible. */
const HANDLE_META = Symbol("blok.handleMeta");

/** What a handle Proxy carries: its root step id, owning builder, and accumulated path. */
interface HandleMeta {
	step: string;
	owner: Builder;
	path: (string | number)[];
	/** True for a step created with `{ ephemeral: true }` — its output is NOT persisted, so the handle is unreadable (#339). */
	ephemeral?: boolean;
	/**
	 * True for the root handle of a `{ spread: true }` step (#342). `spread`
	 * shallow-merges `result.data` keys into state at TOP LEVEL (Rule 2), so the
	 * step id is NOT a state slot — only per-key reads are valid. Field access on
	 * a spread root returns a NORMAL handle rooted at the top-level key; reading
	 * the spread root AS A WHOLE (whole-output ref) is rejected.
	 */
	spread?: boolean;
}

/** The loud error a poisoned ephemeral handle raises on any read (#339). */
function ephemeralReadError(step: string): Error {
	return new Error(
		`Step "${step}" is ephemeral — its output is not persisted to state and has no readable handle. Remove ephemeral:true, or read the value via the immediately-next step.`,
	);
}

/** The loud error reading a spread step's WHOLE output raises (#342). */
function spreadWholeReadError(step: string): Error {
	return new Error(
		`Step "${step}" uses \`spread: true\`, which merges its output keys into state at the top level — the step has no whole-output slot to reference. Read an individual key (e.g. \`${step}Handle.someKey\`) instead, or drop \`spread\` / use \`as:\` to keep a single rooted output.`,
	);
}

/** A collected step record. Mirrors the v2 step shape the object factory accepts. */
interface StepRecord {
	id: string;
	use: string;
	inputs?: Record<string, unknown>;
	[opt: string]: unknown;
}

/** A builder scope. The root carries the flat per-workflow id set (ADR 0003). */
interface Builder {
	parent?: Builder;
	root: RootBuilder;
	steps: StepRecord[];
}
interface RootBuilder extends Builder {
	ids: Set<string>;
}

/** ADR 0003: the builder stack survives `await` and isolates concurrent compiles. */
const builders = new AsyncLocalStorage<{ stack: Builder[] }>();

function currentBuilder(): Builder {
	const stack = builders.getStore()?.stack;
	const builder = stack?.[stack.length - 1];
	if (!builder) {
		throw new Error(
			"step() must be called inside workflow(name, opts, (req) => { ... }). " +
				"Called outside any workflow callback (or after the callback returned).",
		);
	}
	return builder;
}

/**
 * Is the handle's owning scope an ancestor-or-self of the reading scope?
 * (ADR 0003 cross-arm rule.)
 *
 * Activated by `branch()` (#418): its then/else arms push child builder scopes,
 * so a handle minted in one arm and read from a sibling arm (or after the branch)
 * fails this check and is rejected by `lowerHandles`/`lowerCondition`. Exercised
 * by `branch.test.ts`'s cross-arm guard cases. `forEach`/`switch`/`loop`/
 * `tryCatch` reuse the same mechanism when they land (#425/#329).
 */
function canRead(owner: Builder, reader: Builder): boolean {
	for (let cursor: Builder | undefined = reader; cursor; cursor = cursor.parent) {
		if (cursor === owner) return true;
	}
	return false;
}

const IDENT_OR_NUM = /^\d+$/;

/**
 * Build a handle Proxy rooted at `rootKey`, owned by `owner`, with the given
 * accumulated `path`. Property/index access lengthens the path (numeric index →
 * number segment, string key → string segment) and is detectable at
 * serialization via the private {@link HANDLE_META} symbol. Banned array members
 * (`.map`/`.length`) are a TYPE concern (handles.ts enforces) — at runtime we
 * just keep accumulating.
 *
 * `makeHandle(rootKey)` is the public seam: it mints a handle rooted at a step id
 * (or `@trigger` for the callback's `req` payload) with no owner-scope constraint.
 */
function buildHandle(
	rootKey: string,
	owner: Builder | undefined,
	path: (string | number)[],
	ephemeral = false,
	spread = false,
): unknown {
	// Function target so a stray `typeof handle === "function"` check is harmless;
	// it is never called.
	return new Proxy(() => undefined, {
		get(_t, key) {
			// HANDLE_META must stay readable even when poisoned: lowerHandles/tpl read
			// it STRUCTURALLY to detect the handle and raise the clear authoring error
			// (#339/#342) rather than a cryptic Proxy throw.
			if (key === HANDLE_META)
				return { step: rootKey, owner, path, ephemeral, spread } satisfies Partial<HandleMeta> as HandleMeta;
			// POISON (#339): an ephemeral step persists no state, so its handle has no
			// readable value. Any field/index access — `h.field`, `h[0]` — throws loud
			// instead of silently building a ref that resolves to undefined at runtime.
			// (`then`/symbol probes below short-circuit first so await/typeof stay safe.)
			if (key === "then") return undefined;
			if (ephemeral && typeof key !== "symbol") throw ephemeralReadError(rootKey);
			// POISON (#425): a bare handle coerced into a plain (untagged) string —
			// `\`${handle}\`` or `"" + handle` — would silently stringify to garbage
			// and lose the ref. Throw loud instead. `tpl\`...\`` reads the raw strings
			// array + HANDLE_META structurally (never coerces), so tpl itself works.
			if (key === "toString" || key === Symbol.toPrimitive) {
				return () => {
					throw new Error(
						`A handle (ref to step "${rootKey}") was coerced to a string. Use tpl\`...\${handle}...\` for string interpolation of handles — a bare \${handle} in an untagged template silently loses the ref.`,
					);
				};
			}
			if (typeof key === "symbol") return undefined;
			const k = String(key);
			const seg = IDENT_OR_NUM.test(k) ? Number(k) : k;
			// SPREAD (#342): the step id is not a state slot — `spread` merges each
			// output key into state at the top level (Rule 2). So the FIRST field
			// access re-roots: `spreadHandle.user` becomes a NORMAL handle rooted at
			// the top-level state key `user` (→ ctx.state.user), NOT ctx.state.<id>.user.
			if (spread) return buildHandle(k, owner, []);
			return buildHandle(rootKey, owner, [...path, seg]);
		},
	});
}

/**
 * Mint a handle rooted at `rootKey` with no scope constraint. Used for the
 * trigger payload handle (`@trigger`) the callback receives. `step()` mints its
 * own owner-scoped handles internally.
 */
export function makeHandle<T = unknown>(rootKey: string): Handle<T> {
	return buildHandle(rootKey, undefined, []) as Handle<T>;
}

/**
 * `tpl` tagged template (#425). Captures the static string parts + the
 * interpolated handles as a STRUCTURAL template node — `{$tpl: [str, {$ref}, …]}`
 * — WITHOUT coercing the handles to strings (the poison toString would throw).
 * The raw `strings` array is captured before any coercion; each interpolated
 * value is read structurally via {@link readHandleMeta} and lowered to the SAME
 * `{$ref}` sentinel `makeHandle` mints. Non-handle interpolations stay as their
 * value (lowerRefs JSON/String-encodes them into the template literal).
 *
 * The result flows through `lowerHandles` (a plain object — passes through) and
 * lowerRefs at load time, which compiles `{$tpl}` to a `js/\`…\`` template literal.
 *
 * @example tpl`https://inv/stock/${validate.productId}` → { $tpl: ["https://inv/stock/", {$ref:{step:"validate",path:["productId"]}}, ""] }
 */
export function tpl(strings: TemplateStringsArray, ...values: unknown[]): StructuralTpl {
	const segments: unknown[] = [];
	for (let i = 0; i < strings.length; i++) {
		segments.push(strings[i]);
		if (i < values.length) {
			const meta = readHandleMeta(values[i]);
			if (meta?.ephemeral) throw ephemeralReadError(meta.step);
			if (meta?.spread) throw spreadWholeReadError(meta.step);
			segments.push(meta ? ({ $ref: { step: meta.step, path: meta.path } } satisfies StructuralRef) : values[i]);
		}
	}
	return { $tpl: segments };
}

function readHandleMeta(value: unknown): HandleMeta | undefined {
	if (typeof value !== "function") return undefined;
	const meta = (value as { [HANDLE_META]?: HandleMeta })[HANDLE_META];
	return meta && typeof meta.step === "string" ? meta : undefined;
}

/**
 * Walk `inputs`, replacing every handle with its structural `{$ref}`. Rejects a
 * handle whose owning scope is not an ancestor-or-self of the current scope
 * (ADR 0003 cross-arm rule). Pure — returns a new value, never mutates input.
 * Plain objects/arrays are recursed; everything else passes through.
 */
function lowerHandles(value: unknown, reader: Builder): unknown {
	const meta = readHandleMeta(value);
	if (meta) {
		// Ephemeral handle used as an input ref — unreadable (#339).
		if (meta.ephemeral) throw ephemeralReadError(meta.step);
		// Spread root used as a whole-output ref — invalid; only per-key reads (#342).
		if (meta.spread) throw spreadWholeReadError(meta.step);
		// `@trigger` and other unowned handles have no scope constraint.
		if (meta.owner && !canRead(meta.owner, reader)) {
			throw new Error(
				`Handle from step "${meta.step}" is read outside its scope. A handle produced inside one control-flow arm is not readable from a sibling arm or after the flow step — return a value from the flow step, or write both arms to a shared \`as\` key.`,
			);
		}
		return { $ref: { step: meta.step, path: meta.path } } satisfies StructuralRef;
	}
	if (Array.isArray(value)) return value.map((item) => lowerHandles(item, reader));
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value)) out[k] = lowerHandles((value as Record<string, unknown>)[k], reader);
		return out;
	}
	return value;
}

// ───────────────────────────── branch (#418) ─────────────────────────────
//
// A `branch()` condition is either a boolean Handle (truthiness) or a typed op
// over handle fields (`gt(a.count, b.limit)`, `eq(a.status, "ok")`, `not(...)`).
// Per ADR 0004 the condition lowers to a BARE raw `ctx.state...` string — NOT
// `js/...`, NOT `{$ref}` — because `@blokjs/if-else` evals the `when` via raw
// `Function("ctx", ...)`. Emitting `js/...` would 500 with "js is not defined".

/** Marker carried by `eq`/`gt`/… and `not`. Private — never user-visible. */
const COND_META = Symbol("blok.condMeta");

type Operand = unknown; // a Handle proxy, a nested Condition, or a JSON literal
interface OpMeta {
	kind: "op";
	op: "===" | "!==" | ">" | ">=" | "<" | "<=";
	left: Operand;
	right: Operand;
}
interface NotMeta {
	kind: "not";
	value: Operand;
}
/** A typed condition (op or negation). Opaque to authors — pass to `branch`. */
export interface BranchCondition {
	readonly [COND_META]: OpMeta | NotMeta;
}

function makeCondition(meta: OpMeta | NotMeta): BranchCondition {
	return { [COND_META]: meta };
}
function readCondMeta(value: unknown): OpMeta | NotMeta | undefined {
	if (value && typeof value === "object") return (value as { [COND_META]?: OpMeta | NotMeta })[COND_META];
	return undefined;
}

/** Strict equality. `eq(a.status, "ready")` → `ctx.state.a.status === "ready"`. */
export function eq(left: Operand, right: Operand): BranchCondition {
	return makeCondition({ kind: "op", op: "===", left, right });
}
/** Strict inequality. */
export function ne(left: Operand, right: Operand): BranchCondition {
	return makeCondition({ kind: "op", op: "!==", left, right });
}
/** Greater-than. `gt(a.count, b.limit)` → `ctx.state.a.count > ctx.state.b.limit`. */
export function gt(left: Operand, right: Operand): BranchCondition {
	return makeCondition({ kind: "op", op: ">", left, right });
}
/** Greater-than-or-equal. */
export function gte(left: Operand, right: Operand): BranchCondition {
	return makeCondition({ kind: "op", op: ">=", left, right });
}
/** Less-than. */
export function lt(left: Operand, right: Operand): BranchCondition {
	return makeCondition({ kind: "op", op: "<", left, right });
}
/** Less-than-or-equal. */
export function lte(left: Operand, right: Operand): BranchCondition {
	return makeCondition({ kind: "op", op: "<=", left, right });
}
/** Negation. `not(a.ok)` → `!(ctx.state.a.ok)`. Accepts a handle or a condition. */
export function not(value: Operand): BranchCondition {
	return makeCondition({ kind: "not", value });
}

/**
 * Lower a handle to its BARE `ctx.state...` (or `ctx.request...`) string, per
 * ADR 0004. The handle's `step` root is ALREADY the resolved state key — `step()`
 * mints handles rooted at `as ?? id` (#327), and a spread step's sub-handles are
 * re-rooted at their top-level state key at field-access time (#342). So there is
 * no per-step record lookup here. `@trigger` roots at `ctx.request` (mirrors
 * lowerRefs' TRIGGER_SENTINEL). A spread ROOT read as a whole is rejected upstream
 * (its only valid reads are per-key sub-handles).
 */
function lowerHandleToCtx(meta: HandleMeta): string {
	if (meta.spread) throw spreadWholeReadError(meta.step);
	if (meta.step === "@trigger") {
		return `ctx.request${encodeCtxPath(meta.path)}`;
	}
	return `ctx.state${encodeSeg(meta.step)}${encodeCtxPath(meta.path)}`;
}

/** Encode one path segment: number → `[n]`, identifier → `.k`, else `["k"]`. */
function encodeSeg(seg: string | number): string {
	if (typeof seg === "number") return `[${seg}]`;
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`;
}
function encodeCtxPath(path: (string | number)[]): string {
	return path.map(encodeSeg).join("");
}

/**
 * Lower a branch condition (boolean handle, op, or negation) to the bare raw-ctx
 * when-string. Enforces the ADR 0003 cross-arm rule for every handle operand:
 * a handle whose owning scope is not an ancestor-or-self of the branch's scope
 * is rejected (activates the cornerstone's `canRead` guard).
 */
function lowerCondition(value: unknown, reader: Builder): string {
	const cond = readCondMeta(value);
	if (cond) {
		if (cond.kind === "not") return `!(${lowerCondition(cond.value, reader)})`;
		return `${lowerCondition(cond.left, reader)} ${cond.op} ${lowerCondition(cond.right, reader)}`;
	}
	const handle = readHandleMeta(value);
	if (handle) {
		if (handle.ephemeral) throw ephemeralReadError(handle.step);
		if (handle.owner && !canRead(handle.owner, reader)) {
			throw new Error(
				`Handle from step "${handle.step}" is read in a branch condition outside its scope. A handle produced inside one control-flow arm is not readable from a sibling arm or after the flow step.`,
			);
		}
		return lowerHandleToCtx(handle);
	}
	// JSON literal (string/number/boolean/null). Reject the un-encodable.
	if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
		return JSON.stringify(value);
	}
	throw new Error(
		`Unsupported branch condition operand: ${String(value)}. Use a boolean handle, a typed op (eq/ne/gt/gte/lt/lte/not over handle fields), or a string/number/boolean/null literal.`,
	);
}

/** Arms for {@link branch}: callbacks that register steps into the arm's scope. */
export interface BranchArms {
	then: () => unknown;
	else?: () => unknown;
}

/**
 * Callback-style `branch` over handles (#418, ADR 0003/0004). The condition is a
 * boolean handle (truthiness) or a typed op (`gt(a.x, b.y)`); it lowers to a BARE
 * `ctx.state...` when-string. `then`/`else` are callbacks that push CHILD builder
 * scopes — `step()` calls inside register into that arm's sub-pipeline, in order.
 * Emits the existing v2 branch step shape so it normalizes + runs through the
 * unchanged `@blokjs/if-else` engine.
 *
 * @example
 *   branch("route", stock.inStock, {
 *     then: () => { step("ship", shipNode, { ... }); },
 *     else: () => { step("backorder", boNode, { ... }); },
 *   });
 *   branch("big", gt(order.qty, limit.max), { then: () => { ... } });
 */
export function branch(id: string, condition: unknown, arms: BranchArms): void {
	if (typeof id !== "string" || id.length === 0) throw new Error("branch() requires a non-empty string id.");
	if (!arms || typeof arms.then !== "function") {
		throw new Error(`branch("${id}") requires a \`then\` callback.`);
	}
	if (arms.else !== undefined && typeof arms.else !== "function") {
		throw new Error(`branch("${id}") \`else\` must be a callback when provided.`);
	}
	const parent = currentBuilder();
	const ids = parent.root.ids;
	if (ids.has(id)) {
		throw new Error(`Duplicate step id "${id}". Step ids are flat per workflow — every step needs a unique id.`);
	}
	ids.add(id);

	// Lower the condition in the PARENT scope (the branch step itself lives there).
	const when = lowerCondition(condition, parent);

	const thenSteps = runArm(parent, arms.then);
	const elseSteps = arms.else ? runArm(parent, arms.else) : undefined;

	parent.steps.push({
		id,
		branch: { when, then: thenSteps, ...(elseSteps ? { else: elseSteps } : {}) },
	} as unknown as StepRecord);
}

// ───────────────────────────── forEach (#329 / #343) ─────────────────────
//
// `forEach(iterable, (item, index?) => { ...body... }, opts?)` — a callback-style
// loop over a handle. The body callback pushes a CHILD builder scope (the SAME
// mechanism branch() uses via `runArm`), so `step()` calls inside register into
// the forEach's `do` pipeline. `item` is a PER-ITEM handle rooted at the loop's
// `as` key, OWNED BY THE CHILD scope — reading it after the forEach (or from a
// sibling arm) trips the cornerstone's `canRead` guard (ADR 0003/0005, #343).
// The loop's output (the results array at `state[id]`) is the readable-after
// value, returned as a parent-owned handle.
//
// The iterable handle lowers to the forEach `in` expression as a `js/ctx....`
// STRING (not `{$ref}`): the normalizer does NOT run `lowerRefs` over
// `forEach.in`, and ForEachNode reads `opts.in` only after the Mapper resolves
// it — so `in` must already be the wire string the object-style `forEach()`
// emits via `unwrapProxies`.

/** Options for the callback-style {@link forEach}. */
export interface ForEachOptions {
	/** Step id (visible in traces, root of the results-array handle). Derived from `as` when omitted. */
	id?: string;
	/** Per-iteration state key. `state[as] = item`, `state[as + "Index"] = i`. Derived from the iterable's last path segment when omitted. */
	as?: string;
	/** `"sequential"` (default) or `"parallel"`. */
	mode?: "sequential" | "parallel";
	/** Max concurrent inner pipelines when `mode: "parallel"`. Default 10. */
	concurrency?: number;
}

/** Lower a handle to its `js/ctx....` wire string (the `in` expression). */
function lowerHandleToInExpr(meta: HandleMeta): string {
	return `js/${lowerHandleToCtx(meta)}`;
}

/** Derive a stable identifier from the iterable's last path segment (e.g. `validate.items` → `items`). */
function deriveName(meta: HandleMeta): string {
	const last = meta.path.length > 0 ? meta.path[meta.path.length - 1] : meta.step;
	const name = String(last);
	return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? name : "item";
}

/**
 * Callback-style `forEach` over a handle (#329 forEach slice + #343). `iterable`
 * is a handle (a step output field or a trigger field); it lowers to the forEach
 * `in` expression. `body(item, index?)` runs inside a CHILD builder scope — its
 * `step()` calls become the forEach `do` pipeline. `item` is a per-item handle
 * rooted at the loop's `as` key (scope-guarded to the body, #343); `index` roots
 * at `<as>Index`. Returns a handle to the results array (readable after the loop).
 *
 * Emits the existing v2 `{ id, forEach: { in, as, do } }` shape, so it normalizes
 * and runs through the UNCHANGED `ForEachNode` engine. The merged
 * `assertNoForEachStateKeyCollisions` guard (run by the object factory at load)
 * already protects `as`/`asIndex` against step-id collisions.
 *
 * @example
 *   const items = step("validate", validateNode, { ... }).items;
 *   const results = forEach(items, (item) => {
 *     step("save", saveItem, { sku: item.sku });
 *   });
 */
export function forEach<T = unknown>(
	iterable: Handle<readonly T[]> | Handle<T[]>,
	body: (item: Handle<T>, index: Handle<number>) => unknown,
	opts?: ForEachOptions,
): Handle<unknown[]> {
	const meta = readHandleMeta(iterable);
	if (!meta) {
		throw new Error("forEach() requires a handle as its iterable (a step output field or a trigger field).");
	}
	if (typeof body !== "function") {
		throw new Error("forEach() requires a body callback: forEach(iterable, (item, index?) => { ... }).");
	}
	const parent = currentBuilder();

	// Cross-arm guard: the iterable must be readable from the forEach's scope.
	if (meta.owner && !canRead(meta.owner, parent)) {
		throw new Error(
			`forEach() iterable from step "${meta.step}" is read outside its scope — a handle produced inside one control-flow arm is not iterable from a sibling arm or after the flow step.`,
		);
	}

	const as = opts?.as ?? deriveName(meta);
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(as)) {
		throw new Error(`forEach() \`as\` must be a valid JS identifier (got "${as}").`);
	}
	// `id` must differ from `as`: the loop's results land at `state[id]` while
	// `state[as]` holds the current item — the merged collision guard rejects
	// `id === as`. Default to a distinct `<as>Results` key.
	const id = opts?.id ?? `${as}Results`;
	const ids = parent.root.ids;
	if (ids.has(id)) {
		throw new Error(`Duplicate step id "${id}". Step ids are flat per workflow — every step needs a unique id.`);
	}
	ids.add(id);

	const inExpr = lowerHandleToInExpr(meta);

	// Run the body in a CHILD scope (reuse branch()'s mechanism). The per-item
	// `item`/`index` handles are owned by this child, so reading them after the
	// loop (or from a sibling arm) trips `canRead` in lowerHandles/lowerCondition.
	const child: Builder = { parent, root: parent.root, steps: [] };
	const store = builders.getStore();
	if (!store) throw new Error("forEach() must be called inside a workflow callback.");
	store.stack.push(child);
	try {
		const item = buildHandle(as, child, []) as Handle<T>;
		const index = buildHandle(`${as}Index`, child, []) as Handle<number>;
		body(item, index);
	} finally {
		store.stack.pop();
	}

	parent.steps.push({
		id,
		forEach: {
			in: inExpr,
			as,
			do: child.steps,
			...(opts?.mode !== undefined ? { mode: opts.mode } : {}),
			...(opts?.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
		},
	} as unknown as StepRecord);

	// The results array lands at state[id] — a parent-owned handle, readable after.
	return buildHandle(id, parent, []) as Handle<unknown[]>;
}

// ───────────────────────────── switchOn (#319) ───────────────────────────
//
// `switchOn(discriminant, { cases: [{ when, do }], default? })` — a callback-
// style N-way branch over a handle. The `discriminant` HANDLE lowers to the
// switch `on` expression as a `js/ctx....` STRING — the SAME way forEach lowers
// its `in` (the normalizer passes `on` verbatim; SwitchNode resolves it via the
// Mapper at run time). Each case `do` (+ optional `default`) is a callback that
// pushes a CHILD builder scope (reuse branch()'s `runArm`); `step()` calls inside
// register into that case's sub-pipeline. Per-case handles are arm-scoped
// (cornerstone `canRead`).
//
// Per #319: SwitchNode matches `case.when` by literal `===`/`includes` with NO
// mapper resolution — so a `when` MUST be a static literal (string/number/boolean,
// or an array of those). A handle passed as `when` would lower to a `{$ref}`/`js/`
// string that never `=== on`, so we REJECT it at author time with a clear error.

/** Options for the callback-style {@link switchOn}. */
export interface SwitchCaseArm {
	/** Literal match value — string/number/boolean, or an array of those (any-of). NOT a handle. */
	when: string | number | boolean | Array<string | number | boolean>;
	/** Callback registering the case's sub-pipeline into a child scope. */
	do: () => unknown;
}
export interface SwitchArms {
	/** Ordered cases. First match wins. */
	cases: SwitchCaseArm[];
	/** Fallback callback when no case matches. */
	default?: () => unknown;
}

/** A `when` is valid only as a static literal scalar (or an array of them). */
function assertLiteralWhen(when: unknown, id: string, ci: number): void {
	const isScalar = (v: unknown): boolean => v === null || ["string", "number", "boolean"].includes(typeof v);
	const reject = (): never => {
		// A handle (or anything non-literal) leaked into a case label.
		if (readHandleMeta(when) || (Array.isArray(when) && when.some((w) => readHandleMeta(w)))) {
			throw new Error(
				`switchOn("${id}") cases[${ci}] \`when\` is a handle/runtime ref. A case label must be a STATIC literal (string/number/boolean, or an array of them) — the switch engine matches \`when\` by literal === with no mapper resolution, so a handle never matches. Read the discriminant value into \`on\`, and write each case as a literal.`,
			);
		}
		throw new Error(
			`switchOn("${id}") cases[${ci}] \`when\` must be a literal string/number/boolean, or an array of them (got ${typeof when}).`,
		);
	};
	if (Array.isArray(when)) {
		if (when.length === 0 || !when.every(isScalar)) reject();
		return;
	}
	if (!isScalar(when)) reject();
}

/**
 * Callback-style `switchOn` over a handle (#319). `discriminant` is a handle (a
 * step output field or a trigger field); it lowers to the switch `on` expression
 * as a `js/ctx....` wire string. `arms.cases[].when` are STATIC literals (handles
 * are rejected at author time, per #319); `arms.cases[].do` (+ optional
 * `arms.default`) are callbacks that push CHILD builder scopes — their `step()`
 * calls become that arm's sub-pipeline. First matching case wins.
 *
 * Emits the existing v2 `{ id, switch: { on, cases: [{when, do}], default? } }`
 * shape, so it normalizes and runs through the UNCHANGED `SwitchNode` engine.
 * Duplicate ids across arms already throw (`assertNoDuplicateStepIds`).
 *
 * @example
 *   const v = step("validate", validateNode, { ... });
 *   switchOn(v.kind, {
 *     cases: [
 *       { when: "a", do: () => { step("doA", nodeA, { ... }); } },
 *       { when: ["b", "c"], do: () => { step("doBC", nodeBC, { ... }); } },
 *     ],
 *     default: () => { step("fallback", nodeD, { ... }); },
 *   }, { id: "route" });
 */
export function switchOn(discriminant: Handle<unknown>, arms: SwitchArms, opts?: { id?: string }): void {
	const meta = readHandleMeta(discriminant);
	if (!meta) {
		throw new Error("switchOn() requires a handle as its discriminant (a step output field or a trigger field).");
	}
	if (!arms || !Array.isArray(arms.cases) || arms.cases.length === 0) {
		throw new Error("switchOn() requires `cases` to be a non-empty array.");
	}
	if (arms.default !== undefined && typeof arms.default !== "function") {
		throw new Error("switchOn() `default` must be a callback when provided.");
	}
	const parent = currentBuilder();

	// Cross-arm guard: the discriminant must be readable from the switch's scope.
	if (meta.owner && !canRead(meta.owner, parent)) {
		throw new Error(
			`switchOn() discriminant from step "${meta.step}" is read outside its scope — a handle produced inside one control-flow arm is not readable from a sibling arm or after the flow step.`,
		);
	}

	// Derive a stable id (visible in traces, root of the switch's state slot).
	const id = opts?.id ?? `${deriveName(meta)}Switch`;
	const ids = parent.root.ids;
	if (ids.has(id)) {
		throw new Error(`Duplicate step id "${id}". Step ids are flat per workflow — every step needs a unique id.`);
	}
	ids.add(id);

	// `on` lowers EXACTLY like forEach's `in` — a `js/ctx....` wire string.
	const on = lowerHandleToInExpr(meta);

	const cases = arms.cases.map((c, ci) => {
		if (!c || typeof c !== "object" || typeof c.do !== "function") {
			throw new Error(`switchOn("${id}") cases[${ci}] requires a \`do\` callback.`);
		}
		assertLiteralWhen(c.when, id, ci);
		return { when: c.when, do: runArm(parent, c.do) };
	});
	const defaultSteps = arms.default ? runArm(parent, arms.default) : undefined;

	parent.steps.push({
		id,
		switch: { on, cases, ...(defaultSteps ? { default: defaultSteps } : {}) },
	} as unknown as StepRecord);
}

/** Run one arm callback inside a fresh child builder, returning its collected steps. */
function runArm(parent: Builder, body: () => unknown): StepRecord[] {
	return runArmWith(parent, (_child) => body());
}

/**
 * Run an arm callback inside a fresh child builder, returning its collected
 * steps. The callback receives the child builder so it can mint arm-scoped
 * handles (e.g. tryCatch's `@error` handle owned by the catch child).
 */
function runArmWith(parent: Builder, body: (child: Builder) => unknown): StepRecord[] {
	const child: Builder = { parent, root: parent.root, steps: [] };
	const store = builders.getStore();
	if (!store) throw new Error("This primitive must be called inside a workflow callback.");
	store.stack.push(child);
	try {
		body(child);
	} finally {
		store.stack.pop();
	}
	return child.steps;
}

// ───────────────────────────── tryCatch (#317) ───────────────────────────
//
// `tryCatch({ try, catch, finally? })` — callback-style JS-like exception
// handling. Each arm callback pushes a CHILD builder scope (the SAME mechanism
// branch()/forEach() use via runArm), so `step()` inside registers into that
// arm's sub-pipeline. The `catch` callback receives a typed `error` handle
// rooted at the `@error` sentinel (lowerRefs maps it to `ctx.error`, where
// TryCatchNode writes the envelope on catch entry) — `error.code` lowers to
// `js/ctx.error.code`. The error handle is OWNED BY THE CATCH CHILD scope, so
// reading it in try/finally/after the tryCatch trips the cornerstone canRead
// guard (the same arm-scope contract branch()/forEach() enforce).
//
// Emits the existing v2 `{ id, tryCatch: { try, catch, finally? } }` shape, so
// it normalizes + runs through the UNCHANGED TryCatchNode engine.

/** Arms for {@link tryCatch}: callbacks that register steps into each arm's scope. */
export interface TryCatchArms {
	try: () => unknown;
	catch: (error: ErrorHandle) => unknown;
	finally?: () => unknown;
}

/**
 * Callback-style `tryCatch` over handles (#317). `try`/`catch`/`finally` are
 * callbacks that push CHILD builder scopes — `step()` calls inside register into
 * that arm's pipeline, in order. The `catch` callback receives a typed `error`
 * handle modeling the runtime `$.error` envelope (`message`/`name` always present,
 * `stack`/`code`/`stepId` optional); it is scoped to the catch arm.
 *
 * @example
 *   tryCatch("signup", {
 *     try: () => {
 *       step("create", createUser, { email: req.body.email });
 *     },
 *     catch: (error) => {
 *       step("alert", notify, { message: error.message, code: error.code });
 *     },
 *     finally: () => {
 *       step("metric", emitMetric, { event: "signup-attempt" }, { ephemeral: true });
 *     },
 *   });
 */
export function tryCatch(id: string, arms: TryCatchArms): void {
	if (typeof id !== "string" || id.length === 0) throw new Error("tryCatch() requires a non-empty string id.");
	if (!arms || typeof arms.try !== "function") {
		throw new Error(`tryCatch("${id}") requires a \`try\` callback.`);
	}
	if (typeof arms.catch !== "function") {
		throw new Error(`tryCatch("${id}") requires a \`catch\` callback.`);
	}
	if (arms.finally !== undefined && typeof arms.finally !== "function") {
		throw new Error(`tryCatch("${id}") \`finally\` must be a callback when provided.`);
	}
	const parent = currentBuilder();
	const ids = parent.root.ids;
	if (ids.has(id)) {
		throw new Error(`Duplicate step id "${id}". Step ids are flat per workflow — every step needs a unique id.`);
	}
	ids.add(id);

	const trySteps = runArm(parent, arms.try);
	// The catch arm gets an `@error`-rooted handle OWNED BY the catch child, so
	// reading it from try/finally/after trips canRead. `@error` matches lowerRefs'
	// ERROR_SENTINEL — a ref rooted here lowers to `ctx.error`, NOT ctx.state.
	const catchSteps = runArmWith(parent, (child) => arms.catch(buildHandle("@error", child, []) as ErrorHandle));
	const finallySteps = arms.finally ? runArm(parent, arms.finally) : undefined;

	parent.steps.push({
		id,
		tryCatch: {
			try: trySteps,
			catch: catchSteps,
			...(finallySteps ? { finally: finallySteps } : {}),
		},
	} as unknown as StepRecord);
}

/**
 * Guard `spread: true` against a node whose output is NOT a statically-known
 * object (#342). Spread merges the output's KEYS into state at the top level
 * (Rule 2) — without a known key set the per-key sub-handles can't be sound, so
 * we hard-error at authoring time (mirroring the object factory's load-time
 * `as`/`spread` guard style).
 *
 * The check reads the node's reflection JSON-schema (`type: "object"` with
 * `properties`) when available (a `defineNode` FunctionNode). A cross-runtime
 * `runtimeNode` stub carries no runtime schema — there the static `OutputOf<N>`
 * type is the soundness guarantee, so we trust it and skip (documented degrade).
 *
 * ponytail: reads the lazily-built reflection JSON-schema rather than the private
 * Zod `definition.output` — no FunctionNode surface change. Upgrade path if a
 * cheaper check is wanted: expose the Zod output schema and test `instanceof z.ZodObject`.
 */
function assertSpreadableOutput(id: string, node: { name: string; getReflectionSchemas?: () => unknown }): void {
	if (typeof node.getReflectionSchemas !== "function") return; // runtimeNode stub — trust the type.
	const schema = (node.getReflectionSchemas() as { output?: unknown }).output as
		| { type?: unknown; properties?: Record<string, unknown> }
		| undefined;
	const isObject =
		schema != null &&
		typeof schema === "object" &&
		schema.type === "object" &&
		schema.properties != null &&
		Object.keys(schema.properties).length > 0;
	if (!isObject) {
		throw new Error(
			`step("${id}", "${node.name}", …, { spread: true }) requires a node whose output is a statically-known object (z.object({ … })). Its output is not an object with known keys, so spread cannot produce sound per-key handles. Use \`as: "name"\` to keep a single rooted output, or give the node a z.object output schema.`,
		);
	}
}

/** Per-step persistence/control knobs carried verbatim onto the step record. */
export interface StepOptions {
	/** Store the output at `state[as]` instead of `state[id]`. Mutually exclusive with `spread`. */
	as?: string;
	/** Shallow-merge `result.data` keys into `state`. Mutually exclusive with `as`. */
	spread?: boolean;
	/** Skip persistence; only `ctx.prev` carries the result to the next step. */
	ephemeral?: boolean;
	/** Node type override (module/local/runtime.*). Inferred from `use` when omitted. */
	type?: string;
	/** Literal string or handle lowered to the `js/ctx...` string consumed by resolveIdempotencyKey. */
	idempotencyKey?: string | Handle<unknown>;
	/** Escape hatch for the other v2 step knobs (idempotencyKey, retry, maxDuration, …). */
	[opt: string]: unknown;
}

function lowerExpressionSite(value: unknown, reader: Builder, site: string): unknown {
	const meta = readHandleMeta(value);
	if (!meta) return value;
	if (meta.ephemeral) throw ephemeralReadError(meta.step);
	if (meta.owner && !canRead(meta.owner, reader)) {
		throw new Error(`Handle from step "${meta.step}" is read in ${site} outside its scope.`);
	}
	return lowerHandleToInExpr(meta);
}

function lowerStepOptions<O extends StepOptions | undefined>(opts: O, reader: Builder): O {
	if (!opts || typeof opts !== "object") return opts;
	return {
		...opts,
		...(opts.idempotencyKey !== undefined
			? { idempotencyKey: lowerExpressionSite(opts.idempotencyKey, reader, "idempotencyKey") }
			: {}),
	} as O;
}

/**
 * Register a step into the current builder and return a typed handle to its
 * output. `node` is a value produced by `defineNode`/`runtimeNode` (it carries
 * the witnessed input/output types via `./handles`); only its `name` is read at
 * runtime. `inputs` may contain handles (from earlier `step()` calls or the
 * trigger `req`), which are lowered to `{$ref}` here.
 *
 * Throws if called outside a `workflow(..., callback)`, if `id` is empty, or if
 * `id` duplicates another step id anywhere in the workflow (flat id set, ADR 0003).
 */
export function step<N extends { name: string }, O extends StepOptions = StepOptions>(
	id: string,
	node: N,
	inputs?: Record<string, unknown>,
	opts?: O,
): O extends { ephemeral: true }
	? EphemeralHandle<OutputOf<N>>
	: O extends { spread: true }
		? SpreadHandle<OutputOf<N>>
		: Handle<OutputOf<N>> {
	if (typeof id !== "string" || id.length === 0) {
		throw new Error("step() requires a non-empty string id.");
	}
	if (!node || typeof node.name !== "string" || node.name.length === 0) {
		throw new Error(`step("${id}") requires a node value with a name (from defineNode/runtimeNode).`);
	}
	const builder = currentBuilder();
	const ids = builder.root.ids;
	if (ids.has(id)) {
		throw new Error(`Duplicate step id "${id}". Step ids are flat per workflow — every step needs a unique id.`);
	}
	ids.add(id);

	// `as` and `spread` are mutually exclusive (mirrors the object factory's
	// load-time guard) — both re-root the handle, and there is no sound meaning
	// for combining a rename with a top-level merge.
	if (opts?.as !== undefined && opts?.spread === true) {
		throw new Error(`step("${id}"): \`as\` and \`spread\` are mutually exclusive — pick one.`);
	}
	if (opts?.spread === true) assertSpreadableOutput(id, node);
	const loweredOpts = lowerStepOptions(opts, builder);

	const record: StepRecord = {
		id,
		use: node.name,
		...(inputs ? { inputs: lowerHandles(inputs, builder) as Record<string, unknown> } : {}),
		...(loweredOpts ?? {}),
	};
	builder.steps.push(record);

	// The returned handle roots at the step's ACTUAL persisted state key, honoring
	// the persistence knobs (issues #327/#342 — the gap the cornerstone deferred):
	// - ephemeral (Rule 1): no state slot → poisoned handle that throws on any read (#339).
	// - spread (Rule 2): keys merged into state at top level → spread-root handle whose
	//   FIELD reads re-root at the top-level key (ctx.state.<key>), whole-read rejected (#342).
	// - as (Rule 3): renamed slot → handle rooted at `as` so `h.field` → ctx.state.<as>.field (#327).
	// - default: rooted at id.
	const ephemeral = opts?.ephemeral === true;
	const spread = opts?.spread === true;
	const root = typeof opts?.as === "string" ? opts.as : id;
	return buildHandle(root, builder, [], ephemeral, spread) as O extends { ephemeral: true }
		? EphemeralHandle<OutputOf<N>>
		: O extends { spread: true }
			? SpreadHandle<OutputOf<N>>
			: Handle<OutputOf<N>>;
}

/** Options for a {@link subworkflow} step (a superset of the regular step knobs). */
export interface SubworkflowOptions extends StepOptions {
	/** `true` (default) — parent blocks on the child; `false` — fire-and-forget. */
	wait?: boolean;
	/** Execution strategy. `"in-process"` (default) or `"http-self"`. */
	dispatch?: "in-process" | "http-self";
	/** Constrain a polymorphic (handle) name to a set of allowed workflow names (safety guard). */
	allowList?: string[];
}

/**
 * Invoke another named workflow as a step — the handle-DSL sub-workflow primitive
 * (#374). The callback mirror of the object-style `{ id, subworkflow, inputs }`
 * step: it dispatches a *workflow* instead of a node, and returns a handle to the
 * child's response (rooted at `state[id]` / `state[as]`) so downstream steps read
 * it exactly like a node's output.
 *
 * `name` is either a literal workflow name, or a HANDLE for polymorphic dispatch
 * (one trigger → N handlers without a switch step). A handle name is lowered to a
 * `js/ctx…` expression the runner resolves against the live ctx at dispatch time —
 * pair it with `allowList` whenever it depends on caller-supplied data.
 *
 * @example
 *   const receipt = subworkflow("receipt", "send-receipt-email", { user: order.user }, { wait: true });
 *   subworkflow("dispatch", event.body.kind, { event: event.body }, { allowList: ["handler.a", "handler.b"] });
 */
export function subworkflow(
	id: string,
	name: string | Handle<unknown>,
	inputs?: Record<string, unknown>,
	opts?: SubworkflowOptions,
): Handle<unknown> {
	if (typeof id !== "string" || id.length === 0) {
		throw new Error("subworkflow() requires a non-empty string id.");
	}

	// Resolve the target workflow name: a literal string, or a handle lowered to a
	// `js/ctx…` expression string (polymorphic dispatch — the runner resolves it).
	let lowered: string;
	const nameMeta = readHandleMeta(name);
	if (nameMeta) {
		lowered = lowerHandleToInExpr(nameMeta);
	} else if (typeof name === "string" && name.length > 0) {
		lowered = name;
	} else {
		throw new Error(
			`subworkflow("${id}") requires a workflow name — a non-empty string, or a handle for polymorphic dispatch.`,
		);
	}

	const builder = currentBuilder();
	const ids = builder.root.ids;
	if (ids.has(id)) {
		throw new Error(`Duplicate step id "${id}". Step ids are flat per workflow — every step needs a unique id.`);
	}
	ids.add(id);

	if (opts?.as !== undefined && opts?.spread === true) {
		throw new Error(`subworkflow("${id}"): \`as\` and \`spread\` are mutually exclusive — pick one.`);
	}
	const loweredOpts = lowerStepOptions(opts, builder);

	const record = {
		id,
		subworkflow: lowered,
		...(inputs ? { inputs: lowerHandles(inputs, builder) as Record<string, unknown> } : {}),
		...(loweredOpts ?? {}),
	} as unknown as StepRecord;
	builder.steps.push(record);

	// Same handle-rooting rules as step(): ephemeral → poisoned, spread → spread-root, as → renamed, else id.
	const ephemeral = opts?.ephemeral === true;
	const spread = opts?.spread === true;
	const root = typeof opts?.as === "string" ? opts.as : id;
	return buildHandle(root, builder, [], ephemeral, spread) as Handle<unknown>;
}

/**
 * The trigger-payload handle the callback receives, untyped. Rooted at the
 * `@trigger` pseudo-step (lowerRefs maps it to `ctx.request`, where the runner
 * puts the trigger payload — NOT `ctx.state`). For request-shaped triggers,
 * author reads `req.body.x`, `req.params.id`, etc.
 *
 * This is the FALLBACK surface — when the trigger kind can't be inferred (or the
 * caller passes no recognized trigger kind), the callback receives this loose
 * handle. The per-trigger typed handles below ({@link HttpEntry}, {@link CronEntry},
 * …) narrow it to the fields that trigger kind actually populates in `ctx.request`.
 */
export type TriggerHandle = Handle<unknown> & Record<string, Handle<unknown>>;

// ───────────────────── per-trigger ENTRY handles (#336) ──────────────────────
//
// Every request-shaped trigger funnels its payload into `ctx.request.{body,
// headers,query,params}` (TriggerBase.createContext + each trigger adapter), so
// ALL of these entry handles lower through the EXISTING `@trigger` → ctx.request
// root in lowerRefs — there is NO runtime change here. The deliverable is the
// TYPED author-facing surface: the entry-handle NAME (`req`/`event`/`tick`/…)
// and the SHAPE of fields each kind exposes.
//
// SCOPE: request-shaped triggers only. Out of scope (follow-ups, NOT built):
//   - the greenfield `manual` trigger (#362) — its `args` handle has no
//     ctx.request payload yet; falls back to the loose TriggerHandle below.
//   - sse/websocket `conn`/`stream` — imperative surfaces (ctx.connection /
//     ctx.stream), not a declarative `ctx.request`-rooted entry handle.
//   - per-trigger SIDE-CHANNEL typing (ctx.vars._cron_context Date-vs-ISO,
//     _worker_job, _pubsub_message) — a separate typing task.

/** Generic request-shaped entry payload: the four `ctx.request.*` slots. */
type RequestShape<Body = unknown> = {
	body: Body;
	headers: Record<string, string>;
	query: Record<string, string>;
	params: Record<string, string>;
};

/** HTTP entry handle (`req`). Full request: body + params + query + headers. */
export type HttpEntry = Handle<RequestShape>;
/** Webhook entry handle (`event`). The verified provider event in `body` + the rest of the request. */
export type WebhookEntry = Handle<RequestShape>;
/**
 * Cron entry handle (`tick`). A scheduled tick has NO request body — the handle
 * exposes only `params` (e.g. the schedule) and headers, NOT a phantom `.body`.
 * (The richer scheduled-tick context — `_cron_context` Date — is a side-channel,
 * out of scope for #336.)
 */
export type CronEntry = Handle<{ headers: Record<string, string>; params: Record<string, string> }>;
/**
 * Worker entry handle (`job`). The job payload is `body`; job metadata lands in
 * `params.{queue,jobId,attempt}` (attempt is 0-based). Mirrors the worker ctx
 * mapping the runner funnels into ctx.request.
 */
export type WorkerEntry = Handle<{
	body: unknown;
	params: { queue: string; jobId: string; attempt: string } & Record<string, string>;
	headers: Record<string, string>;
}>;
/** PubSub entry handle (`msg`). The message payload is `body`; attributes/metadata in params/headers. */
export type PubSubEntry = Handle<RequestShape>;
/** gRPC entry handle (`rpc`). The request message is `body`; metadata in headers. */
export type GrpcEntry = Handle<RequestShape>;

/**
 * Map a workflow `opts.trigger` shape to the entry handle its callback receives.
 * Keyed on which request-shaped trigger kind is present. Multiple kinds or none
 * recognized → the loose {@link TriggerHandle}. Lazy first-match precedence
 * (http wins if several are set — rare, and the runtime root is identical).
 */
type EntryFor<T> = T extends { http: unknown }
	? HttpEntry
	: T extends { webhook: unknown }
		? WebhookEntry
		: T extends { cron: unknown }
			? CronEntry
			: T extends { worker: unknown }
				? WorkerEntry
				: T extends { pubsub: unknown }
					? PubSubEntry
					: T extends { grpc: unknown }
						? GrpcEntry
						: TriggerHandle;

/**
 * Callback-style `workflow()` overload. Runs `build` inside a fresh builder
 * context, collects the steps the callback registered via `step()`, and emits
 * the SAME v2 IR envelope the object-style `workflow()` produces (by delegating
 * to it), with step `inputs` carrying structural `{$ref}`.
 *
 * `entry` is the typed per-trigger payload handle — its TYPE (and the name you
 * give it) reflects the trigger kind (#336): `http` → `req`, `webhook` →
 * `event`, `cron` → `tick`, `worker` → `job`, `pubsub` → `msg`, `grpc` → `rpc`.
 * All of them lower through the existing `@trigger` → `ctx.request` root, so this
 * is a TYPE-ONLY refinement — runtime is unchanged. The callback may be sync or
 * async (`await` inside is safe — AsyncLocalStorage preserves the builder across
 * the await, ADR 0003).
 *
 * The existing object-style `workflow({...})` is UNAFFECTED — this is purely an
 * additive overload, re-exported alongside it.
 */
export async function workflowCallback<
	I extends z.ZodTypeAny = z.ZodTypeAny,
	O extends z.ZodTypeAny = z.ZodTypeAny,
	E extends EventMap = EmptyEventMap,
	Opts extends Omit<WorkflowOpts<I, O, E>, "name" | "steps"> = Omit<WorkflowOpts<I, O, E>, "name" | "steps">,
>(
	name: string,
	opts: Opts,
	build: (entry: EntryFor<Opts["trigger"]>) => unknown | Promise<unknown>,
): Promise<TypedWorkflow<InferOr<I>, InferOr<O>, EventUnion<E>>> {
	const root: RootBuilder = { steps: [], ids: new Set<string>() } as unknown as RootBuilder;
	root.root = root;

	await builders.run({ stack: [root] }, async () => {
		// `@trigger` MUST match `lowerRefs`'s TRIGGER_SENTINEL — a ref rooted here
		// lowers to `js/ctx.request` (the trigger payload), NOT `ctx.state[...]`.
		// EVERY per-trigger entry handle shares this one root (all request-shaped
		// triggers funnel into ctx.request); only the author-facing TYPE differs.
		await build(makeHandle("@trigger") as EntryFor<Opts["trigger"]>);
	});

	// Delegate to the object factory so validation + envelope shape are identical.
	// The `{$ref}` sentinels are plain objects: they pass V2RegularStepSchema's
	// `inputs: z.record(z.unknown())` and survive `unwrapProxies` untouched.
	return objectWorkflow<I, O, E>({
		...(opts as unknown as WorkflowOpts<I, O, E>),
		name,
		steps: root.steps as unknown as WorkflowOpts<I, O, E>["steps"],
	});
}
