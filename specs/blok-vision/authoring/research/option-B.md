## B. Clean Declarative YAML

## The pitch
A workflow you read like a recipe, top to bottom — no `$` proxy, no `js/ctx`, no canvas noise. References are `${{ steps.checkStock.inStock }}`, the exact syntax 100M+ GitHub Actions users already know: *step → its output → the field*. Literal vs. reference is unambiguous (one is bare, one is `${{ }}`), and pixels live in a sidecar the runner never reads.

## Workflow file
`workflows/order-intake.blok.yaml`
```yaml
name: Order intake
on:
  http: { method: POST, path: /orders }

steps:
  - id: validate                    # custom node, validates the body
    use: validate-order
    with: { body: ${{ trigger.body }} }

  - id: checkStock                  # built-in HTTP node
    use: blok/http
    with:
      url: https://inventory.internal/stock/${{ steps.validate.productId }}

  - id: route
    when: ${{ steps.checkStock.inStock }}      # branch on a boolean
    then:
      - id: createOrder            # custom DB node
        use: db-create-order
        with: { productId: ${{ steps.validate.productId }}, qty: ${{ steps.validate.qty }}, stock: ${{ steps.checkStock }} }
      - { use: blok/respond, with: { status: 201, body: ${{ steps.createOrder }} } }
    else:
      - { use: blok/respond, with: { status: 409, body: { error: out of stock } } }
```

## Data flow
The reference is a **noun-path keyed by step `id`**, borrowed from GitHub Actions (`steps.<id>.outputs.<field>`) — collapsed to `steps.<id>.<field>` since Blok already auto-persists each step's output. `${{ }}` is the *only* expression marker (n8n's "`=` flags an expression" lesson, made explicit), so a bare value is always a literal and a wrapped one is always a reference. No second `js/` dialect, no raw-`ctx` footgun in `when:`.

```text
today  →  inputs: { url: $.state.checkStock }   and  "js/ctx.state.checkStock"   and  when: 'ctx.state.x'
this   →  with:   { url: ${{ steps.checkStock.url }} }                           when: ${{ steps.checkStock.inStock }}
```
`trigger.body` replaces `$.req.body`; `steps.<id>` replaces `$.state.<id>`. One grammar, three contexts (`trigger`, `steps`, `env`). A typo'd id is caught by the loader (it knows every step id) — not a runtime `MapperResolutionError`.

## Node definition
Node logic stays code (`defineNode` is already clean — research agrees the pain is the *wiring* layer, not the node). The node just declares its output fields so `${{ steps.validate.productId }}` is checkable:
```ts
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "validate-order",
  input:  z.object({ body: z.object({ productId: z.string(), qty: z.number().int().positive() }) }),
  output: z.object({ productId: z.string(), qty: z.number() }),   // <- these are the ${{ steps.validate.* }} fields
  async execute(_ctx, { body }) {
    return { productId: body.productId, qty: body.qty };
  },
});
```

## Trigger
Declared at the top of the file under `on:` — GitHub Actions' gold-standard pattern (one readable block, no logic mixed in). The key *is* the trigger kind; everything else is flat config:
```yaml
on:
  http: { method: POST, path: /orders }
  # cron:   { pattern: "0 5 * * *", timezone: Asia/Tokyo }   # same shape, swap the kind
```
No `version:` field — the toolchain stamps versions on deploy (Trigger.dev lesson), keeping the authored file clean.

## Layout file (separate)
`workflows/order-intake.canvas.json` — owned by Studio, ignored by the runner, keyed by stable step `id` (Windmill OpenFlow precedent). Optional: absent → Studio auto-lays-out from the step order/branches.
```json
{
  "for": "order-intake.blok.yaml",
  "nodes": {
    "validate":    { "x": 80,  "y": 40 },
    "checkStock":  { "x": 80,  "y": 180 },
    "createOrder": { "x": 280, "y": 320 }
  },
  "viewport": { "zoom": 1, "x": 0, "y": 0 }
}
```

## Pros
- **Reads top-to-bottom like a recipe** — steps array *is* the execution order; a non-coder follows it without framework vocabulary.
- **One familiar reference grammar** (`${{ steps.x.y }}`) — GitHub Actions muscle memory, zero `$`/`js/`/raw-`ctx` triad.
- **Literal vs. reference is visually obvious** — the `${{ }}` wrapper, nothing else.
- **Clean diffs** — layout in a sidecar; dragging a node never touches the workflow.
- **Loader-time id checking** — typo'd reference fails at load, not mid-run.

## Cons / risks
- **YAML is stringly-typed** — `${{ steps.validate.productId }}` is text, so it's not as IDE-checked as a TS typed handle (Option's weak axis vs. a code-first model). Mitigate with a schema + LSP that reads node `output` Zod shapes.
- **Inside `${{ }}` you'll want *some* expression power** (comparisons, `.length`); keep it to path-access + a vetted helper set, not a JS sandbox — or you've reinvented n8n's `{{ full JS }}` and its 4 sanitizers.
- **New file format** — needs a YAML loader + the existing TS/JSON loaders, and round-trip with Studio. Real implementation cost.
- **A third authoring surface** unless YAML *replaces* JSON rather than joining it.

## Who it's for
- **Non-coders / ops / AI agents**: the sweet spot — flat, declarative, greppable, LLM-friendly to generate and diff.
- **Devs**: comfortable but they lose compile-time ref safety; they'll prefer the code-first option for complex logic.

## Readability verdict
The most *universally* readable of the four — anyone who's seen a GitHub Actions file reads it cold — at the cost of TS-grade reference checking, which a schema-aware LSP only partly buys back.