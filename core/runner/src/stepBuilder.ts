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
import type { Handle, OutputOf } from "./handles";

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
function buildHandle(rootKey: string, owner: Builder | undefined, path: (string | number)[]): unknown {
	// Function target so a stray `typeof handle === "function"` check is harmless;
	// it is never called.
	return new Proxy(() => undefined, {
		get(_t, key) {
			if (key === HANDLE_META) return { step: rootKey, owner, path } satisfies Partial<HandleMeta> as HandleMeta;
			// Don't masquerade as a thenable — Promise.resolve()/await probes `.then`.
			if (key === "then") return undefined;
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
 * ADR 0004. Resolves the state ROOT from the producing step's persistence
 * metadata (its owning builder's step record): `as:` renames the root, `spread:`
 * drops the step root entirely (the first path segment becomes the root key).
 * `@trigger` roots at `ctx.request` (mirrors lowerRefs' TRIGGER_SENTINEL).
 */
function lowerHandleToCtx(meta: HandleMeta): string {
	if (meta.step === "@trigger") {
		return `ctx.request${encodeCtxPath(meta.path)}`;
	}
	const rec = meta.owner?.steps.find((s) => s.id === meta.step);
	if (rec?.spread === true) {
		if (meta.path.length === 0) {
			throw new Error(
				`branch condition reads the whole output of spread step "${meta.step}", but \`spread: true\` drops the step root — read a field (e.g. \`${meta.step}Handle.someField\`) or rename the step with \`as:\` instead.`,
			);
		}
		// spread: first path segment IS the state root (no step-id prefix).
		return `ctx.state${encodeCtxPath(meta.path)}`;
	}
	const root = typeof rec?.as === "string" ? rec.as : meta.step;
	return `ctx.state${encodeSeg(root)}${encodeCtxPath(meta.path)}`;
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

/** Run one arm callback inside a fresh child builder, returning its collected steps. */
function runArm(parent: Builder, body: () => unknown): StepRecord[] {
	const child: Builder = { parent, root: parent.root, steps: [] };
	const store = builders.getStore();
	if (!store) throw new Error("branch() must be called inside a workflow callback.");
	store.stack.push(child);
	try {
		body();
	} finally {
		store.stack.pop();
	}
	return child.steps;
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
	/** Escape hatch for the other v2 step knobs (idempotencyKey, retry, maxDuration, …). */
	[opt: string]: unknown;
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
export function step<N extends { name: string }>(
	id: string,
	node: N,
	inputs?: Record<string, unknown>,
	opts?: StepOptions,
): Handle<OutputOf<N>> {
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

	const record: StepRecord = {
		id,
		use: node.name,
		...(inputs ? { inputs: lowerHandles(inputs, builder) as Record<string, unknown> } : {}),
		...(opts ?? {}),
	};
	builder.steps.push(record);
	return buildHandle(id, builder, []) as Handle<OutputOf<N>>;
}

/**
 * The trigger-payload handle the callback receives. Rooted at the `@trigger`
 * pseudo-step (lowerRefs maps it to `ctx.request`, where the runner puts the
 * trigger payload — NOT `ctx.state`). For request-shaped
 * triggers, author reads `req.body.x`, `req.params.id`, etc. Typed loosely for
 * now; ADR 0006 wires the per-trigger input type in a follow-up.
 */
export type TriggerHandle = Handle<unknown> & Record<string, Handle<unknown>>;

/**
 * Callback-style `workflow()` overload. Runs `build` inside a fresh builder
 * context, collects the steps the callback registered via `step()`, and emits
 * the SAME v2 IR envelope the object-style `workflow()` produces (by delegating
 * to it), with step `inputs` carrying structural `{$ref}`.
 *
 * `entry` is the typed trigger-payload handle (e.g. `req`). The callback may be
 * sync or async (`await` inside is safe — AsyncLocalStorage preserves the
 * builder across the await, ADR 0003).
 *
 * The existing object-style `workflow({...})` is UNAFFECTED — this is purely an
 * additive overload, re-exported alongside it.
 */
export async function workflowCallback<
	I extends z.ZodTypeAny = z.ZodTypeAny,
	O extends z.ZodTypeAny = z.ZodTypeAny,
	E extends EventMap = EmptyEventMap,
>(
	name: string,
	opts: Omit<WorkflowOpts<I, O, E>, "name" | "steps">,
	build: (req: TriggerHandle) => unknown | Promise<unknown>,
): Promise<TypedWorkflow<InferOr<I>, InferOr<O>, EventUnion<E>>> {
	const root: RootBuilder = { steps: [], ids: new Set<string>() } as unknown as RootBuilder;
	root.root = root;

	await builders.run({ stack: [root] }, async () => {
		// `@trigger` MUST match `lowerRefs`'s TRIGGER_SENTINEL — a ref rooted here
		// lowers to `js/ctx.request` (the trigger payload), NOT `ctx.state[...]`.
		await build(makeHandle("@trigger") as TriggerHandle);
	});

	// Delegate to the object factory so validation + envelope shape are identical.
	// The `{$ref}` sentinels are plain objects: they pass V2RegularStepSchema's
	// `inputs: z.record(z.unknown())` and survive `unwrapProxies` untouched.
	return objectWorkflow<I, O, E>({
		...(opts as WorkflowOpts<I, O, E>),
		name,
		steps: root.steps as unknown as WorkflowOpts<I, O, E>["steps"],
	});
}
