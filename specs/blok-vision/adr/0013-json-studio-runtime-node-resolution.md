# ADR 0013 - JSON/Studio runtime-node resolution after Nodes.ts

- **Status:** Accepted (spike resolution)
- **Date:** 2026-06-28
- **Resolves:** [#372](https://github.com/well-prado/blok/issues/372)
- **Epic:** [#363](https://github.com/well-prado/blok/issues/363)

## Decision

JSON workflows and Studio do **not** depend on generated TypeScript
`runtimeNode<In,Out>()` stubs. Stubs are a TypeScript-authoring affordance only.

The non-TS discovery source is the live node catalog:

```http
GET /__blok/nodes
```

`triggers/http/src/runner/nodeCatalog.ts` builds that catalog from:

- in-process module nodes from the trigger's `NodeMap`, reflected through
  `defineNode().getReflectionSchemas()` / legacy `getSchemas()`;
- each registered runtime adapter's `listNodes()` result, labeled as
  `runtime.<kind>`.

Studio's palette and JSON-authoring tools should store the exact catalog pair:

```json
{ "use": "validate-card", "type": "runtime.go" }
```

At execution, `Configuration.runtimeResolver()` derives the adapter from the
explicit `type: "runtime.go"` (or `node.runtime`) and dispatches that `use` name
to the selected runtime. Same-name nodes across runtimes are therefore
disambiguated by `type`, not by generated stub imports.

## Recommendation

For redesign-era JSON/Studio output, require explicit `type: "runtime.<kind>"`
for every runtime node. Treat a runtime node with bare `use` and no runtime
kind as invalid during authoring/publish validation.

Why: `Configuration.runtimeResolver()` still has a backward-compatibility
fallback to `python3` when no runtime kind is present. That fallback is safe only
for legacy callers that already entered the runtime resolver. Once `Nodes.ts` is
gone, a bare JSON step is otherwise indistinguishable from a module node and can
silently route wrong if a tool guesses.

No runtime rewrite is needed for explicit runtime nodes. The guard belongs in
the JSON/Studio validator and codemod path, not in `runtimeResolver()` yet.

## Edge Cases

- **Same name in two runtimes:** catalog entries are two rows, e.g.
  `{ name:"score", runtime:"runtime.go" }` and
  `{ name:"score", runtime:"runtime.python3" }`. Studio must persist the chosen
  `runtime` as the step `type`.
- **No-schema runtime node:** catalog returns `inputSchema:null` /
  `outputSchema:null`. Studio can render a usable untyped block; typed TS stubs
  degrade to `unknown`.
- **Runtime down at catalog time:** `buildNodeCatalog()` swallows a
  `listNodes()` rejection and omits that runtime's nodes. Studio should show the
  catalog it has, not invent stale runtime entries.
- **Runtime down at execution time:** explicit `type` still selects the adapter;
  adapter connection failure remains a normal runtime execution error.
- **Bare `use` with no `type`:** keep legacy behavior for old workflows, but
  mark it invalid for new JSON/Studio runtime-node authoring because the
  python3 fallback is ambiguous.

## Consequences

- `blokctl nodes sync` and generated stubs can be added without becoming a
  dependency of JSON loading or Studio.
- The Studio palette should key runtime nodes by `(runtime, name)`, not just
  `name`.
- The IR schema can keep `use:string` plus `type:"runtime.<kind>"`; no new
  runtime-node reference object is needed.
- A future validator should warn: "runtime node `score` must include
  `type:\"runtime.<kind>\"`; available runtimes: ...".
