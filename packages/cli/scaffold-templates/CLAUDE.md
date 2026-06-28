# CLAUDE.md — Blok quick reference

This is the **terse operational reference**. For the full authoring guide — every trigger,
node + workflow rules, control flow, reliability, and examples — **read `AGENTS.md`** in this
project root. Before writing any workflow, read **`.blok/config.json`** to see which triggers
and runtimes this project actually has, and author for those (don't default to HTTP).

## Commands

```bash
blokctl dev                              # Start trigger(s) + spawn configured runtimes
blokctl create node <name>               # Scaffold a TS node (--runtime go|rust|java|csharp|php|ruby|python3)
blokctl create workflow <name>           # Scaffold a workflow
blokctl trace                            # Open Blok Studio (or visit /__blok on the running server)
```

## Authoring (the one correct way)

TypeScript workflows use the **typed-handle DSL** from `@blokjs/core`. Each `step()` returns a
typed handle you reference directly — **no `$`, no `js/`, no raw `ctx` strings**.

```ts
import { workflow, step, branch, gt, http, tpl } from "@blokjs/core";

export default workflow("Process Order", { version: "1.0.0", trigger: http.post("/orders") }, (req) => {
  const order = step("validate", orderValidator, { order: req.body });   // typed handle
  step("summary", summarize, { line: tpl`order ${order.id}` });          // reference fields directly
  branch("big", gt(order.total, 100), { then: () => { step("vip", flagVip, { id: order.id }); } });
});
```

Trigger config: `http.{get,post,…}(path?)` for HTTP; raw block for the rest
(`{ worker: { queue } }`, `{ cron: { schedule } }`, …). Entry handle per trigger:
`http→req`, `worker→job`, `cron→tick`, `webhook→event`, `pubsub→msg`, `grpc→rpc`.

Nodes: `export default defineNode({ name, description, input: z…, output: z…, execute })` from
`@blokjs/core`. Just **return** your output — the runner persists it to `ctx.state[<step-id>]`.
A node at `src/nodes/<name>/index.ts` is **auto-discovered** by its `name` (the `use:` ref).

## State & persistence

- Every step auto-persists to `ctx.state[id]` **on success**; reference it via the handle
  (`h`, `h.field`) — never `$.state.id`. A step that throws writes nothing.
- 4th arg to `step`: `{ as: "name" }` (rename), `{ spread: true }` (flatten output keys),
  `{ ephemeral: true }` (skip persistence — handle then unreadable), plus `idempotencyKey`,
  `retry`, `maxDuration`.

## Control flow (all from `@blokjs/core`)

`branch(id, cond, { then, else? })` · `forEach(iterable, (item, i) => {}, { as?, mode? })` ·
`switchOn(disc, { cases: [{ when, do }], default? }, { id })` ·
`tryCatch(id, { try, catch: (err) => {}, finally? })`. Conditions use the typed comparators
`eq/ne/gt/gte/lt/lte/not`; strings use `tpl\`…${h.x}…\``.

## The four footguns ⚠️

1. **Arm-scoped handles don't escape their arm** — write both arms to one `as:` key to use a result downstream.
2. **Ephemeral handles read `undefined`.**
3. **Never reuse a step `id`** (incl. across arms) — throws at load.
4. **Never name a `forEach` `as:` after an existing id** — throws at load.

## Do NOT

- No `ctx.state`/`ctx.vars` writes inside a node — just return.
- No `js/…`/`$.…` in a `branch`/`switch` `when` — use the comparators.
- No `queue` trigger (dead → `worker`); no `"*"` method (→ `"ANY"`).
- No class-based `BlokService`; no `any` (use `z.unknown()`); never skip Zod schemas.
- No duplicate node `name` (throws); no response objects built inside a node (use `@blokjs/respond`).

→ Full guide with examples for all 9 triggers, reliability, sub-workflows, and testing: **`AGENTS.md`**.
