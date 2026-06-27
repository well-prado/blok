## C. Code-First Imperative (Trigger.dev-style)

## The pitch
A workflow is a plain async function. A step runs, returns a value, you assign it to a `const`, and the next step uses that variable. The dependency graph IS the variable bindings — `stock.inStock` instead of `"$.state.checkStock.data.inStock"`. Nothing to decode, nothing to eval, no `$`, no `js/`, no string that secretly points at a step id. If your editor can read TypeScript, it can read the whole flow and rename-refactor it.

## Workflow file
`orders/intake.workflow.ts` — the function is the source of truth; the runner derives the graph by tracing the calls.

```ts
import { defineWorkflow, http } from "@blok/sdk";
import { validateOrder } from "../nodes/validate-order";
import { createOrder } from "../nodes/create-order";

export default defineWorkflow({ id: "order-intake" }, async (req, { run, respond }) => {
  const body = await run(validateOrder, { body: req.body });          // custom node

  const stock = await run(http.get, {                                 // built-in node
    url: `https://inv.internal/stock/${body.productId}`,
  });

  if (!stock.inStock) {
    return respond(409, { error: "out of stock", productId: body.productId });
  }

  const order = await run(createOrder, {                              // custom DB node
    productId: body.productId, qty: body.qty, reserved: stock.reservationId,
  });

  return respond(201, order);
});
```

You read it top to bottom and you know the steps, the branch, and the data flow. No second file to cross-reference for "what runs next."

## Data flow
The reference mechanism is **the variable**. `run(node, inputs)` returns the node's typed output; you name it and use it. `stock.inStock` is checked by `tsc` — a typo is a compile error, not a 3am `MapperResolutionError`. (Airflow TaskFlow / Temporal: the variable name *is* the edge. Trigger.dev: `const r = await child.triggerAndWait(...).unwrap()`.)

```ts
// before (today)
inputs: { reserved: $.state.checkStock.reservationId }   // proxy → "js/ctx.state.checkStock.reservationId" → eval at runtime
when: 'ctx.request.query.x === "true"'                    // raw-ctx string, a third dialect

// after (Option C)
const stock = await run(http.get, { ... });
run(createOrder, { reserved: stock.reservationId });      // plain property access, typed, autocompletes, rename-safe
if (req.query.x === "true") { ... }                       // it's just JS
```

One dialect — TypeScript — instead of three (`$` proxy / `js/` string / raw `ctx`). The branch is `if`. Fan-out is `Promise.all`. There is no expression language to learn.

## Node definition
Unchanged from today — `defineNode()` is already clean (the founder's pain is the wiring layer, not the node layer). The only addition is that the export is importable so the workflow can pass it to `run()` with full type inference.

```ts
import { defineNode } from "@blok/sdk";
import { z } from "zod";

export const validateOrder = defineNode({
  name: "validate-order",
  input: z.object({ body: z.object({ productId: z.string(), qty: z.number().int().positive() }) }),
  output: z.object({ productId: z.string(), qty: z.number() }),
  async execute(_ctx, { body }) {
    if (!body.productId) throw new Error("productId required");
    return { productId: body.productId, qty: body.qty };
  },
});
```

`run(validateOrder, …)` infers its input/output from these Zod schemas — pass the wrong field and it won't compile.

## Trigger
Declarative, top-of-file, attached at definition — not mixed into the logic (GitHub Actions `on:` block, Trigger.dev's flat options object). Version is dropped; the toolchain stamps deploys.

```ts
export default defineWorkflow(
  {
    id: "order-intake",
    trigger: http({ method: "POST", path: "/orders" }),   // or cron(), worker(), webhook()
  },
  async (req, ctx) => { /* ... */ },
);
```

`req` is the typed trigger payload; the trigger shape determines what `req` is (HTTP request, queue message, cron tick). One block, no logic inside it.

## Layout file (separate)
There is no canvas data in the workflow file — ever. Studio derives the graph by statically tracing `run()` calls (Trigger.dev reconstructs topology from traces; Airflow/Dagster from the dependency DAG). If a human pins positions, Studio writes a **sidecar keyed by step id**, and the runner never reads it (Windmill OpenFlow: logic spec has zero coordinates).

`orders/intake.layout.json`
```json
{
  "workflow": "order-intake",
  "nodes": {
    "validateOrder": { "x": 80,  "y": 120 },
    "http.get":      { "x": 320, "y": 120 },
    "createOrder":   { "x": 560, "y": 40  },
    "respond:409":   { "x": 560, "y": 220 }
  },
  "viewport": { "zoom": 1, "x": 0, "y": 0 }
}
```

Optional by design: no pinned position → Studio auto-lays-out from the call graph. Layout changes never touch the logic file; clean diffs, no merge conflicts on a drag.

## Pros
- **Zero reference syntax.** Data flow is variables and return values — the single biggest fix for the founder's #1 complaint. No `$`, no `js/`, no raw-`ctx` `when` footgun.
- **Compile-time safety + autocomplete + rename-refactor.** A typo'd field or step output fails `tsc`, not runtime. Best-in-class tooling for free.
- **One mental model.** `if`/`await`/`Promise.all`/`try-catch` — a TS dev needs zero framework vocabulary. Cross-step access, branching, fan-out, error handling are all just the language.
- **Layout fully out-of-band**, optional, auto-derivable. Founder's explicit ask, met at the floor.
- **`defineNode()` survives untouched** — small migration surface, no node rewrites.

## Cons / risks
- **Non-coders cannot author or read it.** This is the one hard tradeoff — Trigger.dev gives up the visual-authoring audience entirely. Blok's pitch includes a Studio for non-coders, so this pole alone doesn't cover them.
- **Static graph extraction is real work.** Deriving the canvas means statically tracing `run()` calls; dynamic control flow (a `run()` inside a `.map()`, a node chosen by a variable) can't always be rendered without executing — Studio must degrade gracefully to "traced at runtime."
- **Round-trip is one-way-ish.** Visual edits → code edits is a code-generation problem (formatting, comments, branch placement). Easy to compile code→graph; hard to edit graph→code without owning the file.
- **Imperative escape hatches leak.** Once it's "just a function," authors will reach for raw `fetch`, top-level `await` side effects, shared mutable state — bypassing the node/trace model the runner depends on. Needs lint guardrails.

## Who it's for
- **Devs:** ideal. The cleanest, most familiar, most tool-friendly option of the four.
- **Non-coders:** poorly, on its own. Served only if Studio can reliably round-trip code↔canvas, which is the hard, unsolved part. Realistically this option needs a declarative sibling (Option A/B) as the non-coder surface, with code-first as the power-user mode.
- **AI:** excellent — LLMs write correct TypeScript with typed feedback far more reliably than a bespoke string DSL; the type errors are the guardrail.

## Readability verdict
The most readable option for engineers, bar none — it reads like the code they already write. But it trades away the visual-authoring audience, so it wins the dev pole and loses the non-coder pole unless paired with a declarative form.