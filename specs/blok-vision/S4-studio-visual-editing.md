# S4 — Studio Visual Editing: Canvas, Palette, Inspector

## Status — Draft v2 (adversarially revised) · depends on: S1 (Workflow JSON IR + published schema), S3 (expression `when`-footgun fix — soft) · phase: 2

## 1. Problem & motivation

Studio today is a read-only telescope pointed at runs. You can watch a workflow execute, expand a step, see inputs/outputs/errors — but you cannot change a single line. Authoring still means hand-writing `.ts` in `triggers/http/src/workflows/` or JSON under `workflows/json/`, then bouncing to the browser to see the graph. That round trip is the largest gap between Blok and the vision of "an AI assembles a complex backend in a day, and a human sees and tweaks it on a canvas."

Every competitor that matters closes this loop. n8n's canvas *is* the workflow. Windmill renders a visual DAG over its OpenFlow JSON with a per-step connect-picker that writes the expression for you. Blok has the harder half already built — a clean, defensive `definition → DAG → dagre → xyflow` pipeline (`apps/studio/src/lib/workflowDag.ts`) — and is throwing it away with `nodesDraggable={false}` and no write path.

The motivation is concrete: (1) the visual canvas is Vision pillar #1 and the showcase surface; (2) it is the human-readable counterpart to AI authoring — the AI emits the JSON IR (S1), the human inspects and nudges it on the canvas, both consuming the *same* artifact; (3) the connect-picker (S5) is the single biggest ergonomics lever for the `$`/`js/` system, and it can only exist once there is an editable inspector to host it.

## 2. Current state in Blok

**The DAG pipeline is already a clean editing seam.** `buildWorkflowDag(definition: unknown)` (`apps/studio/src/lib/workflowDag.ts:539-560`) accepts the raw JSON the runner stores, classifies each step via `classifyStep()` (`workflowDag.ts:67-77` — discriminates `branch`/`subworkflow`/`wait`-object/`forEach`/`loop`/`switch`/`tryCatch`, else `regular`, mirroring the runner's `V2StepSchema`), and emits flat `DagNode[] + DagEdge[]` with **no position data**. Crucially, `DagNodeData.meta.raw` (`workflowDag.ts:124`) preserves the original step JSON. An editor mutates the source JSON and re-runs the builder for a live preview — no new visual components.

**Layout is a single swappable call.** `layoutDag()` (`apps/studio/src/components/trace/WorkflowGraph.tsx:133-162`) builds a dagre graph (TB, `nodesep: 40`, `ranksep: 60`, `acyclicer: "greedy"`), runs `dagre.layout`, and maps positioned nodes to xyflow. Positions are *computed*, not stored. The renderer ships `nodesDraggable={false}`, `nodesConnectable={false}`, `elementsSelectable={true}` (`WorkflowGraph.tsx:89-91`). The path in the original draft (`components/WorkflowGraph.tsx`) was wrong — it lives under `components/trace/`.

**There is no write endpoint.** `registerTraceRoutes` exposes `GET /workflows/:name` (`core/runner/src/tracing/TraceRouter.ts:385-456`) returning `definition: registered?.workflow` — the raw, pre-normalization JSON straight from `WorkflowRegistry`. Every workflow route is read-only. The router already has POST/PUT handlers for other resources, so the Express plumbing exists.

**The registry knows the source file.** `RegisteredWorkflow.source` (`core/runner/src/workflow/WorkflowRegistry.ts:49`) is the "Filesystem path or `<inline>`." This is the write-back target. The format carries **zero UI metadata** (confirmed across the dossier §1 and the normalizer). The runner ignores unknown step fields, so a pass-through `ui` field is free.

**A validator already exists in this repo — in zod, not as a callable package.** `core/workflow-helper/src/types/WorkflowOpts.ts` already exports `WorkflowOptsSchema`, `WorkflowV2Schema`, `StepOptsSchema`, and `V2StepSchema` (`StepOpts.ts`). `core/workflow-helper/dist/workflow.schema.json` ("Blok Workflow v2", draft-07) is the JSON-Schema *projection* of these zod schemas (and a copy lives at `packages/vscode-extension/schemas/workflow-v2.schema.json`). **The runner *also* already enforces the two hardest semantic invariants** the editor needs: `WorkflowNormalizer` walks the full nested step tree and throws on duplicate ids — *including across mutually-exclusive branch/switch arms* (`WorkflowNormalizer.ts:1136-1153`) — and on legacy `set_var` (`:1187`). **Ajv is not a dependency anywhere in the repo.** The original draft's "wrap `workflow.schema.json` with Ajv (already a tiny dep)" is false on both counts and is rejected below.

**Hard invariants the editor must respect:** step `id` is the sole flat-namespace identity (unique across *all* arms); `as`/`spread` mutually exclusive; expressions are opaque strings Studio must not parse; runs are immutable (editing a definition never alters a finished trace).

## 3. Goals & non-goals

**Goals (MVP):**
- A `PUT /__blok/workflows/:name/definition` endpoint with `dryRun` validation, persisting back to `RegisteredWorkflow.source`.
- A **callable validation surface** reusing the *existing* zod schemas + the *existing* duplicate-id walker — exported from S1's `@blokjs/workflow-schema`, imported by Studio. **Not a new validator.**
- A **node palette** to insert steps (regular + the 7 control-flow kinds) with auto-generated unique ids.
- A **property inspector** to edit a selected step's fields.
- Drag-to-reposition and (constrained) connect-to-reorder on the existing xyflow canvas.
- **Ephemeral positions** (dagre re-layout; per D2) with optional pass-through `ui:{x,y}`.
- An **undo/redo draft store** (snapshot-based) with explicit Save and an unsaved-changes guard.
- **Step-id rename propagation** — rewrites every `$.state.<id>` / `js/ctx.state.<id>` reference token.

**Non-goals (deferred):**
- Connect-picker, live-preview, run-one-step, replay-with-edited-payload → **S5**.
- Trigger editing on the canvas. **Open: a minimal trigger field-editor (path/method) is a candidate for M2 — see §10.**
- Node discovery from a registry (`GET /__blok/nodes/available`) → S6/S9; MVP uses hardcoded control-flow templates + free-text `use`.
- Monaco/CodeMirror expression autocompletion → S5.
- Concurrent-edit locking → post-MVP (ETag-lite 409 + last-write-wins).
- TS-code generation from canvas (canvas writes JSON; TS authors keep TS).

## 4. Options & alternatives

### Option A — Edit the JSON IR directly; canvas is a projection (recommended)
The canvas never holds a private model. The inspector mutates a draft copy of the *whole definition* JSON; `buildWorkflowDag(draft)` re-renders on every change. Save = `PUT …/definition`. Positions ephemeral (dagre).

- **How it works:** one Zustand `useWorkflowEditor` store holds `{ published, draft, past, future }`. Edits are pure functions `(draft, op) → draft'` (via Immer). The existing pipeline is the renderer.
- **Pros:** zero round-trip drift (JSON is the only model, per D1); reuses the entire existing DAG/layout/render stack untouched; the validation surface validates the exact artifact that gets saved; AI and human edit the identical shape.
- **Cons:** structural edits (insert into a branch arm, reorder) are JSON-tree surgery, not edge manipulation. That mapping is the real work (§7.4).
- **Competitor parallel:** Windmill's model exactly.

### Option B — Canvas-native model with serialize-on-save (n8n's model)
Canvas owns a rich node/edge graph with persisted absolute positions and name-keyed connections; serialize to workflow JSON on save.

- **Cons:** demands a bidirectional serializer that must round-trip *losslessly* — the exact drift trap D1 forbids. n8n's name-keyed connections are its worst fragility (dossier §2). Blok's identity is `id`-based and its control flow is *nested* (branch arms, tryCatch lanes), not flat edges — a flat edge model fights the format. **Rejected by D1/D2.**

### Option C — Monaco JSON editor with live DAG preview (lazy floor / Phase-1 increment)
Show the JSON IR in a Monaco editor with schema-backed validation (the published `workflow.schema.json` gives autocompletion + inline errors via Monaco's built-in JSON language service — **no custom validator UI, no Ajv**); render `buildWorkflowDag(parsed)` live beside it.

- **Pros:** ~2 days; Monaco's native JSON-schema support does the validation; no palette/inspector/drag machinery; genuinely useful for AI-output review and power users.
- **Cons:** not "visual editing." But it is a real shippable increment that de-risks the write endpoint, and a permanent fallback for shapes the inspector doesn't cover yet.

## 5. Recommendation & rationale

**Ship Option C as M1 (nearly free, de-risks the endpoint), then Option A as the real editor. Reject Option B.**

**Ponytail lens — what actually needs to exist?**
- Write endpoint + a callable validation surface: yes, unavoidable.
- A *new* validator (Ajv-wrapped JSON Schema): **no.** The repo already has zod `WorkflowV2Schema`/`StepOptsSchema` and a duplicate-id tree-walker in `WorkflowNormalizer`. S1's `@blokjs/workflow-schema` should *export the zod path Studio already ships* (zod is already a dependency of both `workflow-helper` and `runner`), plus extract the existing duplicate-id walker as `lint()`. Adding Ajv would be a second validator that must be kept in sync with the first — the precise drift D6 warns against. Monaco's *built-in* JSON-schema service handles the C-tier inline errors with the JSON-Schema projection that already exists in `dist/`. **Net new validation code: a thin `validate()` wrapper + extracting one existing function. Zero new deps.**
- Canvas-native model (B): no — it reinvents a serializer to fight a format that already has a clean projection pipeline.
- Option A reuses `buildWorkflowDag → layoutDag → xyflow` **as-is**. The only genuinely new code is the inspector, the palette, the snapshot draft store, and the structural-edit translation layer.

**Against the decisions:** D1 — A keeps JSON-as-projection, never canvas-as-truth. D2 — positions ephemeral, optional `ui` pass-through, no break. D5 — the inspector is where S5's connect-picker plugs in; build the host now. D6 — the validation surface is the workflow-domain instance of "one shared contract reused across consumers" (runner + Studio + future MCP `blok_validate`); crucially we collapse *toward* the existing zod validator rather than spawning a parallel Ajv one. D7 — `PUT …/definition` is a `blokctl`-callable code path, so an MCP `blok_edit_workflow` tool and the canvas hit identical validation.

The decisive argument for A over B: Blok's control flow is *nested JSON*, not flat edges. A branch's `then`/`else`, a tryCatch's lanes — arrays inside the step object, with globally-flat ids. A flat edge-graph model (B) cannot represent that without a lossy translation D1 bans. Editing the tree directly is both the laziest and the *only correct* path.

## 6. How it improves Blok

- **Closes the authoring loop:** see → edit → save → re-run, in Studio, no editor context-switch.
- **AI + human share one artifact:** the AI's MCP `blok_edit_workflow` and the human's canvas both `PUT` the same JSON IR through the same `@blokjs/workflow-schema` validation.
- **First validation gate in Studio:** today `buildWorkflowDag` "never throws on malformed input" (`workflowDag.ts:529-538`) — it renders a placeholder for garbage. The shared surface gives real inline errors (missing `use`, duplicate id, `as`+`spread`) *before* save, reusing logic the runner already trusts.
- **Rename safety:** the propagation pass turns a 30-minute find-replace-and-pray into a one-click safe rename, eliminating the `ctx.state['X'] is undefined` class of bugs CLAUDE.md lists as a top error.
- **The picker's home:** S5's connect-picker and live-preview have nowhere to live without S4's inspector.

## 7. Architecture & design

### 7.1 The write endpoint
```
PUT /__blok/workflows/:name/definition
Body: { definition: <WorkflowV2 JSON>, dryRun?: boolean, baseVersion?: string }
```
Handler (in `registerTraceRoutes` / `TraceRouter.ts`, beside `GET /workflows/:name`):
1. `const reg = WorkflowRegistry.getInstance().get(name)` → 404 if absent.
2. **Validate** via `@blokjs/workflow-schema.validate(definition)` → `{ ok, errors }`. On failure → `422 { errors }` (do NOT persist). This is the zod `WorkflowV2Schema.safeParse` result, formatted.
3. **Lint** (warnings, non-blocking): the extracted duplicate-id walker, orphaned `$.state.<id>` refs, `as`+`spread` collisions, unreachable arms. Returned as `warnings[]`. *(Note: duplicate-id is currently a hard throw in the runner; in the editor it surfaces as a blocking error in `errors`, since the runner would reject the file on reload anyway — see §8 risk.)*
4. If `dryRun` → return `{ ok: true, dag: buildWorkflowDag(definition), warnings }`. No write.
5. **Optimistic concurrency:** if `baseVersion` provided and `reg.workflow.version`/content-hash differs → `409 { current: reg.workflow }`. ETag-lite; last-write-wins is the fallback.
6. **Persist:** if `reg.source` is a real path (not `<inline>`):
   - JSON workflows → write the JSON verbatim.
   - TS workflows → **MVP refuses** (`422 { error: "TS-authored workflows are read-only in the canvas; edit the source or convert to JSON" }`). Round-tripping to TS source is lossy (drops the `input`/`output` Zod schemas) — out of scope.
   Update the in-memory `WorkflowRegistry` entry regardless so the running process reflects the edit immediately. **Footgun (§8): the in-memory edit and the file may now diverge if HMR re-scans the unchanged TS file — see risks.**
7. Return `{ ok: true, definition, warnings }`.

> ponytail: TS write-back is deliberately refused, not faked — silently dropping Zod schemas corrupts the source. JSON workflows cover the canvas-authoring path fully. Add a TS emitter only when a user asks and accepts the loss.

### 7.2 The shared validation surface (`@blokjs/workflow-schema`)
Owned by **S1**, consumed here. **It wraps what already exists — it does not introduce a new validator.**
```ts
export function validate(def: unknown): { ok: boolean; errors: SchemaError[] };  // WorkflowV2Schema.safeParse, formatted
export function lint(def: WorkflowV2): LintWarning[];                            // extracted duplicate-id walker + ref checks
export const jsonSchema: JSONSchema7;                                            // the existing dist/workflow.schema.json, for Monaco
```
Implementation: `validate()` = the existing zod `WorkflowV2Schema` (`core/workflow-helper/src/types/WorkflowOpts.ts:63`) `.safeParse`, with zod issues mapped to `SchemaError`. `lint()` = the existing duplicate-id tree-walker (`WorkflowNormalizer.ts:1136-1153`) lifted into a pure function, plus the cross-step `$.state.<id>` reachability check. `jsonSchema` re-exports the JSON-Schema projection already shipped at `dist/workflow.schema.json` — Monaco consumes it for C-tier inline errors with zero custom code. **The runner should adopt `validate()`/`lint()` at load time too, collapsing the two code paths into one (D6).**

> ponytail: zod is already a dep of `workflow-helper` and `runner`; the duplicate-id walker already exists and is already trusted by the runner. We export them, we don't rewrite them. No Ajv.

### 7.3 The draft store (`useWorkflowEditor`, Zustand)
```ts
interface EditorState {
  published: WorkflowV2 | null;   // last saved (from GET)
  draft: WorkflowV2 | null;       // working copy
  past: WorkflowV2[];             // undo stack (capped, 50)
  future: WorkflowV2[];           // redo stack
  dirty: boolean;
  apply(op: EditOp): void;        // pushes to past, mutates draft via Immer, clears future
  undo(): void; redo(): void;
  reset(): void;                  // draft = published
}
```
Edits are coarse-grained whole-definition snapshots (Immer produces the next draft). Undo = pop `past`.

> ponytail: snapshot undo, not command-pattern. A workflow JSON is KB-scale; snapshotting 50 copies is nothing. Skipped CRDT/op-log — add only if concurrent editing ships (it won't in MVP).

### 7.4 Structural edits → JSON tree ops
`editOps.ts`, pure functions on the draft:
- `insertStep(template, afterId?, intoArm?)` — push into `steps[]` or into `branch.then`/`else`/`forEach.do`/etc., with a fresh unique id from `nextId(draft, kind)`.
- `deleteStep(id)` — remove wherever it lives; `lint` flags dangling `$.state.<id>` refs.
- `reorderStep(id, beforeId)` — array splice within the owning arm.
- `connect(sourceId, targetId)` — "place target immediately after source in the same arm." **Cross-arm connects are rejected** (a step lives in exactly one arm). See §10 Q5 — this constraint needs a usability check.
- `updateStep(id, patch)` — shallow-merge into the step object; the inspector's write.
- **`renameStep(oldId, newId)`** — §7.5.

> ponytail: the arm-walking logic (find a step + its container by id, across nested arms) is written **once** as `findStepLocation(draft, id)` and reused by every op above. Note the field names match the runner exactly — control-flow bodies are `do` (not `steps`): `forEach.do`, `loop.do`, `switch.cases[].do`, `branch.then`/`else`, `tryCatch.try`/`catch`/`finally` (confirmed in `workflowDag.ts:314-456`). Getting these wrong silently builds an arm the runner ignores.

### 7.5 Step-id rename propagation (the hard problem)
Renaming `id` must rewrite every reference or it silently 500s. Refs live in:
- Step `inputs` strings containing `$.state.<oldId>`, `js/ctx.state.<oldId>`, or the legacy `ctx.vars.<oldId>` alias.
- `subworkflow:` polymorphic expressions referencing state.
- `as:` targets are *not* ids — leave alone.

`renameStep(draft, oldId, newId)`:
1. Reject if `newId` collides (walk all arms — reuse the `lint` id-set).
2. Set the step's `id`.
3. Deep-walk every other step's `inputs`/expression *string* fields; replace the token `state.<oldId>` (word-boundary) for both `$.`/`js/ctx.` prefixes, and the `vars.<oldId>` alias. Regex: `/\b(state|vars)\.<oldId>\b/g`.
4. Return `{ draft, rewrites: number }` so the UI shows "renamed `fetch` → `getUser`, updated 4 references."

> ponytail: token-replace on the string, not a full `js/` AST parser. Expressions are opaque strings (format invariant). A word-boundary `(state|vars)\.<id>` swap covers every documented reference form; it can over-match a literal string containing `state.fetch`, so we surface the rewrite count for the author to eyeball. `// ponytail: token-replace, AST-rewrite only if literal collisions bite.`

### 7.6 The palette
A sidebar of insertable kinds, each a template constant. Bodies use the runner's field names:
```ts
const TEMPLATES: Record<WorkflowStepKind, () => Partial<Step>> = {
  regular:     () => ({ use: "", inputs: {} }),
  branch:      () => ({ branch: { when: "true", then: [], else: [] } }),
  forEach:     () => ({ forEach: { in: "$.state", as: "item", do: [] } }),
  loop:        () => ({ loop: { while: "false", do: [] } }),
  switch:      () => ({ switch: { on: "$.state", cases: [], default: [] } }),
  tryCatch:    () => ({ tryCatch: { try: [], catch: [], finally: [] } }),
  subworkflow: () => ({ subworkflow: "", inputs: {}, wait: true }),
  wait:        () => ({ wait: { for: "1s" } }),
};
```
Drag onto canvas → `insertStep`. `use` for regular steps is a free-text field in MVP (no node registry — S6/S9). The existing renderers display the inserted node immediately via re-`buildWorkflowDag`.

> ponytail: `branch.when` defaults to the literal `"true"`, NOT a bare `$` expression — that is the S3 footgun (a bare `$`-proxy in `when` 500s silently at runtime; the canvas would otherwise generate this en masse). The inspector's `when` field carries an inline warning until S3's fix lands. Flagged per the standing rule.

### 7.7 The inspector
Right panel keyed off xyflow selection. Reads `meta.stepId` → finds the step in `draft` → renders a field set per kind:
- Common: `id` (rename-aware), `as`/`spread` (mutually-exclusive toggle), `ephemeral`, `retry`, `idempotencyKey`.
- regular: `use`, `inputs` (key/value rows; values are plain text holding `$.…` expressions — **S5 upgrades these to the connect-picker**).
- branch: `when` (with the S3 footgun warning). forEach/loop: `in`/`while`, `as`. switch: `on`/cases. subworkflow: target + `wait`.
Every change → `updateStep` / `renameStep`. Inline errors from `validate(draft)` scoped to the focused step.

### 7.8 Positions (D2)
Default: ignore positions, dagre re-layout on every draft change (already how `layoutDag` works). Flip `nodesDraggable={true}`; **discard `onNodesChange` position deltas** (snap back to dagre) unless the optional `ui` opt-in is on. Optional: persist `step.ui = { x, y }` on manual drag; `buildWorkflowDag` reads `meta.raw.ui`, and `layoutDag` seeds/honors dagre with it. The runner passes `ui` through untouched. **No format break** — legacy workflows lack `ui`, auto-layout fills in.

### 7.9 File/dir changes
```
core/workflow-helper/  (S1 owns)  → @blokjs/workflow-schema: validate()/lint()/jsonSchema
                                     (re-exports existing WorkflowV2Schema + extracted dup-id walker)
core/runner/src/tracing/TraceRouter.ts          → + PUT /workflows/:name/definition
core/runner/src/workflow/WorkflowNormalizer.ts  → extract dup-id walker as a pure exported fn (lint reuses it)
apps/studio/src/
  lib/editOps.ts                        (new — pure tree ops + findStepLocation + renameStep)
  stores/useWorkflowEditor.ts           (new — Zustand snapshot draft/undo)
  components/editor/Palette.tsx         (new)
  components/editor/Inspector.tsx       (new)
  components/editor/JsonEditor.tsx      (new — M1 Monaco + schema)
  components/trace/WorkflowGraph.tsx    (edit: drag/connect behind an `editable` prop)
  lib/api.ts                            (edit: putWorkflowDefinition())
```

## 8. Compatibility, migration & risks

**Backward-compat stance (hybrid appetite — fully clean):**
- `ui` is additive and runner-ignored → **no break** for any existing `.ts`/JSON workflow.
- `$`/`js/` syntax untouched — the inspector edits expression *strings* verbatim; rename only swaps the `state.<id>`/`vars.<id>` token.
- TS-authored workflows stay author-owned: the canvas refuses to overwrite them (read-only viewing still works). A deliberate guarantee, not a gap.
- `PUT …/definition` is a *new* route — purely additive.
- The validation surface reuses the runner's existing zod schema + duplicate-id check, so "valid in Studio" and "loads in the runner" cannot diverge.

**Migration tooling:** none for MVP (additive). Persisted positions need no migration — `ui` simply starts appearing on canvas-saved files.

**Failure modes:**
- *Save races (multi-editor / file + canvas):* last-write-wins + optional `baseVersion`/ETag 409. Locking deferred.
- *In-memory ↔ file divergence on TS workflows:* the endpoint updates the in-memory registry for JSON saves; for a TS workflow it refuses the write entirely, so no divergence there. For JSON, if an external editor + HMR re-scans the file after a canvas save, the canvas `published` snapshot goes stale → the next save 409s on `baseVersion`. Acceptable; documented.
- *Rename over-match:* surfaced rewrite count (§7.5); author verifies.
- *Duplicate-id on save:* the runner *throws* on duplicate ids at load. The editor must therefore treat duplicate-id as a **blocking `error`**, not a soft warning — otherwise a "successful" save produces a file the runner rejects on reload. (Corrects the draft, which filed it under non-blocking lint.)
- *Editing a TS workflow:* hard 422 with a clear message, not a silent corrupt write.
- *Trace ↔ definition drift:* old runs reference renamed/deleted steps. Studio shows a "trace of a prior definition" note when a run's step ids don't match the current definition (cheap set-diff; can land in S5).
- *Large workflows (100+ steps):* dagre is ~O(n²) worst case; test at 50–100; cluster/collapse only if it bites.
- *Inline workflows (`source === "<inline>"`):* not file-backed → in-memory edit only, lost on restart. Surface a banner; the affordance stays enabled (the in-process edit is still useful for a live tweak).

## 9. Phased implementation plan

**M1 — Write path + validation + Monaco floor (smallest shippable).** Export `@blokjs/workflow-schema` (S1; re-exports existing zod + extracted dup-id walker) + `PUT …/definition` with `dryRun`/422/persist-to-`source`. Plus **Option C**: Monaco JSON editor wired to the existing `workflow.schema.json` for native inline validation, with live `buildWorkflowDag` preview. *Exit:* edit a JSON workflow's text in Studio, save, see it re-run.

**M2 — Draft store + inspector.** `useWorkflowEditor` (snapshot undo/redo/dirty), the property inspector wired to xyflow selection, `updateStep`. Canvas still read-layout; editing is field-level. *Exit:* select a node, change `inputs`/`when`, save. *(Candidate: minimal trigger path/method field-editor — see §10 Q7.)*

**M3 — Palette + structural edits.** `Palette`, `findStepLocation` + `insertStep`/`deleteStep`/`reorderStep`/`connect`, drag-to-insert, enable `nodesDraggable`/`nodesConnectable` with the nested-arm mapping. *Exit:* build a 3-step workflow from scratch on the canvas.

**M4 — Rename propagation + lint surfacing.** `renameStep` with reference rewrite + count UI; duplicate-id as blocking error; `lint()` warnings inline. *Exit:* rename a step, watch downstream refs update, no runtime break.

**M5 (optional, → S5 boundary) — persisted `ui` positions.** Honor manual drags via `step.ui`.

## 10. Open questions

1. **Concurrent editing:** ETag-lite 409 + last-write-wins for MVP, or advisory locking now? *(Rec: ETag-lite, defer locking.)*
2. **TS write-back:** permanently read-only, or eventually a best-effort TS emitter that drops Zod schemas with a warning? *(Rec: read-only until a user demands it.)*
3. **Position persistence default:** ephemeral-only (D2) or persist `ui` from day one? *(Rec: ephemeral MVP; `ui` in M5.)*
4. **Validation ownership:** S1 ships both `validate()` (zod) and `lint()` (extracted dup-id walker), with the runner adopting both per D6 — confirm S1 takes the extraction of `WorkflowNormalizer`'s walker rather than S4 duplicating it.
5. **`connect` semantics on a nested DAG:** is "drag an edge = reorder within arm" intuitive, or do users expect free-form edges (which the format can't represent)? Needs a usability check in M3.
6. **Inline workflows:** banner-and-warn (rec) or hide the edit affordance for `source === "<inline>"`?
7. **Trigger editing:** frozen for MVP, or is a minimal trigger field-editor (path/method) in scope for M2? *(Rec: a path/method-only editor is low-risk and high-value — the trigger summary already round-trips through `summarizeTrigger`; full trigger config — concurrency/delay/debounce — stays out.)*

---

**Key file refs grounding this spec:** `apps/studio/src/lib/workflowDag.ts:67-77,124,314-456,539-560` (classifier, `meta.raw` seam, arm field names, builder); `apps/studio/src/components/trace/WorkflowGraph.tsx:89-91,133-162` (read-only flags, dagre — note `trace/` subdir, corrected from draft); `core/runner/src/tracing/TraceRouter.ts:385-456` (GET workflow, where PUT lands); `core/runner/src/workflow/WorkflowRegistry.ts:49` (`source` = write-back target); `core/workflow-helper/src/types/WorkflowOpts.ts:63` (`WorkflowV2Schema` — the existing zod validator to reuse); `core/runner/src/workflow/WorkflowNormalizer.ts:1136-1153` (existing duplicate-id walker to extract as `lint`); `core/workflow-helper/dist/workflow.schema.json` (JSON-Schema projection for Monaco — **not** an Ajv target).

---

**Top corrections vs. the draft:** (1) the validator already exists in **zod** (`WorkflowV2Schema`) plus a duplicate-id walker in the runner — the draft's "wrap with Ajv (already a tiny dep)" was wrong (Ajv is absent; zod is present); reuse, don't add. (2) `WorkflowGraph.tsx` is under `components/trace/`, not `components/`. (3) control-flow bodies are `do`/`then`/`else`/`try`/`catch`, not `steps` — templates and tree-ops must match. (4) duplicate-id must be a **blocking error**, not soft lint, since the runner throws on it at load. (5) `branch.when` template defaults to literal `"true"`, never a bare `$` (the S3 footgun).
