I have everything. Here's the brief.

---

## What they do (with real code)

Blok v2 workflows are a single object literal — `steps: []` with each step carrying `id` + `use` + `inputs`. Data flows between steps via string expressions resolved at run time.

**(a) A real "today" workflow — TS** (`triggers/http/src/workflows/examples/countries-vs-facts.ts`):

```ts
import { branch, workflow } from "@blokjs/helper";

export default workflow({
  name: "Movies or Countries",
  version: "1.0.0",
  description: "Branches on a query param ...",
  trigger: { http: { method: "GET", path: "/countries-vs-facts", accept: "application/json" } },
  steps: [
    branch({
      id: "filter-request",
      when: 'ctx.request.query.countries === "true"',   // raw ctx string — NOT $.req...
      then: [{ id: "get-countries", use: "@blokjs/api-call", type: "module",
               inputs: { url: "https://countriesnow.space/api/v0.1/countries/capital", method: "GET",
                         headers: { "Content-Type": "application/json" }, responseType: "application/json" } }],
      else: [{ id: "get-facts", use: "@blokjs/api-call", type: "module",
               inputs: { url: "https://catfact.ninja/fact", method: "GET",
                         headers: { "Content-Type": "application/json" }, responseType: "application/json" } }],
    }),
  ],
});
```

A cross-step data reference uses the `$` proxy: `inputs: { body: $.state.fetch }` (typed) or, where the proxy can't intercept (the `===` in `when`), a hand-written `"js/ctx.state.fetch"` / raw `ctx.*` string.

**(a) Same workflow — JSON** (`triggers/http/workflows/json/countries-vs-facts.json`) is a near-byte-for-byte mirror; `branch()` becomes a `"branch": { when, then, else }` key, and a `$` proxy reference would be a literal `"$.state.fetch"` string:

```json
{ "id": "filter-request",
  "branch": {
    "when": "ctx.request.query.countries === \"true\"",
    "then": [{ "id": "get-countries", "use": "@blokjs/api-call", "type": "module",
               "inputs": { "url": "...", "method": "GET", "responseType": "application/json" } }],
    "else": [{ "id": "get-facts", "use": "@blokjs/api-call", "inputs": { "url": "..." } }] } }
```

**(b) A real node** (`nodes/web/api-call@1.0.0/index.ts`) — `defineNode()` + Zod in/out, pure `execute(ctx, input)`:

```ts
export default defineNode({
  name: "api-call",
  description: "Makes HTTP API calls with automatic JSON handling",
  input: z.object({ url: z.string().url(), method: z.string().default("GET"),
                    headers: z.record(z.string()).optional().default({}),
                    body: z.record(z.unknown()).optional().default({}),
                    responseType: z.string().optional().default("json") }),
  output: z.union([z.string(), z.record(z.unknown())]),
  async execute(ctx, input) {
    const body = Object.keys(input.body).length > 0 ? input.body : ctx.response.data;
    return runApiCall(input.url, input.method, input.headers, body, input.responseType);
  },
});
```

This is clean — the node layer is *not* the founder's problem. The mess is at the workflow/wiring layer.

**(c) The trigger** is an inline key on the workflow object: `trigger: { http: { method, path, accept } }`. Per-kind validated at `workflow()` call time against `TriggersSchema` (http, pubsub, worker, cron, webhook, sse, websocket, mcp, grpc, manual). It is co-located with the steps, not separate.

**(d) The exact data-reference mechanism — dual-phase compile:**

1. **Definition time (compile).** `$` is a `Proxy` over a function-tag (`core/workflow-helper/src/proxy/$.ts`). Property access builds a path string: `$.state.fetch` → tag `"ctx.state.fetch"`. The `workflow()`/`branch()`/`switchOn()`/`forEach()` factories call `unwrapProxies()` which deep-walks `inputs` and replaces every proxy with `"js/" + tag` → the literal string **`"js/ctx.state.fetch"`**. JSON authors write that string (or `"$.state.fetch"`, normalized to `js/ctx.` at load) by hand. So *both* TS and JSON converge on the same wire shape: a `js/...` string.
2. **Run time (resolve).** Before each step, `Mapper` (`core/shared/src/utils/Mapper.ts`) scans `inputs`. A string starting with `js/` has the prefix stripped (`slice(3)`) and is evaluated in a sandbox: `Function("ctx","data","func","vars", '"use strict";return (' + expr + ');')(...)`. `${path}` interpolations are lodash `_.get` first, JS-eval fallback. Default `BLOK_MAPPER_MODE=strict` → a bad path throws `MapperResolutionError`; `warn` passes the literal through.

So `$.state.fetch` is **pure author-time sugar over a string that gets `eval`'d at run time**. The proxy never reaches the runner.

**Layout/canvas:** confirmed **absent**. A repo-wide grep for `layout`/`canvas`/`position`/coordinates in workflow types and all TS+JSON workflows finds nothing (only unrelated hits: signature `format` layout, `responseType`). There is no canvas data in workflow files today — so "move it to a separate file" is greenfield, not a migration. The *real* problem the founder names is the reference syntax, not pollution by layout.

## Readability verdict

Honest list of what's clunky — the baseline every option must beat:

- **`$` proxy is invisible magic.** `$.state.fetch` looks like a runtime value access but is a `Proxy` that stringifies via `Symbol.toPrimitive`/`toString` into `"js/ctx.state.fetch"`. A reader can't tell from the code that it's a compile-time path-builder, not a real object. `.then` is special-cased to `undefined` just so `Promise.resolve()` won't mistake it for a thenable — that's the smell of a value pretending to be something it isn't.
- **`js/...` strings leak the abstraction.** The moment the proxy can't cover a case, authors drop to raw `"js/ctx.state.x"` or `"ctx.request.query.x"` strings. Two syntaxes for the same concept, and the JSON surface only ever has the strings. `inputs` becomes a soup of magic strings (`url`, a real value, sits next to `"js/ctx.state.fetch"`, a reference) with no visual distinction between literal and reference.
- **`branch.when` is a documented footgun.** `when:` must be a **raw `ctx.*` string** — a `$` proxy or `$.`-prefixed string compiles to `"js/ctx…"` which the condition evaluator does **not** resolve, so the branch silently mis-evaluates. The `BranchOpts` doc and a standing memory both warn about it. `eq($.req.method,"POST")` exists only because `===` can't be proxy-intercepted. Same step shape, two incompatible expression dialects.
- **Step `id`s are stringly-typed refs.** `$.state.fetch` is just `"js/ctx.state.fetch"` — a typo'd id is a runtime `MapperResolutionError`, not a compile error. `id`s share one flat per-workflow map, so a duplicate id across `branch`/`switch` arms silently runs the wrong arm's inputs (called out explicitly in the Do-NOT list). The data graph is implicit, reconstructed by string-matching `state.<id>` against step ids.
- **Data flow is invisible.** Reading `steps[]` top-to-bottom does *not* show you the DAG. You have to grep every `$.state.X` / `js/ctx.state.X` to find who feeds whom. `ctx.prev` vs `ctx.state[id]` adjacency rules add a second mental model.
- **`switchOn` named around a reserved word**; `forEach.as` collides silently with step ids if you pick the wrong name. Each control-flow primitive is its own discriminator key (`branch`/`switch`/`forEach`) rather than a uniform shape.
- **TS and JSON are deliberately 1:1** — good for learnability, but it means the TS surface inherits all the JSON stringliness instead of using the type system to make references real.

## Lessons for Blok authoring

What a cleaner model must deliver, and where today's design points the way:

- **Make references first-class and checkable, not stringified eval.** The single biggest win: a reference to another step's output should be a typed handle the compiler validates, not a `Proxy`-to-`"js/…"`-to-`Function()` round-trip. n8n keeps references explicit and visual; Trigger.dev makes them plain `const x = await step(...)` JS variables — the dependency *is* the variable binding, statically checked, no string DSL. Either kills the typo-at-runtime class.
- **One expression dialect, everywhere.** Today there are three (`$` proxy, `js/...` strings, raw `ctx.*` in `when`). Collapse to one. If a code-first model wins, references are just variables and there's *zero* expression DSL.
- **Layout is genuinely separable — it doesn't exist yet, so design it out from the start.** Keep the executable workflow free of canvas data; a sidecar `.layout.json` keyed by step `id` is the obvious split. No migration cost.
- **Keep `defineNode()`.** The node layer is already clean (Zod in/out, pure execute). Don't redesign it — the authoring pain is purely in the wiring/expression layer.
- **Preserve the wins worth keeping:** declarative trigger block, per-step persistence knobs (`as`/`spread`/`ephemeral`), and the TS↔JSON mirror are good. A new model should keep declarative legibility (n8n-style "read it and see the steps") *and* gain static reference safety (Trigger.dev-style variables) — the two poles the comparison is meant to weigh.

## Sources

Code only — no web. Key files: `core/workflow-helper/src/proxy/$.ts` (proxy + `unwrapProxies`), `.../components/{workflowV2,branch,switchOn,forEach}.ts`, `core/shared/src/utils/Mapper.ts` (`jsMapper`/`runJs` sandbox), `core/runner/CLAUDE.md` (Mapper modes), `nodes/web/api-call@1.0.0/index.ts`, `triggers/http/src/workflows/examples/countries-vs-facts.ts` + its JSON twin. Layout/canvas absence verified by repo-wide grep (zero hits in workflow types or any TS/JSON workflow).