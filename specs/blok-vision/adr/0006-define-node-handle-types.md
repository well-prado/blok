# ADR 0006 - Carry `defineNode` output types into `step()` handles

- **Status:** Accepted (spike resolution - unblocks implementation)
- **Date:** 2026-06-28
- **Resolves:** [#424](https://github.com/well-prado/blok/issues/424)
- **Epic:** [#413](https://github.com/well-prado/blok/issues/413)
- **Prototype:** `specs/blok-vision/adr/0006-define-node-handle-types-prototype.ts`

## Finding

Today's `defineNode` signature is generic over the Zod input and output schemas:

```ts
export function defineNode<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  definition: FnNodeDefinition<TInput, TOutput>,
): FunctionNode<TInput, TOutput>
```

But `TOutput` is not extractable enough for the new `step()` type surface: it is not exposed through a public type witness on the value. A conditional type over the imported node collapses to `unknown` in the prototype. The erasure then becomes total once nodes are placed into broad registry types such as `BlokService<unknown>` / `NodeBase` maps.

So `defineNode` can stay runtime-identical, but its return type needs a public phantom witness.

## Decision

`step("id", node, inputs)` extracts input/output types from a public phantom on the node value:

- `FunctionNode<TInput,TOutput> & NodeTypeWitness<z.infer<TInput>, z.infer<TOutput>>` -> `inputs: Refable<Input>`, returns `Handle<Output>`;
- `runtimeNode<In,Out>(...)` stubs expose the same `inputs: Refable<In>`, returns `Handle<Out>`;
- untyped/no-schema nodes degrade to `unknown`, not `any`.

`Handle<T>` is assignable to `T` so handles can appear wherever literal input values are expected. At lowering time the handle is still detected by a private symbol and turned into a structural `{$ref}`.

## Required changes

- Keep `defineNode` runtime-identical, but add a phantom type witness to its declared return type.
- Add exported helper types, or equivalent internal types, for `InputOf<N>` and `OutputOf<N>`.
- Type the new `step()` overload against the imported node value before registry erasure.
- Keep registry maps for execution, but do not use `Record<string, BlokService<unknown>>` as the type source for authoring.
- For nodes without a schema, require either an explicit `runtimeNode<In,Out>` annotation or produce `Handle<unknown>`.

This does not break `Nodes.ts` during migration. Existing registry files can stay broad; the new DSL gets types from direct imports and generated runtime stubs.

## Edge cases

- **No explicit output schema:** current `defineNode` requires `output`; no-schema runtime stubs become `unknown` unless explicitly annotated.
- **Union output:** `Handle<A | B>` preserves the union; authors must narrow before reading variant-only fields.
- **Array output:** `Handle<T[]>` preserves array methods/types enough for assignment, but structural ref capture still needs proxy handling for numeric indexes.
- **Runtime stubs:** `runtimeNode<In,Out>` shares the same `step()` extraction contract without Zod.
- **Mixed literals and handles:** `Refable<T>` recursively allows handles at leaves or whole-object positions.

## Prototype

Run:

```bash
bunx tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module ESNext specs/blok-vision/adr/0006-define-node-handle-types-prototype.ts
```

The prototype proves current direct `defineNode` imports collapse to `unknown` for `step()` extraction, a phantom witness fixes it without runtime changes, inputs are checked, handles can be used as input values, union/array outputs survive, runtime stubs share the contract, and registry erasure still loses the type.
