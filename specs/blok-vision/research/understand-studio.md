Perfect. Now let me generate the comprehensive brief:

---

## Studio Frontend Mapping: Rendering & Editing Gap

### How it works today

**Workflow DAG rendering (read-only, static design-time):**
- `buildWorkflowDag()` (`workflowDag.ts:539`) parses raw workflow JSON definition into a typed `WorkflowDag` (nodes + edges)
- Defensively narrows `unknown` definition via helpers (`isObject`, `asArray`, `asString`) — malformed input emits placeholder nodes
- Step classification (`classifyStep()` at line 67) discriminates kind via presence of object fields: `branch`, `subworkflow`, `wait` (object), `forEach`, `loop`, `switch`, `tryCatch`; else `regular`
- Emits step-kind-specific DAG nodes: diamond nodes for decisions (branch/switch), back-edges for iterations (forEach/loop), parallel lanes for tryCatch (try/catch/finally merge)
- Outputs: flat `{ nodes: DagNode[], edges: DagEdge[] }` with **no position data**; caller (layout function) must run dagre

**Visual layout (dagre):**
- `WorkflowGraph.tsx:133` (`layoutDag()`) constructs a `dagre.graphlib.Graph`, sets node sizes per kind (`NODE_WIDTH=200`, `NODE_HEIGHT=60`, merge node=14px circle, terminal=80px)
- Calls `dagre.layout(g)` in TB (top-to-bottom) mode with fixed spacing (ranksep=60, nodesep=40)
- Maps positioned dagre nodes back to xyflow `Node` objects with `position: {x, y}` (offset by half-width/-height for anchor)
- **All nodes rendered read-only:** `nodesDraggable={false}`, `nodesConnectable={false}`, `elementsSelectable={true}` (line 89-91)

**Workflow graph rendering (design-time):**
- Component tree: trigger pill → step nodes (icon + label + sublabel) → merge circles → end pill
- 12 node kind-specific renderers (`TriggerNode`, `RegularNode`, `SubworkflowNode`, etc. lines 234–421)
- No click handlers beyond selection; subworkflow steps conditionally link to child workflow if target is a literal name (line 299)

**Run trace rendering (live execution, read-only):**
- `TraceGraph.tsx`: builds identical dagre layout but from `NodeRun[]` (runtime trace records)
- Computes edges via step order + parent/depth relationships (lines 42–61)
- Animates edges where target is `running` status (line 82)
- Custom node component `TraceNodeComponent` (line 134) displays status dot, name, runtime kind, duration; clickable to select in inspector

**Trace visualization complementary views:**
- `StepRail.tsx` (left pane): vertical step list sorted by `stepIndex`, virtualized at 50+ steps, click to select active step
  - Synthesizes "iteration N" headers for consecutive rows sharing `iterationIndex` (line 70: `buildRailItems()`)
  - Status badges for: middleware origin, subworkflow (sync/async), wait, forEach, loop, switch, tryCatch, cached, retries
  - Indentation per `depth` via inline `paddingLeft` (line 135: `16 + depth * 12`)
- `TraceTimeline.tsx`: horizontal time-axis bars for run + each step, colored by status, click to select

**Data contracts (/__blok/* endpoints):**
- `GET /__blok/workflows/:name` → `WorkflowDetail` (line 62 in api.ts)
  - Contains `definition?: unknown` (raw JSON from WorkflowRegistry)
  - Contains `nodeNames`, `runtimes`, `triggerTypes`, `examples` (body provenance)
- `GET /__blok/runs/:id` → `RunDetail` with `run: WorkflowRun` + `nodes: NodeRun[]`
  - `WorkflowRun` fields: id, workflowName, status, startedAt, finishedAt, durationMs, error, metadata, tags, replayOf, parentRunId
  - `NodeRun` fields: id, nodeName, nodeType, runtimeKind, status, startedAt, finishedAt, durationMs, inputs, outputs, error, depth, stepIndex, parentNodeId, iterationIndex, middleware, wait (subworkflow mode), dispatch
- `GET /__blok/runs/:id/stream` → SSE with event types (sse.ts:46–68)
  - Emits: `RUN_STARTED`, `RUN_COMPLETED`, `RUN_FAILED`, `NODE_STARTED`, `NODE_COMPLETED`, `NODE_FAILED`, `NODE_SKIPPED`, `NODE_PROGRESS`, `NODE_PARTIAL_RESULT`, `NODE_CACHED`, `NODE_ATTEMPT_FAILED`, `VARS_UPDATED`, `LOG_ENTRY`
  - Parsed as `RunEvent` in real time, updates runs table and active trace

**State management:**
- TanStack Query (React Query) for server state: `useWorkflows()`, `useWorkflowDetail(name)`, `useRunDetail(runId)` (query cache, automatic refetch)
- Zustand stores (minimal): `useLiveFeedStore` (50-entry event ring buffer), `useEnvScope` (environment filter), `useNotifications`
- TanStack Router for navigation (file-based routes: `/workflows/$name`, `/runs/$runId`)

**Styling & UI stack:**
- Tailwind CSS 4 with dynamic `pl-*` disabled (inline styles for `depth * 12` padding at StepRail:135, TraceTimeline:72)
- Lucide React icons (Play, CheckCircle2, GitBranch, Repeat, Shield, ShieldX, etc.)
- `@xyflow/react@12.4.0` with dagre layout library; zoom/pan/minimap built-in
- Recharts for metrics (Revenue/Error charts, not touched in this scope)

---

### Seams & extension points

1. **Definition input boundary:** `buildWorkflowDag(definition: unknown)` is the only entry point from the API contract. It's already defensive, narrows to DagNode/DagEdge, and accepts any shape. An editor can build/validate/patch the definition JSON and re-pass it to the visualizer without touching the graph builder.

2. **Dagre layout API:** Layout happens in `layoutDag()` (WorkflowGraph:133). Dagre config (rankdir, ranksep, nodesep, acyclicer) is a single call (line 147). Swappable with another layout engine if needed; position assignment to xyflow nodes (line 149–162) is straightforward.

3. **ReactFlow lifecycle hooks:** Currently listening only to `onNodeClick` for trace selection (TraceGraph:90–95). No `onConnect`, `onEdgeClick`, or `onEdgesChange`. Adding drag, edge creation, node deletion requires enabling `nodesDraggable` + `nodesConnectable` and wiring handlers.

4. **DagNode metadata:** `DagNodeData.meta` (workflowDag.ts:114–125) carries structured step metadata: `stepId`, `runtime`, `nodeRef`, `expression`, `mode`, `concurrency`, `raw`. The `raw` field preserves the original step JSON; an editor can modify it and re-run `buildWorkflowDag()`.

5. **Definition persistence:** No write endpoints exist yet. API contract is read-only (`fetchWorkflowDetail`). A visual editor must POST to a new endpoint (e.g., `PUT /__blok/workflows/:name/definition`) to persist edits back to the runner's WorkflowRegistry.

6. **Run trace vs. definition graph:** `TraceGraph` renders from `NodeRun[]` (live execution state), `WorkflowGraph` renders from the workflow definition. They use the same visual layout logic but different data sources. Editing a definition does not retroactively change a finished run's trace.

7. **Keyboard nav ready:** RunTracePage (runs/$runId.tsx:68–105) already binds j/k for step navigation, 1-5 for mode switching. An editing mode could re-use or extend this pattern.

---

### Hard constraints & invariants

1. **Workflow definition is JSON, stored as `unknown`:** The runner's WorkflowRegistry holds raw JSON; Studio never imports the runner's TypeScript types. This is intentional decoupling. An editor must work with the JSON shape directly, with no type safety from the runner side.

2. **Immutable run traces:** Once a run finishes, its `NodeRun[]` array is locked. The trace reflects what actually executed, not the current workflow definition. Editing the definition does not retroactively change historical runs.

3. **Step ID is the sole identity:** Steps are identified by the `id` field in the definition. The builder uses it as a label (or falls back to `use` / step kind). If an editor renames a step's `id`, child contexts (nested step parentage, iteration tracking) may break unless the editor also updates all references.

4. **Depth and stepIndex are computed at runtime:** `depth` (nesting level in flow control blocks) and `stepIndex` (order in execution) are assigned by the runner when a run starts, not stored in the definition. An editor cannot pre-compute these; they emerge from the runtime execution model.

5. **Expressions are strings, not parsed:** Fields like `branch.when`, `forEach.in`, `loop.while` are accepted as opaque strings (or objects, coerced to string via `summarizeExpression`). Studio does not parse or validate `$` / `js/` expressions; the runner's interpreter owns that.

6. **No partial updates:** The API contract is "fetch whole workflow definition" → edit → POST whole definition back. There is no PATCH or field-level mutation. Concurrent edits require optimistic locking or last-write-wins.

7. **Trigger cannot be changed at design time:** `trigger` is treated as immutable metadata (used for labels + sample body provenance). The v2 workflow schema allows one trigger per workflow. An editor would need explicit design to support trigger mutations (and corresponding runner schema changes).

---

### What must change for the vision (visual editing capability)

1. **Write endpoint for definitions:**
   - `PUT /__blok/workflows/:name/definition` with request body: `{ definition: unknown, dryRun?: boolean }`
   - `dryRun: true` validates the definition (runs through `buildWorkflowDag`, type checks) without persisting
   - Returns errors + the resulting DAG (for preview) or success + updated definition
   - Required for any mutation from Studio

2. **Definition schema validation:**
   - A schema validator (JSONSchema, Zod, or TypeScript codegen from runner's types) must live in a shared package, imported by both runner and Studio
   - Studio uses it for real-time validation during editing (highlight invalid steps, missing required fields)
   - Currently Studio blindly renders malformed input; validation will improve UX and prevent bad definitions reaching the backend

3. **Node palette & node creation UI:**
   - Palette component listing available node kinds (regular steps by `use`, subworkflow, branch, forEach, loop, switch, tryCatch, wait) with icons + descriptions
   - Canvas context menu or sidebar panel to insert new nodes
   - Requires defining a "default" or "template" shape for each node kind (e.g., a new branch gets `{ id: "branch_1", branch: { when: "true", then: [], else: [] } }`)
   - Can reuse the existing step-kind renderers; no new visual components needed

4. **Interactive graph editing (ReactFlow integration):**
   - Enable `nodesDraggable: true` with a `onNodesChange` handler to persist positions (or ignore positions, let dagre re-layout)
   - Enable `nodesConnectable: true` with `onConnect` handler to validate edge creation (e.g., prevent connecting to merge nodes)
   - Add `onNodeClick` context menu (delete, edit properties, duplicate)
   - Add `onEdgeClick` → delete edge (remove step from sequence)
   - Node double-click or side panel to edit step properties (id, use, inputs, expressions, etc.)

5. **Property inspector for steps:**
   - Modal or side panel to edit a selected node's properties:
     - Common: `id`, `use` (for regular), `runtime` (fallback)
     - Conditional: `branch.when`, `forEach.in`, `forEach.as`, `loop.while`, `loop.maxIterations`, `switch.on`, etc.
     - Expression editor for `$` and `js/` syntax (can start minimal: textarea with optional syntax highlighting)
   - Must generate new JSON and call `buildWorkflowDag()` to preview DAG changes in real time

6. **Conflict detection & lineage tracking:**
   - If a step is deleted, any child reference (e.g., nested steps in a branch's `then` arm) must be preserved or explicitly garbage-collected
   - If a step ID is renamed, a find-and-replace pass must update all `subworkflow` targets that refer to it
   - Consider adding a "lint" layer to catch orphaned steps, unreachable arms, etc.

7. **Undo/redo & local drafts:**
   - Store edited definition in a local state object (Zustand store or React Context), not persisting until user clicks Save
   - Support undo/redo stack (or use a library like Immer + Redux)
   - Compare current draft against published definition; prompt if unsaved

8. **Trigger editing (optional first cut):**
   - Today trigger is read-only. To support editing, the runner schema must allow optional trigger mutation or the editor must warn "trigger changes require manual runner restart"
   - For MVP, freeze trigger; focus on steps, branches, loops

9. **Node discovery & registry (registry/marketplace feature):**
   - Today `use` is a freeform string; no built-in validation or palette
   - A registry endpoint (e.g., `GET /__blok/nodes/available`) would list discoverable nodes with metadata (name, description, inputs schema, outputs schema, icon)
   - Palette can filter + search nodes; double-click inserts with auto-filled ID
   - Post-MVP (Tier 2)

10. **Expression editor (syntax highlighting + hinting):**
    - Today expressions are plain text in step properties
    - A Monaco Editor or CodeMirror instance could provide syntax highlighting, variable autocompletion (`$` context vars, `.` chaining)
    - Tie to the `VARS_UPDATED` SSE event from runs for live context reflection
    - Post-MVP (Tier 2)

---

### Risks & gotchas

1. **DAG stability under editing:**
   - If the user moves a node on the canvas, should the position be persisted (and where)? Dagre will re-run and fight manual positions every time the definition reloads
   - **Decision:** Either freeze positions in the definition (cost: bloat, vendor lock-in) or treat positions as ephemeral UI state and re-layout on every definition change (simpler, consistent with n8n)

2. **Step ID collisions:**
   - Two steps can't share an `id`. Editor must enforce uniqueness and auto-generate names (e.g., `step_1`, `step_2`) if the user doesn't provide one
   - When duplicating a node, the editor must change the ID

3. **Orphaned definitions (steps removed from sequence but not deleted):**
   - Current schema allows arbitrary JSON. If an editor removes a node from the DAG but doesn't explicitly delete it from the definition, the runner might still try to execute it (if referenced elsewhere, e.g., a goto or indirect call — not currently supported, but schema is open)
   - Recommend a "validate & clean" pass when saving

4. **Context variable shadowing:**
   - `forEach` and `loop` introduce loop variables (`as`, `while`). A user could accidentally name two nested iterations the same and shadow outer scope
   - Studio can warn but cannot fully validate (variable resolution depends on runtime context, not static analysis)

5. **Expression validation & type safety:**
   - Expressions (`$...`, `js/...`) are interpreted at runtime. Studio cannot validate them statically. A user could write `branch.when: "$unknown.field"` and only discover the error when a run fails
   - Recommend early validation: fetch a sample run's VARS_UPDATED events to introspect available context, warn on likely typos
   - Post-MVP (Tier 2)

6. **Circular dependencies & infinite loops:**
   - The DAG builder assumes acyclic workflows (back-edges are only for intended forEach/loop heads). If the editor allows creating arbitrary edges, it could form unintended cycles
   - Dagre handles cycles but may produce unintelligible layouts. Recommend a cycle-detection lint pass

7. **Subworkflow target polymorphism:**
   - A `subworkflow` step can target a literal workflow name (e.g., `"child"`) or an expression (e.g., `"$.workflowName"`). The canvas can't show two targets on one node
   - **Decision:** In the canvas, subworkflow nodes link only to literal targets; expressions are hidden in the property inspector

8. **Trigger type mismatch after edit:**
   - The examples body (sample request) is tied to `trigger.http.examples.body` or recorded from a run. If the user changes the trigger type (HTTP → Cron), the examples become stale
   - Recommend clearing examples + prompting the user to provide new ones

9. **Multi-user editing & persistence order:**
   - No locking or versioning system exists. If two developers edit the same workflow simultaneously via different UIs (Studio + filesystem + CLI), last-write-wins
   - Post-MVP (Tier 2)

10. **Performance at scale:**
    - Large workflows (100+ steps) may render slowly in xyflow. Dagre layout is O(n²) in the worst case; virtualization isn't applicable to a graph (only to lists like StepRail)
    - Recommend testing with 50–100 step workflows early; consider lazy rendering or clustering large subgraphs

11. **Run trace vs. definition drift:**
    - After editing a workflow definition, old runs' traces will no longer align with the current DAG (step IDs may have changed, steps may be deleted)
    - Studio must clearly communicate this: "Viewing a trace of workflow v1.2; current definition is v2.0"
    - Post-MVP (Tier 2)

---

### Concrete seams for a visual editor to plug in

| Component | File(s) | Responsibility | Seam |
|-----------|---------|-----------------|------|
| **Graph Layout** | `workflowDag.ts` | Parse definition JSON → DagNode/DagEdge | Input: raw definition (mutable); Output: DAG (pass to layout) |
| **Visual Layout** | `WorkflowGraph.tsx:layoutDag()` | Run dagre, map to xyflow nodes | Dagre config (ranksep, nodesep); position persistence decision |
| **Canvas Renderer** | `WorkflowGraph.tsx` | Render nodes/edges, handle clicks | Enable `nodesDraggable`, `nodesConnectable`; add context menus |
| **Step Renderers** | `WorkflowGraph.tsx:234–421` | Render 12 node kinds | Reuse as-is; add edit mode styling if needed |
| **Property Inspector** | (new component) | Edit step properties | Accept `DagNode`, output modified `DagNode.data.meta.raw` → new definition |
| **Node Palette** | (new component) | List available node templates | Query `GET /__blok/nodes/available` (future); hardcode templates for MVP |
| **Definition Persistence** | (new API method) | Save edited definition | `PUT /__blok/workflows/:name/definition` with dryRun validation |
| **State Management** | (new Zustand store) | Hold edited definition draft | `useWorkflowEditor` store with undo/redo |
| **Validation** | (new validator package) | Real-time feedback on edits | JSONSchema or Zod; shared with runner |

---

**Summary:** Today Studio is a read-only trace + analytics viewer. The seams are clean: definition → DAG builder → layout engine → xyflow renderer. Enabling editing requires:

1. A write endpoint (`PUT /workflows/:name/definition`)
2. Property editor for step metadata + expression input
3. Enabling xyflow's interactive modes (drag, connect, click)
4. Real-time validation (JSONSchema + lint rules)
5. A Zustand store for draft state + undo/redo

The rendering pipeline (workflowDag → dagre → xyflow) needs no changes; it's already decoupled from persistence. **No hard blockers; the gap is UX + validation + API, not architecture.**