I have everything I need from the research brief. Let me design Option D.

## D. Fluent Pipeline / Hybrid

## The pitch
A workflow is an ordered list of named steps where each step's `id` becomes a variable the next steps read by name — `inputs: { productId: validate.out.productId }`, not `"$.state.validate.productId"`. It reads top-to-bottom like a pipeline (GitHub Actions `steps.<id>.outputs` + Airflow's "the name is the edge"), stays 100% declarative so a canvas can render it without executing code (unlike Trigger.dev), and the reference is a typed handle the compiler checks — so a typo is a build error, not a 3am `MapperResolutionError`. No `$`, no `js/`, no `ctx`.

## Workflow file
`orders/intake.flow.ts` — borrows GitHub Actions `steps.<id>.outputs.<field>` reads + n8n's *ordered* list (not its name-keyed graph).

```ts
import { flow, http, branch } from "@blokjs/flow";
import { validateOrder } from "../nodes/validate-order";
import { createOrder } from "../nodes/create-order";

export default flow("order-intake", (s) => {
  const req = http.post("/orders");                       // trigger → typed handle

  const v = s.step("validate", validateOrder, { body: req.body });
  const stock = s.http("checkStock", {                    // built-in HTTP node
    url: "https://inv.api/stock", query: { productId: v.out.productId },
  });

  return branch(stock.out.inStock, {
    then: (s) => {
      const order = s.step("createOrder", createOrder, {
        productId: v.out.productId, qty: v.out.qty, stock: stock.out,
      });
      return s.respond(201, order.out);                   // body = createOrder output
    },
    else: (s) => s.respond(409, { error: "out of stock" }),
  });
});
```

## Data flow
The reference IS the variable. `s.step("validate", ...)` returns a handle whose `.out` is typed from the node's Zod **output** schema. Later steps read `v.out.productId` — autocompletes, rename-safe, `tsc`-checked. The builder records each access as a structural edge `{ from: "validate", path: "productId" }`, so it compiles to renderable JSON (a canvas reads the edges without running anything) — that's the Trigger.dev-readability / n8n-renderability synthesis with neither's downside.

```
today:  inputs: { productId: $.state.validate.productId }   // proxy → "js/ctx.state.validate.productId" → eval'd
        when:   'ctx.request.query.x === "true"'            // 3rd dialect, raw ctx, footgun

D:      inputs: { productId: v.out.productId }              // typed handle, no $, no js/, no ctx
        branch(stock.out.inStock, …)                        // same handle in conditions — ONE dialect
```

## Node definition
`defineNode()` is unchanged — the research is unanimous it's already clean. The only addition: the output schema now also types the `.out` handle upstream, so the node *is* the contract for both validation and references.

```ts
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export const validateOrder = defineNode({
  name: "validate-order",
  input:  z.object({ body: z.object({ productId: z.string(), qty: z.number() }) }),
  output: z.object({ productId: z.string(), qty: z.number().int().positive() }),
  async execute(_ctx, { body }) {
    if (body.qty <= 0) throw new Error("qty must be positive");
    return { productId: body.productId, qty: body.qty };   // shape == .out handle
  },
});
```

## Trigger
Declared as the **first line of the flow body** and returns a typed handle — GitHub Actions' "one readable `on:` block at the top" + Trigger.dev's flat options, but it doubles as the `req` you read from. No separate trigger map, no `ctx.request`.

```ts
const req = http.post("/orders");          // → req.body, req.query, req.params typed
// variants: http.get(path) · cron("0 5 * * *") · worker("orders-queue") · webhook("stripe")
// knobs are flat siblings:  http.post("/orders", { concurrencyKey: req => req.body.tenantId })
```

## Layout file (separate)
`orders/intake.layout.json` — Windmill OpenFlow precedent: logic file has **zero** coordinates; Studio owns this, keyed by step `id`, runner ignores it. Optional — missing positions auto-layout from the edge graph (Airflow/Dagster).

```json
{
  "flow": "order-intake",
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "nodes": {
    "validate":    { "x": 120, "y": 80 },
    "checkStock":  { "x": 120, "y": 220 },
    "createOrder": { "x": 40,  "y": 360 },
    "respond-201": { "x": 40,  "y": 500 },
    "respond-409": { "x": 320, "y": 360 }
  }
}
```

## Pros
- **One dialect, everywhere.** Same `v.out.x` handle in `inputs` AND in `branch(...)` conditions — kills today's three-way split (`$` proxy / `js/...` strings / raw `ctx` in `when`).
- **Typo = compile error.** Handles are typed from the node's Zod output; `v.out.prdId` fails `tsc`, not at run time.
- **Reads top-to-bottom as a pipeline** while staying declarative → a canvas renders it without executing code. Devs get Trigger.dev clarity; Studio gets n8n renderability.
- **Rename-safe + layout-free logic.** References key off structural `id`; canvas lives in a sibling file with clean diffs.
- **Keeps Blok's wins:** `defineNode()` untouched, per-step knobs (`as`/`ephemeral`/`retry`) stay flat siblings.

## Cons / risks
- **The builder is real engine surface, not just sugar.** `s.step()`/`branch()` must record edges into the declarative JSON the runner+canvas consume — more machinery than today's `$` proxy (which just stringifies). This is the build cost.
- **JSON form is wordier.** Non-TS authors get `{ "from": "validate", "path": "productId" }` instead of `v.out.productId` — readable and machine-friendly, but not as terse. (Acceptable: JSON is the canvas's wire format, humans use TS.)
- **Closure-scoped handles can't escape their branch arm** — a handle from the `then` arm isn't visible in `else`. That's correct (matches the real DAG) but is a new rule authors must learn.
- **Migration:** every existing `$.state.x` / `js/ctx...` workflow needs a codemod. Mechanical, but not zero.

## Who it's for
- **Devs:** primary win — autocomplete, rename-refactor, `tsc` safety, pipeline readability. Best-in-class of the four.
- **Non-coders:** indirect — they never see this; they edit the canvas, which round-trips to/from the same declarative JSON the builder emits. The handle-as-edge model is what makes that round-trip lossless.
- **AI:** very high — typed handles + node output schemas give an LLM a checkable contract; generated refs fail at compile, not silently at run time. The ordered-list-with-named-edges shape is easy to emit and easy to validate.

## Readability verdict
Reads like a function (Trigger.dev) but stays a renderable list (n8n minus the name-keyed graph) — the sweet spot between typed-A and readable-by-anyone-B, with the `$`/`js/` seam deleted outright.