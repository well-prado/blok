// Type-only spike for ADR 0006. Run with:
// bunx tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module ESNext specs/blok-vision/adr/0006-define-node-handle-types-prototype.ts

import type { z } from "zod";
import { z as zod } from "zod";
import type BlokService from "../../../core/runner/src/Blok";
import { type FnNodeDefinition, defineNode } from "../../../core/runner/src/defineNode";

declare const handleBrand: unique symbol;
declare const nodeTypes: unique symbol;

type Handle<T> = T & { readonly [handleBrand]?: T };
type Refable<T> = T extends readonly (infer Item)[]
	? Handle<T> | readonly Refable<Item>[]
	: T extends object
		? Handle<T> | { [K in keyof T]: Refable<T[K]> }
		: T | Handle<T>;

type NodeTypeWitness<Input, Output> = { readonly [nodeTypes]?: { input: Input; output: Output } };

type TypedFunctionNode<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny> = ReturnType<
	typeof defineNode<Input, Output>
> &
	NodeTypeWitness<z.infer<Input>, z.infer<Output>>;

type InputOf<N> = N extends NodeTypeWitness<infer Input, unknown>
	? Input
	: N extends RuntimeNode<infer Input, unknown>
		? Input
		: unknown;

type OutputOf<N> = N extends NodeTypeWitness<unknown, infer Output>
	? Output
	: N extends RuntimeNode<unknown, infer Output>
		? Output
		: unknown;

type RuntimeNode<Input, Output> = { readonly kind: "runtimeNode"; readonly input?: Input; readonly output?: Output };

declare function runtimeNode<Input = unknown, Output = unknown>(
	name: string,
	runtime: string,
): RuntimeNode<Input, Output>;

function defineTypedNode<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
	definition: FnNodeDefinition<Input, Output>,
): TypedFunctionNode<Input, Output> {
	return defineNode(definition) as TypedFunctionNode<Input, Output>;
}

declare function step<N>(id: string, node: N, inputs: Refable<InputOf<N>>): Handle<OutputOf<N>>;

const currentDefineNode = defineNode({
	name: "@demo/current",
	description: "Current defineNode output extraction check",
	input: zod.object({}),
	output: zod.object({ value: zod.string() }),
	execute() {
		return { value: "typed internally, not extractable by step" };
	},
});

const currentOutput = step("current", currentDefineNode, {});
const currentOutputIsUnknown: unknown = currentOutput;

const fetchUser = defineTypedNode({
	name: "@demo/fetch-user",
	description: "Fetch a user",
	input: zod.object({
		userId: zod.string(),
		filter: zod.object({ active: zod.boolean() }),
	}),
	output: zod.object({
		user: zod.object({
			id: zod.string(),
			tags: zod.array(zod.string()),
		}),
	}),
	execute(_ctx, input) {
		const userId: string = input.userId;
		return { user: { id: userId, tags: [] } };
	},
});

const source = defineTypedNode({
	name: "@demo/source",
	description: "Source values",
	input: zod.object({}),
	output: zod.object({ userId: zod.string(), active: zod.boolean() }),
	execute() {
		return { userId: "u1", active: true };
	},
});

const src = step("source", source, {});
const user = step("fetch", fetchUser, { userId: src.userId, filter: { active: src.active } });

const id: string = user.user.id;
const tags: string[] = user.user.tags;

// @ts-expect-error userId must be string-like
step("bad-input", fetchUser, { userId: 123, filter: { active: true } });

// @ts-expect-error active must be boolean-like
step("bad-nested-input", fetchUser, { userId: "u1", filter: { active: "yes" } });

const unionNode = defineTypedNode({
	name: "@demo/union",
	description: "Union output",
	input: zod.object({}),
	output: zod.union([
		zod.object({ kind: zod.literal("a"), a: zod.string() }),
		zod.object({ kind: zod.literal("b"), b: zod.number() }),
	]),
	execute() {
		return { kind: "a", a: "ok" } as const;
	},
});

const unionHandle = step("union", unionNode, {});
if (unionHandle.kind === "a") {
	const value: string = unionHandle.a;
}

const runtime = runtimeNode<{ prompt: string }, { answer: string }>("@demo/ask", "runtime.python3");
const answer = step("ask", runtime, { prompt: user.user.id });
const answerText: string = answer.answer;

// No schema / no explicit type degrades to unknown.
const unknownRuntime = runtimeNode("@demo/unknown", "runtime.go");
const unknownHandle = step("unknown", unknownRuntime, {});
const unknownValue: unknown = unknownHandle;

const erased: BlokService<unknown> = fetchUser;
type ErasedOut = OutputOf<typeof erased>;
const erasedOutputIsUnknown: unknown = null as unknown as ErasedOut;
