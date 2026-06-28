# ADR 0005 - Arm-scoped handles

- **Status:** Accepted (spike resolution - unblocks implementation)
- **Date:** 2026-06-28
- **Resolves:** [#320](https://github.com/well-prado/blok/issues/320)
- **Epic:** [#310](https://github.com/well-prado/blok/issues/310)
- **Prototype:** `specs/blok-vision/adr/0005-arm-handle-scope-prototype.ts`

## Decision

Reject handles from sibling or exited control-flow scopes during authoring/lowering with the builder-scope guard from ADR 0003. Do not build a full TypeScript arm-scope proof system into the public API.

Allowed:

- a root/top-level handle read inside a branch, switch case, loop body, or try/catch/finally child;
- a handle read inside the same arm/body where it was produced;
- a value explicitly returned from a control-flow primitive, or both arms writing to the same `as` key and reading that key after the flow step.

Rejected:

- `then` handle read in `else`;
- `switch case A` handle read in `case B` or after the switch;
- `try` handle read in `catch`;
- `forEach` item/body handle read after the loop;
- any read from an `ephemeral: true` handle.

## Why not pure TypeScript

The prototype proves branded scopes are possible, but only if every handle carries an owner scope and every API that consumes inputs recursively constrains those inputs against the current scope. That adds at least these public concepts:

- opaque scope brands for root, branch arms, switch cases, try/catch/finally, and loop bodies;
- a recursive `ReadableIn<CurrentScope, T>` input constraint;
- scope-threaded overloads for `step`, `branch`, `switch`, `tryCatch`, `forEach`, `tpl`, and condition helpers;
- escape hatches for dynamic/deferred functions, `any`, generated workflows, and JSON workflows, which the type system cannot police.

That is a lot of type machinery for a rule the builder already knows exactly at lowering time. Worse, it does not cover JSON workflows or `any`, and it moves errors into complex generic messages. Runtime authoring validation is smaller and catches every authoring surface.

## Guard wording

Use this error shape:

```text
Handle from step "<id>" is not readable from this scope. A step created inside a branch/switch/tryCatch/forEach arm can only be read inside that same arm or a descendant. Return a value from the control-flow step, or write both arms to the same `as` key.
```

For ephemeral:

```text
Step "<id>" is ephemeral, so its handle cannot be read. Remove `ephemeral: true`, read `prev` in the immediately next step, or publish an explicit value.
```

## Edge cases

- **Branch then/else:** sibling reads throw; outer handles are allowed in both arms.
- **Switch cases:** each case/default is a sibling scope; case-local handles cannot be read by another case or after the switch.
- **try/catch/finally:** `try` handles cannot be read in `catch`, because the try step may have failed before persisting. `finally` gets only outer handles and explicit control-flow outputs.
- **After a branch:** arm-local handles are invalid; use a branch return value or shared `as`.
- **forEach:** item and body-step handles are scoped to the body; the loop step's own output array is the readable value after the loop.
- **ephemeral:** unreadable even on the taken path because `ctx.state[id]` is intentionally absent.

## Implementation note

ADR 0003's builder stack already tracks ancestry. Use that to validate every handle while lowering inputs, `tpl` segments, and branch conditions. The type layer can still improve autocomplete for normal handles, but it should not attempt to be the sole correctness boundary.
