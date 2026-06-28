/**
 * TYPE-LEVEL test for the typed-handle foundation (ADR 0007 authoritative, ADR 0006
 * extraction contract). Compiled by `tsc --noEmit` via `tsconfig.typetest.json`
 * (wired into `bun run typecheck`). Every `@ts-expect-error` below is an assertion:
 * if the type ever becomes too loose (the error disappears), tsc fails the build.
 *
 * No runtime — `consume` is `declare`d, nothing executes. This file proves the
 * COMPILE-TIME contract; runtime regression is covered by the existing
 * core/runner + workflow-helper vitest suites.
 */

import { z } from "zod";
import { defineNode } from "../defineNode";
import type { EphemeralHandle, Handle, InputOf, OutputOf, Refable } from "../handles";
import { runtimeNode } from "../handles";

// A workflow input that expects `T` accepts a handle for `T` (the `Refable` boundary).
declare function consume<T>(value: Refable<T>): void;

// --- ADR 0007: Handle<T> proxy soundness ---------------------------------------

type Output = {
	id: string;
	profile: {
		email: string;
		maybe?: { x: number };
	};
	items: Array<{ sku: string; qty: number }>;
};

declare const handle: Handle<Output>;

// nested object field reads
consume<string>(handle.id);
consume<string>(handle.profile.email);

// optional field: `?.` type-checks and yields the optional value type
consume<number | undefined>(handle.profile.maybe?.x);

// array element via numeric index recurses into the element handle
consume<string>(handle.items[0].sku);

// whole-output ref: pass the handle itself
consume<Output>(handle);

// @ts-expect-error unknown field is not referenceable
consume(handle.profile.nope);

// @ts-expect-error array `.length` is not a declared data path (banned member)
consume(handle.items.length);

// @ts-expect-error array methods are not declared data paths (banned member)
handle.items.map((item) => item.sku);

// @ts-expect-error `.length` is banned even on a whole-output array handle
(null as unknown as Handle<string[]>).length;

// union outputs expose ONLY fields common to every member; no narrowing through a proxy
type UnionOutput = { kind: "a"; a: string } | { kind: "b"; b: number };
declare const unionHandle: Handle<UnionOutput>;

consume<"a" | "b">(unionHandle.kind);

// @ts-expect-error variant-only field is not exposed without a real narrowing node
consume(unionHandle.a);

// @ts-expect-error variant-only field is not exposed without a real narrowing node
consume(unionHandle.b);

// whole-output array: numeric index works, member reads do not
type ArrayOutput = Array<{ sku: string }>;
declare const arrayHandle: Handle<ArrayOutput>;

consume<string>(arrayHandle[0].sku);

// @ts-expect-error array member reads are banned even on whole-output arrays
consume(arrayHandle.length);

// --- #339: EphemeralHandle<T> is unreadable at the type level ------------------

declare const ephemeral: EphemeralHandle<Output>;

// @ts-expect-error an ephemeral handle exposes NO readable fields
consume(ephemeral.id);

// @ts-expect-error an ephemeral handle is not numerically indexable
consume((null as unknown as EphemeralHandle<string[]>)[0]);

// @ts-expect-error an ephemeral handle is NOT a Refable input — passing it as a step input is a compile error
consume<Output>(ephemeral);

// --- ADR 0006: type extraction off a `defineNode` value ------------------------

const fetchUser = defineNode({
	name: "@demo/fetch-user",
	description: "Fetch a user",
	input: z.object({
		userId: z.string(),
		filter: z.object({ active: z.boolean() }),
	}),
	output: z.object({
		user: z.object({
			id: z.string(),
			tags: z.array(z.string()),
		}),
	}),
	execute(_ctx, input) {
		const userId: string = input.userId;
		return { user: { id: userId, tags: [] } };
	},
});

// The phantom witness on the DECLARED return type survives import: Input/Output
// are recovered, not erased to `unknown`.
type FetchUserInput = InputOf<typeof fetchUser>;
type FetchUserOutput = OutputOf<typeof fetchUser>;

declare const fetchUserInput: FetchUserInput;
const checkUserId: string = fetchUserInput.userId;
const checkActive: boolean = fetchUserInput.filter.active;

declare const fetchUserOutput: FetchUserOutput;
const checkId: string = fetchUserOutput.user.id;
const checkTags: string[] = fetchUserOutput.user.tags;

// A handle over the extracted output behaves per ADR 0007.
declare const userHandle: Handle<FetchUserOutput>;
consume<string>(userHandle.user.id);
consume<string[]>(userHandle.user.tags);

// Inputs are checkable against `Refable<InputOf<N>>`, mixing literals and handles.
declare const userIdHandle: Handle<string>;
const okMixedInput: Refable<FetchUserInput> = {
	userId: userIdHandle, // handle at a leaf
	filter: { active: true }, // literal
};
void okMixedInput;

// @ts-expect-error wrong leaf type: userId must be string-like
const badLeaf: Refable<FetchUserInput> = { userId: 123, filter: { active: true } };
void badLeaf;

// @ts-expect-error wrong nested leaf type: active must be boolean-like
const badNestedLeaf: Refable<FetchUserInput> = { userId: "u1", filter: { active: "yes" } };
void badNestedLeaf;

// --- ADR 0006: runtimeNode stub shares the extraction contract -----------------

const ask = runtimeNode<{ prompt: string }, { answer: string }>("@demo/ask", "runtime.python3");
type AskInput = InputOf<typeof ask>;
type AskOutput = OutputOf<typeof ask>;

declare const askInput: AskInput;
const checkPrompt: string = askInput.prompt;
declare const askHandle: Handle<AskOutput>;
consume<string>(askHandle.answer);

// No schema / no explicit type params degrades to `unknown` — NEVER `any`.
const opaque = runtimeNode("@demo/opaque", "runtime.go");
type OpaqueOutput = OutputOf<typeof opaque>;
const opaqueIsUnknown: unknown = null as unknown as OpaqueOutput;
void opaqueIsUnknown;

// `any` would let this assignment compile silently; `unknown` does not — proving
// the degrade target is `unknown`, not `any`.
// @ts-expect-error OpaqueOutput is `unknown`, not `any`: cannot assign to a concrete type
const opaqueNotAny: string = null as unknown as OpaqueOutput;
void opaqueNotAny;

// Touch the recovered values so `noUnusedLocals` (if ever re-enabled) stays happy
// and the assertions are observably exercised.
void [checkUserId, checkActive, checkId, checkTags, checkPrompt];
