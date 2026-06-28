// Type-only spike for ADR 0005. Run with:
// bunx tsc --noEmit --strict --skipLibCheck specs/blok-vision/adr/0005-arm-handle-scope-prototype.ts

declare const owner: unique symbol;
declare const scopeParent: unique symbol;

type Scope<Name extends string, Parent = never> = {
	readonly name: Name;
	readonly [scopeParent]?: Parent;
};

type Root = Scope<"root">;
type Then = Scope<"then", Root>;
type Else = Scope<"else", Root>;

type Handle<T, Owner> = {
	readonly [owner]: Owner;
	readonly value: T;
};

type Ancestor<Needle, Current> = [Needle] extends [Current]
	? true
	: Current extends { readonly [scopeParent]?: infer Parent }
		? Ancestor<Needle, Parent>
		: false;

type ReadableIn<Current, T> = T extends Handle<unknown, infer Owner>
	? Ancestor<Owner, Current> extends true
		? T
		: never
	: T extends readonly unknown[]
		? { [K in keyof T]: ReadableIn<Current, T[K]> }
		: T extends object
			? { [K in keyof T]: ReadableIn<Current, T[K]> }
			: T;

type AssertReadable<Current, T> = [T] extends [ReadableIn<Current, T>] ? T : never;

declare function readIn<Current, T>(scope: Current, value: AssertReadable<Current, T>): void;

const root = null as unknown as Root;
const thenScope = null as unknown as Then;
const elseScope = null as unknown as Else;

const rootHandle = null as unknown as Handle<{ id: string }, Root>;
const thenHandle = null as unknown as Handle<{ ok: boolean }, Then>;
const elseHandle = null as unknown as Handle<{ no: boolean }, Else>;

readIn(root, rootHandle);
readIn(thenScope, rootHandle);
readIn(thenScope, thenHandle);
readIn(elseScope, elseHandle);
readIn(thenScope, { nested: rootHandle });

// @ts-expect-error sibling branch handle is not readable
readIn(elseScope, thenHandle);

// @ts-expect-error nested sibling handle is not readable
readIn(elseScope, { nested: thenHandle });

// @ts-expect-error arm handle is not readable after the branch
readIn(root, thenHandle);

// `any` still bypasses the proof, which is why this cannot be the only guard.
// biome-ignore lint/suspicious/noExplicitAny: this line demonstrates the exact type escape hatch.
readIn(root, thenHandle as any);
