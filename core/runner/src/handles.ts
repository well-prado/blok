/**
 * Typed-handle TYPE foundation (ADR 0007 — authoritative; ADR 0006 — extraction contract).
 *
 * TYPES ONLY. Nothing here has runtime behavior — `step()` (issue #421) and the
 * `{$ref}` recorder are separate. This module ships the compile-time surface:
 *
 * - `Handle<T>`   — a structural reference proxy over a node output type. It does
 *                   NOT model the value; it models the *referenceable paths*.
 * - `Refable<T>`  — the input boundary: a handle is accepted wherever a workflow
 *                   input expects `T`, recursively, at leaves or whole-object.
 * - `NodeTypeWitness<In,Out>` — phantom witness carried on a node value's TS type
 *                   so the input/output types survive `import` (the broad registry
 *                   maps erase them — see ADR 0006).
 * - `InputOf<N>` / `OutputOf<N>` — extract the witnessed types off a node value.
 * - `runtimeNode<In,Out>` — stub signature for cross-runtime nodes (no Zod);
 *                   no-schema degrades to `Handle<unknown>`, never `any`.
 *
 * See `specs/blok-vision/adr/0007-handle-proxy-soundness.md` and
 * `specs/blok-vision/adr/0006-define-node-handle-types.md`.
 */

/**
 * Brand carrying the referenced output type. Phantom — never present at runtime.
 *
 * REQUIRED (not optional) on purpose: a primitive handle is otherwise structurally
 * `{}`, which any primitive value (`123`, `"x"`, …) is assignable to — that would
 * let `Refable<string>` silently swallow a `number`, defeating input type-checking
 * at the leaves. Requiring the brand means only an actual handle (which the runtime
 * casts to carry it) inhabits `Handle<T>`.
 */
declare const handleBrand: unique symbol;
/** Brand carrying the witnessed input/output types of a node value. Phantom. */
declare const nodeTypesBrand: unique symbol;

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

/** True iff `T` is a union of two or more members. */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/** Keys present on EVERY member of a (possibly union) object type. */
type CommonKeys<T> = {
	[K in keyof T]: T extends Record<K, unknown> ? K : never;
}[keyof T];

/** A handle exposing only the fields common to all union members. */
type CommonShape<T> = {
	readonly [K in CommonKeys<T>]: Handle<T extends Record<K, infer Value> ? Value : never>;
};

/**
 * A structural reference proxy over a node output type `T`.
 *
 * - object field → field handle;
 * - optional field → optional handle (`h.maybe?.x` type-checks);
 * - array → numeric-index access only — `.map`/`.length`/`.at`/etc are BANNED at the type level;
 * - union → only fields common to ALL members (no narrowing through a proxy);
 * - whole-output ref → pass the handle itself (it carries the type via the brand).
 *
 * Every property/index read returns another `Handle` carrying a longer path; there
 * is no leaf detection at read time — the USE site decides the terminal path.
 */
export type Handle<T> = { readonly [handleBrand]: T } & (T extends Primitive
	? // an empty surface is intentional — primitives expose no referenceable sub-paths.
		Record<never, never>
	: T extends readonly (infer Item)[]
		? { readonly [index: number]: Handle<Item> }
		: IsUnion<T> extends true
			? CommonShape<T>
			: { readonly [K in keyof T]-?: Handle<NonNullable<T[K]>> });

/** Brand marking a handle to an ephemeral step — unreadable by contract (#339). */
declare const ephemeralBrand: unique symbol;

/**
 * The handle returned by `step(..., { ephemeral: true })`. An ephemeral step
 * skips state persistence (Rule 1), so its output has no readable value — this
 * handle exposes NO referenceable members, making `h.field` a compile error
 * ("Property 'field' does not exist"). It carries the output brand so the type
 * is still distinguishable, but is intentionally NOT assignable to `Refable<T>`,
 * so passing it as a step input is also a compile error. At runtime any read
 * throws (the poisoned Proxy in `stepBuilder.ts`). It remains a valid value to
 * hold as a pure ordering token. The companion type, the runtime throw is the
 * contract; this type is the early-warning bonus.
 */
export type EphemeralHandle<T> = {
	readonly [ephemeralBrand]: T;
};

/**
 * The handle returned by `step(..., { spread: true })` (#342). `spread`
 * shallow-merges the node output's KEYS into state at the TOP LEVEL (Rule 2), so
 * the step id is NOT a state slot — only per-key reads are valid. Each top-level
 * key is exposed as its own `Handle<value>` rooted at `ctx.state.<key>` (NOT
 * `ctx.state.<id>.<key>`).
 *
 * Intentionally NOT branded as `Handle<T>` and NOT assignable to `Refable<T>`:
 * passing the whole spread handle as a step input (the whole-output ref) is a
 * COMPILE error, mirroring the runtime rejection — `spread` removes the step
 * root, so there is nothing whole to reference. Read an individual key instead.
 *
 * Requires `T` to be an object with statically-known keys; `step()` additionally
 * hard-errors at authoring time if the node output is not a known object.
 */
export type SpreadHandle<T> = T extends object ? { readonly [K in keyof T]-?: Handle<NonNullable<T[K]>> } : never;

/**
 * The error envelope a `tryCatch` catch arm receives, modeling
 * `TryCatchNode.toErrorEnvelope` (core/runner/src/TryCatchNode.ts) EXACTLY:
 *
 * - `message` / `name` are ALWAYS present (a thrown non-Error value defaults
 *   `name` to "Error" and stringifies the value into `message`).
 * - `stack` is optional (absent on thrown non-Error values).
 * - `code` is `number | undefined` — only a `GlobalError` carries one; a plain
 *   `throw new Error(...)` yields `code: undefined`.
 * - `stepId` is `string | undefined` — set from the try-arm step's id by
 *   RunnerSteps' wrap; a pre-wrap throw (or a value bypassing the inner-try
 *   wrap) yields `stepId: undefined`.
 *
 * The handle is rooted at the `@error` sentinel, which `lowerRefs` maps to
 * `ctx.error` — so `error.code` lowers to `js/ctx.error.code`. It is scoped to
 * the catch arm: reading it from `try`/`finally`/after the tryCatch is rejected
 * at author time (the cornerstone `canRead` guard).
 *
 * Carve-out: the catch arm does NOT fire for `WaitDispatchRequest` /
 * `RunCancelledError` (re-thrown past catch in TryCatchNode) — the "catches any
 * throw" mental model is wrong for those two control signals.
 */
export type ErrorHandle = Handle<{
	message: string;
	name: string;
	stack?: string;
	code?: number;
	stepId?: string;
}>;

/**
 * The input boundary. A workflow input that expects `T` also accepts a `Handle<T>`,
 * recursively: handles may appear at leaves, inside arrays, or as the whole object.
 */
export type Refable<T> =
	| Handle<T>
	| (T extends Primitive
			? T
			: T extends readonly (infer Item)[]
				? readonly Refable<Item>[]
				: { [K in keyof T]: Refable<T[K]> });

/**
 * Phantom witness carried on a node VALUE's declared TS type so `InputOf`/`OutputOf`
 * can recover the input/output types after `import`, before the value is placed into
 * a broad registry map (which erases them). Never present at runtime.
 */
export type NodeTypeWitness<Input, Output> = {
	readonly [nodeTypesBrand]?: { input: Input; output: Output };
};

/** Extract a node value's witnessed INPUT type, or `unknown` when unwitnessed. */
export type InputOf<N> = N extends NodeTypeWitness<infer Input, unknown>
	? Input
	: N extends RuntimeNode<infer Input, unknown>
		? Input
		: unknown;

/** Extract a node value's witnessed OUTPUT type, or `unknown` when unwitnessed. */
export type OutputOf<N> = N extends NodeTypeWitness<unknown, infer Output>
	? Output
	: N extends RuntimeNode<unknown, infer Output>
		? Output
		: unknown;

/**
 * Type-level stub for a cross-runtime node (Go/Rust/Python/…). Shares the same
 * `InputOf`/`OutputOf` extraction contract as `defineNode` but carries no Zod schema.
 */
export type RuntimeNode<Input, Output> = {
	readonly kind: "runtimeNode";
	readonly name: string;
	readonly runtime: string;
	readonly [nodeTypesBrand]?: { input: Input; output: Output };
};

/**
 * Declare a typed reference to a node implemented in another runtime
 * (Go/Rust/Python/…). Returns a real value `step()` lowers into a
 * `runtime.<kind>` step (#424) — `step("id", node, inputs)` emits
 * `{ use: <name>, type: <kind> }`, which `Configuration` routes through the
 * gRPC runtime adapter.
 *
 * `runtime` is the runtime KIND (`"runtime.python3"`), optionally suffixed with
 * the catalog node ref (`"runtime.python3:ask"`) as emitted by
 * `blokctl nodes sync`; `step()` parses the bare kind from either form. With no
 * explicit type parameters both `In` and `Out` default to `unknown`, so the
 * resulting handle is `Handle<unknown>` — never `any`.
 *
 * @example
 * const ask = runtimeNode<{ prompt: string }, { answer: string }>("@demo/ask", "runtime.python3");
 */
export function runtimeNode<In = unknown, Out = unknown>(name: string, runtime: string): RuntimeNode<In, Out> {
	return { kind: "runtimeNode", name, runtime };
}
