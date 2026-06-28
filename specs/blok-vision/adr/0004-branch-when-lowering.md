# ADR 0004 - Branch `when` lowering for handles and typed ops

- **Status:** Accepted (spike resolution - unblocks implementation)
- **Date:** 2026-06-28
- **Resolves:** [#417](https://github.com/well-prado/blok/issues/417)
- **Epic:** [#413](https://github.com/well-prado/blok/issues/413)
- **Prototype:** `specs/blok-vision/adr/0004-branch-when-lowering-probe.ts`

## Decision

`branch(handleOrOp, arms)` lowers conditions to the raw JavaScript string consumed by `@blokjs/if-else`, not to `{$ref}` and not to a `js/` mapper string.

Mapping:

| Input | Branch `condition` string |
|---|---|
| boolean field handle from step `stock.inStock` | `ctx.state.stock.inStock` |
| whole-output boolean handle from step `isOk` | `ctx.state.isOk` |
| `eq(a.field, "x")` | `ctx.state.a.field === "x"` |
| `gt(a.count, b.limit)` | `ctx.state.a.count > ctx.state.b.limit` |
| `not(a.ok)` | `!(ctx.state.a.ok)` |
| handle from `{ as: "alias" }` step | `ctx.state.alias...` |
| field handle from `{ spread: true }` step | `ctx.state.<firstField>...` |

This is the third lowering from ADR 0001:

- step inputs: `{$ref}` -> `js/ctx.state...` before `Mapper`;
- `tpl`: structural segments -> `js/\`...\`` before `Mapper`;
- branch `when`: handle/op -> bare `ctx.state...` because `@blokjs/if-else` calls `Function("ctx", ...)` directly.

## `as` and `spread`

The state root is determined by the producing step's persistence metadata:

- default: root is `step.id`;
- `as`: root is `step.as`;
- `spread`: the first handle path segment becomes the root key.

So `step("load", node, { spread: true }).user.active` lowers to `ctx.state.user.active`, not `ctx.state.load.user.active`.

A whole-output ref from a `spread` step is invalid in `when`; `spread` intentionally removes the step root. Authors must read a field or use `as` instead.

## Literals and operators

Typed comparison helpers use JavaScript operators and JSON literals:

- `eq`, `ne`, `gt`, `gte`, `lt`, `lte` produce infix raw-ctx expressions;
- `not(value)` wraps the lowered operand as `!(...)`;
- string/number/boolean/null literals are encoded with `JSON.stringify`;
- `undefined`, functions, symbols, and arbitrary objects are rejected as condition operands.

## Probe results

Run:

```bash
bun specs/blok-vision/adr/0004-branch-when-lowering-probe.ts
```

The probe verifies default, `as`, and `spread` state roots; whole-output boolean handles; handle-to-handle comparisons; negation; falsy conditions; invalid whole-spread refs; and that the generated strings evaluate with the same raw `Function("ctx", ...)` shape used by `@blokjs/if-else`.

## Deck correction

Any deck/spec text implying branch conditions use the same `{$ref}` surface as inputs should be changed to: branch conditions are structural while authoring, then lower to raw `ctx.state...` strings for today's if-else node.
