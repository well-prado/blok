## A. Refined Typed TS DSL

## The pitch
Keep TypeScript as the single source of truth, but delete the `$` proxy and every `js/...` string. Each step gets a typed **handle**; later steps read prior outputs as plain, autocompleted TS — `steps.checkStock.inStock` — checked by `tsc`, not stringified and `eval`'d at runtime. The data flow you read is the data flow that runs. A typo is a compile error, not a 2am `MapperResolutionError`.

## Workflow file
`workflows/orders/intake.flow.ts` — borrows GitHub Actions' `steps.<id>.outputs` readability, but as real typed objects instead of strings.

```ts
import { workflow, branch, http } from "@blokjs/helper";
import { validateOrder } from "../../nodes/validate-order";
import { httpGet, createOrder, respond } from "@blokjs/helpers";

export default workflow("order-intake", (s) => {
  const validate = s.step(validateOrder, { body: s.trigger.body });          // {productId, qty}

  const checkStock = s.step(httpGet, {
    url: s.tpl`https://inventory.internal/stock/${validate.productId}`,        // typed interpolation
  });

  return branch(checkStock.inStock, {                                          // boolean handle, no string
    then: (s) => {
      const order = s.step(createOrder, { productId: validate.productId, qty: validate.qty, stock: checkStock });
      return s.step(respond, { status: 201, body: order });
    },
    else: (s) => s.step(respond, { status: 409, body: { error: "out of stock" } }),
  });
}, { trigger: http.post("/orders") });
```

`s.step(node, inputs)` registers a step (id = the variable name via build-time codegen, or `s.step(node, inputs, { id })`) and **returns a typed handle** shaped like the node's Zod `output`. The builder records each handle's `id` so it compiles to the same declarative step list Studio renders — no imperative escape hatch, fully static.

## Data flow
The reference mechanism is **the handle returned by `s.step`**. `checkStock.inStock` is a typed property access on `httpGet`'s inferred output type. At build time the handle stringifies to a structured binding (`{from:"checkStock", path:"inStock"}`) the runner resolves — but the author never sees or writes a string. Borrowed from Airflow/Temporal (variable-name *is* the edge) + GitHub Actions (`steps.<id>.outputs.<field>` reads as English), minus the stringliness.

```ts
// BEFORE (today): opaque string, typo = runtime crash, three dialects
inputs: { url: $.state.checkStock.inStock }              // proxy → "js/ctx.state..."
when: 'ctx.state.checkStock.inStock === true'            // raw-ctx string, the documented footgun

// AFTER (Option A): one form, autocompleted, tsc-checked, rename-safe
s.step(createOrder, { stock: checkStock })               // whole output
branch(checkStock.inStock, { ... })                      // boolean handle, same as any other ref
```

One dialect everywhere. `branch.when` stops being special — it takes the same handle type as any input, killing the raw-`ctx` footgun outright.

## Node definition
Unchanged — `defineNode()` is already clean and is *not* the founder's problem. The only addition: the inferred `output` Zod type is what makes the handle typed downstream.

```ts
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export const validateOrder = defineNode({
  name: "validate-order",
  description: "Validates order request body",
  input: z.object({ body: z.object({ productId: z.string(), qty: z.number().int().positive() }) }),
  output: z.object({ productId: z.string(), qty: z.number() }),   // ← becomes validate.productId
  async execute(_ctx, input) {
    return { productId: input.body.productId, qty: input.body.qty };
  },
});
```

## Trigger
Declarative, passed once as the workflow's options arg — co-located but not tangled in the steps. Typed helpers (`http.post`, `http.any`, `worker(queue)`, `cron(pattern)`) replace the freeform `{ http: { method, path } }` object so the method/path are checked and autocompleted. `s.trigger.body` is a typed handle into the request — same mechanism as step handles, so the request reads like any other output.

```ts
{ trigger: http.post("/orders") }
// s.trigger.body / s.trigger.query.* / s.trigger.params.id  ← all typed handles
```

## Layout file (separate)
Greenfield (no layout exists today). A sibling `*.layout.json` keyed by **stable step id**, owned by Studio, ignored by the runner. Optional: if absent, Studio auto-lays-out from the dependency DAG (Airflow/Dagster model). Borrowed from Windmill OpenFlow's clean logic/canvas split — and the explicit anti-pattern is n8n's inline `position`.

```json
// workflows/orders/intake.layout.json
{ "version": 1,
  "nodes": {
    "validate":    { "x": 0,   "y": 0 },
    "checkStock":  { "x": 220, "y": 0 },
    "order":       { "x": 440, "y": -80 },
    "respond":     { "x": 660, "y": -80 }
  },
  "viewport": { "zoom": 1, "x": 0, "y": 0 } }
```

## Pros
- **Zero new dialect to learn** — it's just TypeScript. No `$`, no `js/`, no `${}`, no raw-`ctx` special case.
- **`tsc` is the linter.** Typo'd ref, wrong type into an input, renamed output field → compile error at author time, not `MapperResolutionError` at run time.
- **Full autocomplete + go-to-definition + rename-refactor** on every cross-step reference.
- **Rename-safe by construction** — references key off the handle/id, never a display name (avoids n8n's three-way coupling).
- **Still static & renderable.** The builder emits a declarative step list, so Studio canvas + JSON export survive.

## Cons / risks
- **Codegen/AST step to derive step `id` from the variable name** (or authors pass `{ id }` explicitly) — a real build-time cost the runner must own.
- **Handle-to-binding compilation is non-trivial.** `checkStock.inStock` must serialize to a structured ref *and* type-check — a `Proxy` with full type inference is fiddly to get sound (today's `$` is the cautionary tale).
- **Round-trip to JSON/Studio is lossy-ish.** Control flow as nested builder callbacks (`then: (s) => ...`) is harder to regenerate from a visually-edited graph than a flat JSON `branch` block.
- **Developers only.** A domain expert can read it; they can't author it without TS.

## Who it's for
**Devs first** — this is "the best possible version of today." Read-only legible to **non-coders** (it scans like a recipe) but they author on the canvas, not here. **AI-friendly**: typed handles + Zod schemas give an LLM compile-time feedback, so generated workflows fail loudly at build instead of silently mis-wiring.

## Readability verdict
Reads like Temporal (variables as edges) with GitHub Actions' `steps.<id>.field` clarity — and unlike today, what you read is type-checked and rename-safe, not a `Proxy`-to-`eval` round-trip.

`workflows/orders/intake.flow.ts` + `intake.layout.json` (separate). Skipped: actual builder/codegen impl — this is a design spec, not a PR.