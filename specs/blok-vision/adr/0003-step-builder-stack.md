# ADR 0003 - `step()` builder stack and handle scope

- **Status:** Accepted (spike resolution - unblocks implementation)
- **Date:** 2026-06-28
- **Resolves:** [#420](https://github.com/well-prado/blok/issues/420)
- **Epic:** [#413](https://github.com/well-prado/blok/issues/413)
- **Prototype:** `specs/blok-vision/adr/0003-step-builder-stack-probe.ts`

## Decision

`workflow(..., callback)` owns an `AsyncLocalStorage` builder stack; `step()` appends to the builder on top of that stack and returns a typed handle whose reads are only legal from its producing scope or a descendant scope.

That means:

- `step()` outside a workflow callback throws immediately.
- `branch` / `forEach` push child builders around each arm/body callback, then attach those child steps to the parent flow step.
- Duplicate step ids are checked against one flat per-workflow id set, including mutually exclusive arms.
- A handle created before a branch is readable inside either arm.
- A handle created inside one arm is not readable outside that arm or in a sibling arm; authors must return a branch result or write both arms to a shared `as` key instead.

## Why this rule

A module-global stack is the shortest code, but it fails the real edge cases: `await` inside a callback and concurrent workflow compilation during HMR/parallel load. `AsyncLocalStorage` is still tiny, uses Node's standard library, and preserves the current builder context across async boundaries without cross-contaminating concurrent workflows.

Registering at call time is also the least surprising rule for deferred functions: `const make = () => step(...)` registers wherever `make()` is invoked. If invoked after the workflow callback has exited, it throws the same "outside workflow" error as a direct `step()` call.

Cross-arm handles are rejected instead of typed as maybe-undefined. Letting them resolve to `undefined` makes the handle type lie and pushes the failure to runtime. A compile-time/runtime-authoring error is louder and matches Blok's existing "duplicate ids share one flat config map" rule.

## Probe results

Run:

```bash
bun specs/blok-vision/adr/0003-step-builder-stack-probe.ts
```

The probe verifies:

- `step()` outside a workflow callback throws a clear error.
- outer handles are readable inside branch arms;
- sibling/cross-arm handle reads throw;
- duplicate ids across branch arms throw;
- deferred `step()` registers at invocation scope;
- the builder context survives `await`;
- concurrent workflow builds do not share id sets;
- `forEach` item handles are scoped to the loop body.

## Implementation notes

Keep this as a helper-layer contract. The runner still consumes normal workflow IR after the callback factory compiles. The implementation task should wire the real typed handle and structural `{$ref}` objects from ADR 0001 into this stack model.
