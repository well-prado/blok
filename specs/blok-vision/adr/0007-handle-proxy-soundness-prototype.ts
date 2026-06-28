// Type-only spike for ADR 0007. Run with:
// bunx tsc --noEmit --strict --skipLibCheck specs/blok-vision/adr/0007-handle-proxy-soundness-prototype.ts

declare const handleBrand: unique symbol;

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
type CommonKeys<T> = {
	[K in keyof T]: T extends Record<K, unknown> ? K : never;
}[keyof T];
type CommonShape<T> = {
	[K in CommonKeys<T>]: Handle<T extends Record<K, infer Value> ? Value : never>;
};

type Handle<T> = { readonly [handleBrand]?: T } & (T extends Primitive
	? Record<never, never>
	: T extends readonly (infer Item)[]
		? { readonly [index: number]: Handle<Item> }
		: IsUnion<T> extends true
			? CommonShape<T>
			: { readonly [K in keyof T]: Handle<NonNullable<T[K]>> });

type Refable<T> =
	| Handle<T>
	| (T extends Primitive
			? T
			: T extends readonly (infer Item)[]
				? readonly Refable<Item>[]
				: {
						[K in keyof T]: Refable<T[K]>;
					});

declare function consume<T>(value: Refable<T>): void;

type Output = {
	id: string;
	profile: {
		email: string;
		maybe?: { x: number };
	};
	items: Array<{ sku: string; qty: number }>;
};

declare const handle: Handle<Output>;

consume<string>(handle.id);
consume<string>(handle.profile.email);
consume<number | undefined>(handle.profile.maybe?.x);
consume<string>(handle.items[0].sku);
consume<Output>(handle);

// @ts-expect-error unknown field is not referenceable
consume(handle.profile.nope);

// @ts-expect-error array length is not a declared data path
consume(handle.items.length);

// @ts-expect-error array methods are not declared data paths
handle.items.map((item) => item.sku);

// @ts-expect-error whole array output length is still banned
(null as unknown as Handle<string[]>).length;

type UnionOutput = { kind: "a"; a: string } | { kind: "b"; b: number };
declare const unionHandle: Handle<UnionOutput>;

consume<"a" | "b">(unionHandle.kind);

// @ts-expect-error variant-only field is not exposed without a real narrowing node
consume(unionHandle.a);

// @ts-expect-error variant-only field is not exposed without a real narrowing node
consume(unionHandle.b);

type ArrayOutput = Array<{ sku: string }>;
declare const arrayHandle: Handle<ArrayOutput>;

consume<string>(arrayHandle[0].sku);

// @ts-expect-error array member reads are banned even on whole-output arrays
consume(arrayHandle.length);
