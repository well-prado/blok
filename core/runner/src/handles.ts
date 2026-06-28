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
 * Declare a typed reference to a node implemented in another runtime.
 *
 * TYPES ONLY for now (issue #424) — the lowering that turns this into a real
 * `runtime.<kind>` step ships with `step()` (#421). With no explicit type
 * parameters both `In` and `Out` default to `unknown`, so the resulting handle
 * is `Handle<unknown>` — never `any`.
 *
 * @example
 * const ask = runtimeNode<{ prompt: string }, { answer: string }>("@demo/ask", "runtime.python3");
 */
export declare function runtimeNode<In = unknown, Out = unknown>(name: string, runtime: string): RuntimeNode<In, Out>;
