# CLAUDE.md - Blok quick reference

Read `AGENTS.md` for the full repo guide. Keep this file and
`docs/d/fundamentals/context-and-state.mdx` in sync when authoring rules change.

## Commands

```bash
bun install
bun run build
bun run test
bun run lint
bun run ci:fast
bun run http:dev
bun run cli:test
bun run runner:test
blokctl dev
```

## Authoring

New TypeScript workflows use the typed-handle DSL from `@blokjs/core`.
Do not author workflow data flow with `$` proxies, `js/` strings, or raw
`ctx` condition strings.

```ts
import { branch, gt, http, step, tpl, workflow } from "@blokjs/core";

export default workflow("Process Order", { version: "1.0.0", trigger: http.post("/orders") }, (req) => {
  const order = step("validate", orderValidator, { body: req.body });
  step("summary", summarize, { line: tpl`order ${order.id}` });
  branch("big", gt(order.total, 100), {
    then: () => {
      step("vip", flagVip, { id: order.id });
    },
  });
});
```

- The callback argument is the trigger entry handle: `req`, `job`, `event`,
  `msg`, `tick`, `rpc`, `conn`, `stream`, or `call`.
- `step()` returns a typed output handle. Read `h` or `h.field` downstream.
- Use `tpl` for strings containing handles.
- Use branch operators `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `not`, or a
  boolean handle.
- Use `js` tagged templates only for non-structural escape hatches.

## Nodes

Use `defineNode()` from `@blokjs/core`. Keep `input` and `output` Zod schemas.
Inside `execute(ctx, input)`, upstream workflow values arrive through `input`.
The node-side `ctx` ABI is kept for runtime concerns: `ctx.request`,
`ctx.logger`, `ctx.env`, `ctx.signal`, `ctx.publish`, and trigger-specific
`ctx.connection` / `ctx.stream`.

Never write `ctx.state` or `ctx.vars` inside a node. Return output and let the
runner persist it.

## State

- Every successful step persists to `ctx.state[id]`.
- A thrown step writes nothing.
- The handle returned by `step()` is the authoring read path.
- Fourth-arg knobs: `{ as: "name" }`, `{ spread: true }`,
  `{ ephemeral: true }`, plus reliability fields such as `idempotencyKey`,
  `retry`, and `maxDuration`.
- `ephemeral: true` means no state slot; do not read the returned handle.

## Footguns

1. Arm-scoped handles do not escape their branch/switch/tryCatch arm.
2. Ephemeral handles are unreadable.
3. Step ids are one flat namespace, including mutually exclusive arms.
4. `forEach` `as` and `asIndex` keys share the same state namespace as step ids.

## Legacy

Object-style `workflow({ steps: [...] })` and JSON workflows are supported for
migration and compatibility. New TS code should use callback handles. When
reading old workflows, translate request reads to the entry handle, state reads
to the producing step handle, templates to `tpl`, and branch comparisons to
typed operators. `@blokjs/expr` is the exception: its `expression` input is
plain JavaScript for that node, without a mapper prefix.

## Do NOT

- Do not create class-based `BlokService` nodes.
- Do not skip Zod schemas.
- Do not use `any`; use `unknown` and narrow.
- Do not use a `queue` trigger; use `worker`.
- Do not use `"*"` for HTTP wildcard; use `"ANY"` or `http.any()`.
- Do not edit generated `.blok/runtimes/` files.
- Do not use ESLint or Prettier; this repo uses Biome.
