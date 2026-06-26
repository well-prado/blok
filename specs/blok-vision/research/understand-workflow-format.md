Perfect! Now I have a comprehensive understanding. Let me write the report.

## How it works today

### Workflow Definition Formats

**v1 (legacy)** — separate `steps[]` array + `nodes{}` map:
```ts
{
  name, version, trigger,
  steps: [{ name, node, type, active?, stop? }],
  nodes: { [stepName]: { inputs?, conditions? } }
}
```

**v2 (canonical)** — steps inline everything:
```ts
{
  name, version, trigger,
  steps: [
    { id, use, type?, inputs?, as?, spread?, ephemeral?, active?, stop? }
    | { id, branch: { when, then, else? } }
    | { id, subworkflow, inputs?, wait?, dispatch? }
    | { id, wait: { for?, until? } }
    | { id, forEach/loop/switch/tryCatch: {...} }
  ]
}
```

**Sources:**
- `/Users/wellprado/Projects/Personal/blok/core/workflow-helper/src/components/workflowV2.ts:39–98` — `WorkflowOpts` interface + JSDoc
- `/Users/wellprado/Projects/Personal/blok/core/workflow-helper/src/types/StepOpts.ts` — all step variant Zod schemas (1102 lines)
- `/Users/wellprado/Projects/Personal/blok/packages/vscode-extension/schemas/workflow-v2.schema.json` — JSON Schema for both formats
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/workflow/WorkflowNormalizer.ts:8–42` — v1 vs v2 docstring overview

### TypeScript DSL

The **`@blokjs/helper`** package provides:
- **`workflow(opts)`** factory — validates & wraps a v2 workflow, returns `{ _blokV2: true, _config, toJson() }` (`/Users/wellprado/Projects/Personal/blok/core/workflow-helper/src/components/workflowV2.ts:189–305`)
- **`$` proxy** — typed property access compiling to `"js/ctx.<path>"` strings at definition time (`/Users/wellprado/Projects/Personal/blok/core/workflow-helper/src/proxy/$.ts:121–177`)
  - Supports `$.req`, `$.prev`, `$.state`, `$.env`, `$.step`, `$.workflow`, `$.error`, `$.vars`
  - `Proxy`-based deep traversal; compiled by `unwrapProxies()` before schema validation
- **Control-flow helpers** — `branch()`, `forEach()`, `loop()`, `switchOn()`, `tryCatch()` (`/Users/wellprado/Projects/Personal/blok/core/workflow-helper/src/components/*.ts`)
- **Comparators** — `eq()`, `ne()`, `gt()`, `gte()`, `lt()`, `lte()` for branch conditions (emit raw `ctx` instead of mapper expressions)

### WorkflowNormalizer: the v1→v2 bridge

Entry point: `/Users/wellprado/Projects/Personal/blok/core/runner/src/workflow/WorkflowNormalizer.ts:162–334`

**Algorithm:**
1. Detect builder envelopes (`_blokV2: true`, `_config`) and unwrap (line 172–177)
2. Validate envelope scalars (name, version) + migration guards (`set_var` rejection, duplicate step IDs across all sub-pipelines)
3. Normalize trigger (convert `method: "*"` → `"ANY"`)
4. **Walk the full step tree** (line 225–308):
   - **branch** — normalizes `when` condition + recursive `then`/`else` arms, emits synthetic `@blokjs/if-else` node (line 441–527)
   - **subworkflow** — emits `@blokjs/subworkflow` node with optional `dispatch` strategy + `allowList` (line 541–631)
   - **wait** — emits `@blokjs/wait` node; parses `wait.for` duration strings → ms (line 647–701)
   - **forEach/loop/switch/tryCatch** — each normalizes its sub-block recursively, emits special node type, promotes inner `nodeConfig` to top-level `nodes` map (line 715–1062)
   - **regular** — standard step; inlines or lifts `inputs` from v1 `nodes` map
5. Carry typed-client metadata (`input` Zod schema, `output`, `events`) verbatim but **strip on `toJson()`** (line 192–194, 330–333)
6. Return **canonical internal shape** (line 114–151 `InternalWorkflow` interface)

**Output canonical shape:**
```ts
{
  name, version, description, trigger,
  steps: [{name, node, type, active, stop, as?, spread?, ephemeral?, inputs?, retry?, ...}],
  nodes: { [stepName]: { inputs?, conditions?, steps?, cases?, default?, ...} },
  middleware?, appliedMiddleware?, input?, output?, events?
}
```

All v1/v2 diffs resolve here; the runner (`Configuration.getSteps`, `Configuration.getNodes`) sees only this shape.

### In-Memory Representation: `Configuration` → `NodeBase[]`

Path: `/Users/wellprado/Projects/Personal/blok/core/runner/src/Configuration.ts:204–256`

**Two-phase resolution:**
1. **`getSteps(blueprint_steps)`** — iterate each normalized step, resolve its node via `nodeResolver()` (which loads the actual Node class), attach metadata fields:
   - `as`, `spread`, `ephemeral` (v2 persistence knobs)
   - `idempotencyKey`, `retry`, `maxDurationMs`, `subworkflow`, `wait` (operational fields)
   - `node`, `name`, `active`, `stop` (structural)
2. **`getNodes(workflow_nodes)`** — for each key in the canonical `nodes` map:
   - If **`isFlowWithProperties`** (both `steps` + sibling metadata) — resolve the steps array into `NodeBase[]` recursively via `getFlow()`, then merge metadata back (line 274–286)
   - If **`isConditions`** (branch/if-else) — recursively resolve each condition's step list (line 290–299)
   - Else pass through as-is for regular nodes

Result: **`Configuration.steps: NodeBase[]`** — a fully resolved array of runtime-executable nodes; **`Configuration.nodes: Node`** — a lookup map for step config/inputs/nested flows.

### Canonical source of truth

**JSON** is the serialization format (stored in `WorkflowRegistry`, persisted on disk, returned by `GET /__blok/workflows/:name`).  
**TS DSL** is authoring sugar — compiles to JSON via `workflow().toJson()`.  
**Both round-trip cleanly through the normalizer** (no lossy translation).

### Metadata NOT in the format

**The format carries NO visual/canvas metadata:**
- No step positions (x, y, absolutePosition)
- No node colors, icons, or display hints
- No comments or annotations
- No "editor state" (zoom, pan, selection)

**Studio generates positions at render time:**
- `/Users/wellprado/Projects/Personal/blok/apps/studio/src/lib/workflowDag.ts` — walks the normalized workflow JSON, emits a flat `DagNode[] + DagEdge[]` graph
- Passes to `dagre` for automatic layout (line 560 file)
- `@xyflow/react` renders the positioned graph

---

## Seams & extension points

1. **`WorkflowNormalizer.normalizeWorkflow(raw, sourcePath?)`** — public entry point for v1→v2 conversion. Called from:
   - `Configuration.init()` on preloaded workflows (line 179–181)
   - CLI loaders, workspace scanners
   - Arbitrary JSON at runtime

2. **`unwrapProxies(value)`** — compiler for `$` proxies. Deep-walks any value, replaces proxy refs with `"js/ctx..."` strings. Used by:
   - `workflow()` factory (line 215)
   - `branch()` factory and other helpers

3. **`nodeResolver()` in Configuration** — loads a node class given a `step.node` ref. Can be overridden to support custom node types (currently hardcoded for `@blokjs/*` official nodes + user nodes).

4. **`Configuration.getSteps/getNodes`** — the two-phase resolver. Subclasses can override to inject custom resolution (e.g., registry lookups, caching).

5. **`DagBuilder.buildWorkflowDag(definition)`** — Studio's bridge from normalized JSON to visualized graph. `definition: unknown` is defensive; the builder classifies steps and emits `DagNode/DagEdge` for React Flow.

6. **Step-kind discriminators** — runtime reads step metadata fields (`branch`, `subworkflow`, `wait: { for|until }`, `forEach`, `loop`, `switch`, `tryCatch`) to classify and route. Same logic used by Studio's `classifyStep()` (line 67–77 of workflowDag.ts).

---

## Hard constraints / invariants

1. **Step IDs must be globally unique** across the entire workflow, including mutually-exclusive branch/switch arms, because all steps share one flat `nodes[id]` lookup map. Violating this is caught at load time (line 1139–1185 of WorkflowNormalizer).

2. **`as` and `spread` are mutually exclusive** — a step can rename its key OR flatten the object, never both (line 376–379 of WorkflowNormalizer).

3. **Nested flow shapes** (branch, forEach, loop, switch, tryCatch) must inline all inner-step configs because the normalizer bubbles them into the top-level `nodes` map. If an inner step's config is lost, the runner fails with "Node config not found" (line 235–241 of WorkflowNormalizer).

4. **`$` proxy values MUST be compiled to `"js/ctx..."` strings before the normalizer sees the workflow.** Plain Proxy objects fail schema validation (they're not strings). This is why `workflow()` calls `unwrapProxies()` before validation (line 215).

5. **Typed metadata (`input`, `output`, `events` Zod schemas) is authoring-only and stripped on serialization.** A JSON workflow has no type hints; the TS DSL alone carries them. Roundtripping: TS → JSON → TS loses the Zod schemas.

6. **Trigger config is per-kind.** `trigger: { http: {...}, cron: {...} }` is allowed but only one kind is typically active. `validateTriggerConfig()` is called per kind (line 247–255 of workflowV2.ts).

7. **No circular subworkflow references** — hard-coded recursion depth limit of 10 (default; configurable via `BLOK_MAX_SUBWORKFLOW_DEPTH`). Exceeded → error at run time.

8. **Expressions in fields like `subworkflow`, `debounce.key`, `concurrencyKey` are resolved at runtime against `ctx`.** The format allows `js/...` strings and `$.` proxies unchanged. Fail-open on resolution error (unless `BLOK_MAPPER_MODE=strict`).

---

## What must change for the vision (visual canvas)

### 1. Metadata extension for canvas state

The format needs **optional per-step and workflow-level metadata**:

```ts
// Minimal option: Zod extend
steps: [
  {
    id: "fetch",
    use: "@blokjs/api-call",
    inputs: {...},
    // Canvas metadata — optional, not serialized by runner
    ui?: {
      x: number,
      y: number,
      // Optional hints for canvas rendering
      color?: string,
      notes?: string,  // author comment
    }
  },
  ...
]
```

**Design decisions:**
- Should `ui` nest per-step, or live in a top-level `_ui: { "step-id": { x, y, ... } }` map?
  - **Per-step:** mirrors inputs, cleaner JSON. Studio reads `step.ui.x`.
  - **Top-level map:** decouples visual state from logic. Easier to "default" positions if missing.
- Should positions be **absolute (canvas-space) or relative (layout hints)?**
  - Absolute: Studio persists exact coordinates. Burden: author never edits JSON by hand; regenerates if branches added.
  - Hints: (e.g., `precedence: ["a", "b"]` to guide dagre) — lighter, editable by hand, but determinism is looser.

**Recommendation:** Start with **per-step `ui: { x?, y? }`** (absolute, optional). If missing, Studio's dagre auto-layout fills in. On save, round-trip the computed positions back to the workflow file (or store separately in a `.blok.ui.json` companion file if you want to keep workflow definitions pure).

### 2. Normalization pass-through

`WorkflowNormalizer` must thread `ui` metadata from v2 steps into the canonical internal shape *without* validating or modifying it. No schema checks — just pass through.

```ts
// In normalizeRegularStep, etc.
const internalStep: InternalStep = {
  name: id,
  node: nodeRef,
  type,
  ..., // existing fields
  ...(step.ui !== undefined ? { ui: step.ui } : {})
};
```

`Configuration.getSteps()` can then attach `ui` to the resolved `NodeBase` instance if needed by Studio.

### 3. Studio canvas authoring

The key changes:
1. **Workflow editor → Canvas + Property Panel** (currently traces are shown in a read-only DAG)
   - Visualize the workflow as an editable `@xyflow/react` graph
   - Sync position changes back to the in-memory workflow object
   - On save, POST the updated workflow definition back to the registry/disk
2. **Step/node creation via drag-and-drop** 
   - Palette of node types (regular, branch, forEach, etc.)
   - Drag onto canvas, Studio auto-generates unique ID + default inputs
   - Normalizer ensures the shape is valid before save
3. **Expression editor for conditions, inputs**
   - Inline or popup editor for `branch.when`, `forEach.in`, step `inputs`
   - Syntax-highlight `js/...` and `$.` proxy expressions
   - Client-side compile-check for `$` proxies (must resolve to valid paths)
4. **Sync with TypeScript authoring**
   - When a TS workflow exports, Studio can POST it to the registry and render the canvas
   - When canvas saves, emit TS-DSL-compatible JSON (or optionally, generate TS code)

### 4. Runtime indifference

**No changes needed to the runtime.** The runner already ignores unknown fields on steps. `ui` will silently pass through normalization → storage → retrieval. If a JSON workflow has `ui` metadata, it doesn't affect execution.

### 5. Serialization: to/from JSON

Both v2 builder and JSON input support `ui`:

```ts
// v2 TS builder
workflow({
  steps: [
    {
      id: "fetch",
      use: "@blokjs/api-call",
      inputs: { url: "..." },
      ui: { x: 100, y: 50 }  // optional; TS developer can set if desired
    }
  ]
})

// JSON
{
  "steps": [
    {
      "id": "fetch",
      "use": "@blokjs/api-call",
      "inputs": { "url": "..." },
      "ui": { "x": 100, "y": 50 }
    }
  ]
}
```

`toJson()` includes `ui` (it's workflow data, not Zod schema).

### 6. Canvas → JSON round-trip losslessness

**TS DSL source:**
```ts
workflow({ steps: [...] })
  .toJson()  // → JSON with ui metadata
  → Save to disk
  → Studio reads + renders canvas at original positions
  → Studio user moves a node, saves
  → Workflow definition updated with new x, y
  → If author re-reads the TS source and re-exports, positions update
```

**Direct JSON authoring:**
```json
// my-workflow.json
{ "steps": [{ "id": "fetch", "ui": { "x": 100 } }] }
  → Studio opens, renders at x=100
  → Studio user moves, saves
  → my-workflow.json updated
  → Next load, Studio renders at new position
```

**Losslessness:** Yes, if positions are deterministic + authored. Dagre auto-layout is **lossy** (different layout algorithm versions or graph mutations change positions). Store authored positions separately if you need 100% reproducibility.

---

## Risks / gotchas

### 1. Position persistence model

**Risk:** If positions are stored on the step, every JSON edit requires re-running the canvas to update them. Manual JSON edits that add steps are immediately out-of-layout.

**Mitigation:** 
- Auto-layout new steps if `ui` is missing (Studio does this already via dagre).
- OR store positions separately in `.blok-canvas.json` (Figma-style, but adds a file).
- OR accept that positions are Studio-computed; never hand-edit JSON positions.

### 2. Merge conflicts in Git

**Risk:** Two authors edit a workflow in Studio concurrently, positions diverge, merge becomes messy.

**Mitigation:**
- Position metadata is low-value; merge tools can accept "ours" or "theirs" without breaking the workflow.
- Studio can emit a "last write wins" conflict resolution (positions are not mission-critical).
- Encourage CLI-only workflows in high-concurrency teams.

### 3. Metadata bloat in JSON

**Risk:** Large workflows with hundreds of steps accumulate `{ x, y, color, notes }` metadata per step, doubling file size.

**Mitigation:**
- `ui` is optional; omit if not needed.
- Compress positions into a companion `.ui.json` keyed by step ID (one entry per positioned step).
- OR: Studio stores positions in localStorage/IndexedDB instead of persisting to the workflow file.

### 4. Canvas ↔ Runtime semantics mismatch

**Risk:** Canvas shows a "nice" layout (e.g., vertically stacked branches) that visually implies sequentiality, but the runtime executes branches in parallel or in an unexpected order (the DAG reveals the true order).

**Mitigation:**
- Canvas must visualize the **actual execution semantics** (same DAG as the runtime's trace viewer).
- Branch arms don't merge until both complete; loop back-edges are dotted; forEach is a loop header with a body.
- Use the same `workflowDag.ts` builder that Studio's trace viewer uses.

### 5. Trigger metadata missing

**Risk:** Triggers (HTTP paths, cron schedules, queue topics) are rendered as text labels but not visually edited in the canvas. Authors must hand-edit JSON or use a separate panel.

**Mitigation:**
- Separate trigger editor (property panel when trigger node is selected).
- OR: Extend canvas to support trigger input (more complex, but desirable for full visual authoring).

### 6. Circular references in sub-workflows are undetectable statically

**Risk:** A workflow named "A" calls subworkflow "B", which calls "A". This creates an infinite loop at runtime, but JSON doesn't capture it (subworkflow names are strings, not references). Studio can't warn at load time.

**Mitigation:**
- Runtime already has a depth limit (10 levels by default); excess depth → error.
- Studio could add an optional "resolve and check depth" pass (fetches all subworkflow definitions and validates the call graph), but it's expensive for large registries.
- Recommend: Document the limit, rely on runtime guards.

### 7. Expression validation is loose

**Risk:** A `branch.when: "$.invalid.path"` compiles fine in the format, but fails at runtime if `ctx.invalid` is undefined. Canvas can't type-check without the runtime context schema (which TS workflows have via Zod, JSON workflows don't).

**Mitigation:**
- JSON workflows have no input schema, so can't be checked statically.
- TS workflows carry `input` Zod schema; the `$` proxy and TypeScript's type system provide compile-time checks.
- Canvas could expose a "type hints" modal for JSON workflows (manual Zod schema upload), but that's UX heavy.
- Default: Rely on runtime mapper's `BLOK_MAPPER_MODE=strict` to fail fast on bad expressions.

### 8. Control-flow helper functions don't round-trip cleanly

**Risk:** `branch()`, `forEach()`, etc. are TS factories that return step-shaped objects. Canvas can't re-emit TS source (it emits JSON). Authoring in Canvas loses the TS ergonomics.

**Mitigation:**
- Canvas authoring is JSON-first. TS authors use the TS DSL; canvas users edit the JSON or use the visual builder.
- No need to "round-trip" TS source — two authoring modes, both valid.
- If Canvas wants to emit TS-friendly code, it could generate `export default workflow({ ... })` wrapper, but that's a "nice to have", not required.

---

## Summary

**Today:** Workflows are defined as JSON (or TS DSL that compiles to JSON). The normalizer translates v1 + v2 shapes to a single canonical in-memory representation. The runtime executes this representation; Studio visualizes traces using the same DAG builder that the format would use. **No visual metadata exists.**

**For canvas:** Extend the format with optional per-step `ui: { x, y }` metadata. Pass it through the normalizer unchanged. Studio can persist and read these coordinates, auto-layout if missing. JSON remains the source of truth; canvas is a synchronous editor overlay. No breaking changes needed — legacy workflows (no `ui`) continue to work, auto-layout every time.

**Key risks:** Position persistence model (hand-edit vs. auto-layout), Git merge conflicts, expression validation loose on JSON, circular subworkflows uncaught at load time. None are blockers; all have simple mitigations.