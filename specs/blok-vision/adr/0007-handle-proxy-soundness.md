# ADR 0007 - Typed handle proxy soundness

- **Status:** Accepted (spike resolution - unblocks implementation)
- **Date:** 2026-06-28
- **Resolves:** [#423](https://github.com/well-prado/blok/issues/423)
- **Epic:** [#413](https://github.com/well-prado/blok/issues/413)
- **Prototype:** `specs/blok-vision/adr/0007-handle-proxy-soundness-prototype.ts`

## Decision

Model handles as structural reference proxies, not as full runtime values. `step()` inputs accept handles through `Refable<T>`, but `Handle<T>` itself only exposes referenceable paths:

- object fields become handles for their field types;
- optional object fields expose optional field handles, so `handle.maybe?.x` type-checks;
- arrays expose numeric indexes only, so `handle.items[0].sku` works;
- array members such as `.length`, `.map`, `.filter`, and `.at` are banned at the type level;
- whole-output refs are allowed by passing the handle itself as an input;
- union outputs expose only fields common to every union member; variant-only fields require narrowing inside a real node or a follow-up typed helper, not proxy magic.

This slightly corrects ADR 0006's shorthand. Handles do not need to be assignable to every plain `T` in arbitrary TypeScript; they need to be accepted wherever workflow inputs expect `T`. `Refable<T>` is that boundary.

## Terminal vs traversal

There is no leaf detection at property-read time. Every property/index access returns another handle carrying a longer path. The use site decides the terminal path:

```ts
step("send", sendEmail, { to: user.profile.email })
```

records `{ $ref: { step: "user", path: ["profile", "email"] } }`. Lowering/resolution then uses the full path (`_.get` semantics after ADR 0001 lowering), so intermediate reads are harmless until a handle is consumed.

## Why array members are banned

`handle.items.map` and `handle.items.length` look attractive because TypeScript arrays expose them, but a proxy cannot safely lower them:

- `.map` is a function-valued property, not workflow data;
- `.length` is metadata of the current runtime array, not a stable JSON field authors declared in Zod;
- recording them as `path: ["items", "map"]` or `["items", "length"]` would create refs that do not mean "map this array" or "count items" in the workflow engine.

Use a node/helper for array transforms and counts (`@blokjs/expr` during migration, later typed helpers). Numeric indexes are allowed because they are real data paths.

## Union guidance

For `Handle<{ kind: "a"; a: string } | { kind: "b"; b: number }>`, only `kind` is exposed. The proxy cannot narrow on `if (handle.kind === "a")` because no actual value exists while authoring. Put variant-specific logic inside a node, branch on the discriminator, or route through a typed helper that returns a narrowed output.

## Optional fields

Optional chaining is type-safe but not semantically special. `handle.maybe?.x` records the same path as `handle.maybe.x` when consumed: `["maybe", "x"]`. If `maybe` is absent at runtime, resolution returns `undefined`.

## Prototype

Run:

```bash
bunx tsc --noEmit --strict --skipLibCheck specs/blok-vision/adr/0007-handle-proxy-soundness-prototype.ts
```

The prototype covers nested fields, optional chaining, array indexes, banned array members, union common fields, variant-only field errors, whole-output refs, and missing field errors.
