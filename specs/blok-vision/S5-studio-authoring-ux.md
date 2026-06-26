# S5 — Studio Authoring UX: Connect-Picker, Live Preview, Run-One-Step & Replay

## Status — Draft for review · depends on: S4 (Studio visual editing), S3 (expression ergonomics & fixes), S1 (JSON IR) · phase: 2

## 1. Problem & motivation

Blok's Studio is a beautiful **read-only** trace viewer. The vision demands it become a *visual view+edit canvas* that beats n8n. S4 delivers the structural editing primitives (write endpoint, validation, palette, drag/connect). But structural editing without **authoring feedback** is a worse n8n: you can drop a node, but you can't see what data flows into it, can't hand-write `$.state.fetch.data.id` without typos, can't test the one node you're editing without re-running the whole workflow, and can't tweak a failed run's payload and try again.

The four wins this spec delivers — connect-picker, live preview, run-one-step, replay-with-payload — are the *exact* features that make n8n/Windmill/Trigger.dev *feel fast*. Blok is uniquely positioned to ship them cheaply because **the trace store already records per-step `inputs`/`outputs` for every run** (`NodeRun.inputs`/`outputs`, `core/runner/src/tracing/types.ts:229-230`) **and** carries typed `inputSchema`/`outputSchema` per node (`triggers/http/src/runner/nodeCatalog.ts:17-26`). The data the picker, preview, and pin need is already on disk.

Concretely, today an author writing `$.state.fetch.data` has to:
1. Remember the upstream step's `id` from memory (no autocomplete).
2. Guess the output shape (no schema, no sample).
3. Run the **entire** workflow to discover a typo'd path silently passed a literal through (the `BLOK_MAPPER_MODE` footgun class — now `strict` by default, so it 500s instead, which is better but still a full-run round-trip to find out).
4. For a branch `when`, hit the **live silent-500 bug** S3 fixes — but even fixed, they're flying blind on what `ctx` contains.

A connect-picker that emits provably-valid references is the *structural* cure for the expression footgun (D5), not just an ergonomic nicety. The canvas (S4) will generate `$.state.<id>` references en masse, and an MCP agent (S11) needs the same introspection surface — so the endpoints here are shared kernel paths (D7), never Studio-only.

## 2. Current state in Blok

**Trace data is rich and already persisted.** Every `NodeRun` carries `inputs?: unknown` and `outputs?: unknown` (`core/runner/src/tracing/types.ts:229-230`), plus `depth`, `stepIndex`, `parentNodeId`, `iterationIndex`. `GET /__blok/runs/:runId` returns `{ run, nodes: NodeRun[] }` (`core/runner/src/tracing/TraceRouter.ts:1062`). The live `/runs/:id/stream` SSE emits `NODE_COMPLETED` with outputs. **This is the live-preview and trace-port data source — no new recording needed.**

> **Caveat the draft glossed:** the recorded `outputs` is the *post-persistence* shape — i.e. what the runner already wrote to `ctx.state` after applying `as`/`spread`/`ephemeral`. A step with `spread: true` does **not** appear under `state[id]`; its keys are merged into the top level. A step with `ephemeral: true` is **not in state at all**. So hydration cannot naively do `ctx.state[run.id] = run.outputs` — it must replay the persistence rules. This is the single hardest correctness point in the spec; §7.2 addresses it by reusing the runner's own `PersistenceHelper.applyStepOutput` rather than re-deriving the shape.

**Node catalog with schemas already exists.** `GET /__blok/nodes` (`triggers/http/src/runner/HttpTrigger.ts:999`) returns `NodeCatalogEntry[]` with `inputSchema`/`outputSchema` as parsed JSON Schema (`triggers/http/src/runner/nodeCatalog.ts:17-26`). For `defineNode` nodes the schema is real (Zod reflection); for `runtime.*` (cross-runtime) nodes it's per-SDK and may be absent. **This is the connect-picker's *static* type source — the picker can show output ports even for steps that have never run.**

**Replay exists but is primitive and HTTP-only.** `POST /__blok/runs/:runId/replay` (`TraceRouter.ts:1118`) re-dispatches the original HTTP trigger, accepting `overrides: { method, path, headers, body }` (`TraceRouter.ts:1143`), strips sensitive headers via `filterReplayHeaders` (`TraceRouter.ts:1149`), sets `X-Blok-Replay-Of` for lineage, and Studio has a `replayRun(runId, overrides)` client (`apps/studio/src/lib/api.ts:294`). **Replay-with-edited-payload is ~80% built — what's missing is the *UI* (a payload editor pre-filled from the original body) and an honest non-HTTP-trigger answer.**

**Single-node execution already exists as a test seam.** `NodeTestHarness` (`core/runner/src/testing/TestHarness.ts`) executes one node against a synthetic `Context` with `TestContextOverrides`, runs the real `BlokService.run()` → validate → handle → output path, and returns `{ success, data, error, durationMs, logs }`. **This is the run-one-step engine for in-process nodes** — though see §7.3 for the gap it does *not* cover (resolving the node from a `use:` ref, and `runtime.*` nodes).

**Gaps:** no connect-picker; no live expression preview; no pin-data; no run-one-step HTTP endpoint; replay has no payload-editing UI; the Mapper (`core/shared/src/utils/Mapper.ts`) has no "evaluate-this-expression-against-this-ctx" entry point for preview.

## 3. Goals & non-goals

**Goals**
- **Connect-picker**: select an upstream step's output field from a tree → Studio inserts a valid `$.state.<id>.<path>` expression. Zero hand-typing of references.
- **Live expression preview**: as the author edits an input expression, show the *resolved value* against the most recent run's `ctx` (or pinned data), inline, type-faithful, with the Mapper's error+hint on failure.
- **Run-one-step**: execute a single in-process node with editable inputs against a chosen context snapshot, see output without running upstream steps.
- **Pin-data**: freeze a step's output so iterating downstream uses frozen data instead of re-hitting APIs — Studio-local, client-side, ephemeral.
- **Replay-with-edited-payload**: one-click "replay this run" with the original body pre-loaded into an editor, tweak, re-fire. Reuse the existing endpoint.

**Non-goals**
- Expression *language* changes — owned by S3 (this spec consumes S3's fixed `when` and LRU-cached Function compiler).
- Canvas structural editing (drag/connect wiring, palette, inspector chrome) — owned by S4. This spec only adds the picker/preview *widgets* that live inside S4's inspector.
- Persisting pin-data into the canonical IR (S1) for production execution — pin-data is a Studio-local authoring aid (see §4 Option C, rejected).
- Run-one-step for `runtime.*` (cross-runtime) nodes — **deferred** (§7.3); MVP covers in-process `module`/`local` nodes, which is where authoring iteration concentrates.
- Multi-user concurrent-edit locking — deferred to post-MVP per dossier risk #6.
- Mid-workflow `wait.for`/checkpoint resume durability.

## 4. Options & alternatives

### Option A — Live preview & picker from **last-run trace only**
**How:** picker and preview read the most recent `NodeRun[]`. Output ports built from each step's actual recorded `outputs`. Preview resolves the author's expression against the recorded `ctx` via a new `POST /__blok/eval`.
**Pros:** dead simple; real shapes, no schema-vs-reality drift (n8n `typeVersion` rot, dossier risk #8); reuses 100% of trace records; matches n8n's NDV exactly.
**Cons:** useless before the first run (empty workflow, new step); no port info for a step that errored before producing output.

### Option B — Schema-first picker + trace-grounded preview (hybrid) — *recommended*
**How:** the **picker** merges two sources per upstream step: (1) static `outputSchema` from `GET /__blok/nodes` (works before any run), (2) live `outputs` from the last run (works for `js/`-shaped dynamic outputs the schema can't predict). **Preview** stays trace-grounded (Option A's `/eval`). **Pin-data** is a client-side Zustand+localStorage map injected into `/eval` and run-one-step context — not persisted to the IR.
**Pros:** picker works on a never-run workflow *and* on dynamic outputs — Blok is the only competitor with both typed schemas (Windmill) and a trace store (n8n). Pin-data as ephemeral state honors D1 (Studio state never becomes source of truth).
**Cons:** two port sources to reconcile; show schema as "expected", trace as "last seen". Slightly more UI.

### Option C — Full n8n-style `pinData` persisted in the IR — *rejected*
**How:** add `pinData: { [stepId]: json }` to the v2 IR (S1); the runner honors it (pinned step returns frozen data instead of executing).
**Cons:** **couples an authoring convenience to the execution engine and the canonical format.** A pinned production workflow that silently returns stale data is a footgun worse than the `when` bug. Bloats the IR (D1), requires runner changes to `RunnerSteps` and persistence. Fails the ponytail "does this need to exist?" test for MVP. If shared pins are later demanded, promote to a pass-through `ui.pin` field (D2 pattern) — YAGNI now.

## 5. Recommendation & rationale

**Option B.** It's the laziest complete path and the most *Blok-native*: Blok is the only platform in the competitor set with **both** typed node schemas **and** a per-step trace store. The hybrid picker exploits exactly that double advantage.

**Ponytail lens — reuse before build:**
| Feature | Reuse | New code |
|---|---|---|
| Replay-with-payload | existing `/replay` endpoint + `replayRun` client (`api.ts:294`) | UI dialog only |
| Live preview | the Mapper's `replaceObjectStrings` (`Mapper.ts`) | one ~40-line `/eval` route + `ExpressionPreview` component |
| Run-one-step | `NodeTestHarness` (`TestHarness.ts`) | node-resolve-from-`use` + HTTP route + warning banner |
| Connect-picker | `GET /__blok/nodes` + `GET /runs/:id` | frontend tree-walk, no backend |
| Pin-data | Zustand + localStorage (already in Studio) | one store, zero backend, zero IR change |

**Against C:** pin is an authoring scratchpad, not a production semantic. Client-side keeps D1 intact and saves a runner change.

**Consistency with D-decisions:**
- **D5** — this spec *is* the picker+preview half of D5; S3 owns the `when` fix and the LRU cache that makes `/eval` cheap under rapid typing. **Hard dependency:** without S3's cache, `/eval` recompiles a `Function` per keystroke (`Mapper` recompiles every `replaceString` today — dossier §1) — debounce mitigates but doesn't fix it. Live preview must not ship before S3's cache lands.
- **D7** — `/eval` and `/steps/:id/run` are the same code paths S11's MCP tools call (`blok_eval`, `blok_run_step`). Kernel-shared, never Studio-only.
- **D1** — pin-data and any future canvas state stay out of the IR; the IR is the only source of truth.
- **S2 interaction** — once `use:` refs are version-pinned scoped (`@scope/node@^1.2.0`, D4), run-one-step and the picker resolve the node *via the same registry resolver S2/S9 introduce*. MVP can resolve against the in-process node map; the resolver swap is additive. Flagged so we don't bake the unscoped lookup in as the only path.

## 6. How it improves Blok

- **Authors stop typing `$.state.<id>` by hand** — the single biggest source of silent-pass-through bugs becomes a click that *emits a provably-valid reference* (the structural D5 cure).
- **Edit-debug loop collapses from "re-run whole workflow" to "run this one node"** — Windmill/n8n parity on Blok's existing harness.
- **Failed-run triage becomes one click**: open the failed run → "Replay with edited payload" → fix the bad field → re-fire (Trigger.dev's headline feature, ~80% already in Blok).
- **Live preview kills the `BLOK_MAPPER_MODE` surprise** — you see `undefined`/the hint *before* you save, not as a 500 at runtime.
- **AI-native dividend (D7):** `/eval` and `/steps/:id/run` are exactly how an MCP agent *verifies* a generated expression resolves and a node produces the expected shape — same endpoints, no divergence.

## 7. Architecture & design

### 7.1 New backend endpoints (under `/__blok/`, behind the existing FW-1 trace-auth gate + a new authoring kill-switch)

Both new endpoints **execute author-supplied expressions/nodes**, so they are gated by **two** things: (1) the existing FW-1 default-deny-in-prod trace-auth gate (`TraceRouter.ts:295`), and (2) a new `BLOK_AUTHORING_DISABLED=1` kill-switch so a deployment can expose read-only trace viewing *without* the authoring/exec surface. Default: enabled in dev, **disabled when `NODE_ENV=production`** unless explicitly opted in via `BLOK_AUTHORING_ENABLED=1`. This is a new attack surface — called out in §8 for security review.

**`POST /__blok/eval` — expression dry-run (live-preview engine)**
```jsonc
// request
{
  "expression": "$.state.fetch.data.id",       // or "js/ctx.state.fetch.data.id", or "${...}"
  "fromRunId": "run_abc",                       // hydrate ctx from a recorded run (optional)
  "overrides": { "state": { "manual": 1 } }     // pinned/manual values, deep-merged last (optional)
}
// response
{ "ok": true, "value": "user-123", "type": "string" }
// or
{ "ok": false, "error": "ctx.state.fetch is undefined",
  "hint": "step 'fetch' has no recorded output — run it first or pin its data" }
```
Implementation: `const ctx = hydrateCtxFromRun(fromRunId, overrides)` (§7.2), then call the **exact** Mapper the runner uses — `Mapper.replaceObjectStrings({ __v: expression }, ctx)` — and return `{ value: result.__v, type: typeof result.__v }`. Forces a try/catch so preview never throws to the client; on failure returns `{ ok: false, hint }` using the Mapper's existing hint heuristics (`Mapper.ts:139-163`). Because it's the same Mapper, **preview == runtime** (no drift). ~40 lines on the router.

**`POST /__blok/workflows/:name/steps/:stepId/run` — run-one-step**
```jsonc
// request
{
  "inputs": { "url": "https://..." },           // raw step inputs (may contain $.state.* expressions)
  "fromRunId": "run_abc",                        // context to resolve inputs against (optional)
  "overrides": { "state": { ... } }              // pinned/manual values (optional)
}
// response
{ "ok": true, "data": {...}, "durationMs": 42, "logs": ["..."] }
// or { "ok": false, "error": {...}, "logs": [...] }
```
Implementation: see §7.3. **Inputs are resolved exactly once**, by the harness's own ctx path — the draft's separate `resolveInputs` flag is removed because it invited double-resolution (resolve in the endpoint, then again inside `BlokService.run`). The endpoint hands raw inputs + hydrated ctx to the harness and lets the *single* runtime resolution path do the work.

### 7.2 Context hydration helper — `hydrateCtxFromRun(runId, overrides)`

The correctness crux. Lives in `core/runner/src/tracing/hydrateCtx.ts`.

```
1. Load node_runs for runId (cap to the steps the caller needs — §8 risk 5).
2. Build an empty Context with ctx.request from the run's recorded trigger inputs.
3. For each *successful* node_run in stepIndex order:
     reuse PersistenceHelper.applyStepOutput(ctx, step, run.outputs)
   — the SAME function the runner uses to honor as / spread / ephemeral.
4. ctx.prev = last successful run's full envelope.
5. deepMerge(ctx.state, overrides.state); apply overrides.request etc.  // pins enter here, last-wins
6. return ctx.
```

> **Why not just `ctx.state[id] = run.outputs`** (the draft's hand-wave): that ignores `as`/`spread`/`ephemeral`, so any workflow using those knobs would preview against a *wrong* ctx — a silent lie worse than no preview. Routing through the runner's own `PersistenceHelper.applyStepOutput` (`core/runner/src/workflow/PersistenceHelper.ts`) means hydration is *definitionally* identical to a real run. If that function isn't cleanly callable in isolation, the extraction to make it so is a ~1-file refactor and belongs in this spec. ~60 lines + possible helper extraction.

This one helper backs **both** `/eval` and run-one-step. Pins are not special-cased anywhere else — they're just `overrides.state` entries (step 5).

### 7.3 Run-one-step over `NodeTestHarness` — and its honest gaps

`NodeTestHarness` takes a *node instance*, not a `use:` ref. The endpoint must:
1. **Resolve the node** from the step's `use` via the runner's in-process node map (the same map `RunnerSteps` resolves against). **MVP scope:** in-process `module`/`local` nodes only.
2. **`runtime.*` nodes are out of scope for MVP.** They require a live SDK sidecar and the gRPC `RuntimeAdapter`; "run one step" against a Python/Go node means round-tripping the sidecar with a synthetic ctx the adapter doesn't currently accept piecemeal. The endpoint returns `400 { error: "run-one-step is not yet supported for runtime nodes", runtime: "python3" }` and the UI shows "Run-one-step covers in-process nodes; use replay for runtime nodes." This is the *honest* boundary the draft elided with "look up the node by `use` ref" — the lookup is trivial for in-process nodes and a non-starter for runtime ones.
3. Build ctx via `hydrateCtxFromRun`, wrap the node in `NodeTestHarness`, `harness.execute(inputs, { ctxOverrides })`, return the `TestResult`.

> ponytail: reuse `NodeTestHarness` wholesale for the in-process path; add only the node-resolve + HTTP wrapper. Do NOT build a parallel single-step runner, and do NOT build the runtime-node path on spec — defer until a user actually needs to iterate on a Python node in Studio.

**Side-effect caveat (unchanged from n8n):** a real run-one-step *does* fire real HTTP calls / charges. Mitigation: a UI warning banner + encouraging pins on upstream side-effecting steps. Not fully preventable for MVP; a declared-side-effect mock layer is a node-metadata concern for S9, noted in open questions.

### 7.4 Connect-picker (frontend, `apps/studio`)

A `<ConnectPicker stepId targetField>` popover, opened from a "🔗" affordance next to any expression input in S4's property inspector. Port model:

```ts
type OutputPort = {
  stepId: string;
  path: string;            // "data.id"
  expression: string;      // "$.state.fetch.data.id"  ← what gets inserted
  source: "schema" | "trace" | "both";
  sampleValue?: unknown;   // from last run, when source includes "trace"
  type?: string;           // from JSON Schema or typeof sampleValue
};
```
Build ports, for each step **upstream of the target in DAG order** (S4's `buildWorkflowDag` gives ordering): (1) flatten `outputSchema` object properties from `useNodeCatalog()` into dotted paths; (2) flatten the last run's `NodeRun.outputs` keys. Merge by `(stepId, path)`. **Only upstream steps are shown** — structurally prevents forward/cyclic refs (dossier risk #6). Also expose `$.req.*` and `$.prev.*` roots.

> **Edge the draft skipped:** for a step with `spread: true`, the schema/trace keys live at the *top of state* (`$.state.<key>`, not `$.state.<id>.<key>`); for `as: "x"` they're under `$.state.x`. The picker must emit the expression that *matches the persisted shape* — it gets this for free if it builds ports from the same `hydrateCtxFromRun` output rather than from raw `outputs`. **Recommendation:** the trace-port half of the picker should read from a `GET /__blok/runs/:id/state` projection (the hydrated `ctx.state` for that run) rather than raw `node_runs`, so picker emits and `/eval` resolve against an identical shape. This is one small additive endpoint reusing `hydrateCtxFromRun`, and it eliminates a whole class of "picker emitted `$.state.foo.bar` but the runner stored it at `$.state.bar`" bugs.

### 7.5 Live preview (frontend)

`<ExpressionPreview expression contextRunId pinnedData>` — debounced (250ms) `POST /__blok/eval` per keystroke; renders the resolved value (JSON-pretty for objects, with a type chip) or error+hint inline. Green-check / red-x mirrors n8n. Cheap only because of S3's LRU-cached Function compiler (hard dep, §5).

### 7.6 Pin-data (frontend, ephemeral)

Zustand store `usePinStore`: `Map<workflowName, Map<stepId, { value: unknown; pinnedFrom: runId; at: number }>>`, persisted to `localStorage`. A "📌 Pin output" button on any completed step captures its (hydrated, post-persistence) `state` slice. Pinned steps render a badge on the canvas. Pin values feed `/eval` and run-one-step as `overrides.state[stepId]`. "Clear pins" per workflow. No backend, no IR change.

> ponytail: localStorage + Zustand only. Skipped IR persistence (Option C); add a pass-through `ui.pin` field when users actually ask to share pins across machines.

### 7.7 Replay-with-edited-payload (frontend; backend already done)

On a run-detail page, a "Replay with edited payload" button opens a CodeMirror editor pre-filled with the run's recorded request body. On submit, call the **existing** `replayRun(runId, { body: edited })`. Surface `replayOf` lineage (already rendered).

**Non-HTTP triggers — honest answer:** the existing `/replay` endpoint is HTTP-trigger-specific (it re-dispatches the Hono request). For worker/cron-triggered runs there is no recorded HTTP request to edit. MVP shows: "Replay-with-payload is HTTP-only. For worker runs, re-enqueue from your queue." We do **not** build worker/cron re-dispatch-with-payload here — it's a per-adapter feature (NATS/BullMQ each differ) and belongs in S8 (modular triggers) if demanded. Messaged, not built.

### 7.8 File/dir changes

| Area | Change |
|---|---|
| `core/runner/src/tracing/TraceRouter.ts` | + `POST /eval`, + `POST /workflows/:name/steps/:stepId/run`, + `GET /runs/:id/state` |
| `core/runner/src/tracing/hydrateCtx.ts` | new — `hydrateCtxFromRun()` (backs all three) |
| `core/runner/src/workflow/PersistenceHelper.ts` | possible extraction so `applyStepOutput` is callable in isolation |
| `apps/studio/src/lib/api.ts` | + `evalExpression()`, + `runStep()`, + `useNodeCatalog()`, + `useRunState()` hooks |
| `apps/studio/src/components/` | new `ConnectPicker`, `ExpressionPreview`, `PinButton`, `ReplayPayloadDialog` |
| `apps/studio/src/stores/usePinStore.ts` | new Zustand+localStorage store |

## 8. Compatibility, migration & risks

**Backward-compat stance (hybrid appetite):** Fully additive. Three new read-mostly endpoints, all-new Studio UI, one client-side store. **Zero changes to the workflow IR, the runner's execution path, or existing authored `.ts`/JSON workflows.** The one possible code move (`PersistenceHelper.applyStepOutput` extraction) is a pure refactor with identical behavior, covered by existing runner tests. No migration tooling needed. Squarely the "bold for new surfaces, untouched for existing artifacts" lane.

**Risks & failure modes:**
1. **Run-one-step side effects fire** (real HTTP calls, charges). *Mitigation:* UI warning banner; encourage pin-data on upstream side-effecting steps. Not fully preventable (n8n parity). A declared-side-effect mock layer is an S9 node-metadata concern.
2. **`/eval` + run-one-step execute author-supplied code/nodes.** Must sit behind FW-1 default-deny (`TraceRouter.ts:295`) **and** the new `BLOK_AUTHORING_DISABLED`/`BLOK_AUTHORING_ENABLED` gate (§7.1, default-off in prod). Exposing `/__blok/*` unauthenticated now means remote-execution-via-run-one-step. **Flagged for security review.**
3. **Hydration shape correctness** (the draft's biggest blind spot). If hydration doesn't replay `as`/`spread`/`ephemeral`, preview/picker lie. *Mitigation:* route hydration through the runner's own `PersistenceHelper.applyStepOutput` (§7.2) so it's definitionally identical to a real run; picker reads `/runs/:id/state` not raw outputs (§7.4).
4. **Schema-vs-trace disagreement in the picker.** Show both, label "expected (schema)" vs "last seen (trace)". Never silently prefer one.
5. **Pinned data goes stale** — localStorage; show `pinnedFrom` runId + timestamp so authors know its age. Ephemeral by design avoids the worse Option-C footgun.
6. **`/eval` hydration cost** for huge runs (1000-step `forEach`). *Mitigation:* `hydrateCtxFromRun` caps replay to steps the target actually references — don't replay the whole trace. For preview of a single expression, only the referenced step ids need hydrating (parse `$.state.<id>` / `ctx.state.<id>` out of the expression first).
7. **Live preview before S3's cache** recompiles a Function per keystroke. *Mitigation:* hard-sequence — preview ships after S3's LRU cache (§5, §9).
8. **Runtime-node run-one-step is unsupported** and the UI must say so clearly, or authors will think Studio is broken on a Python step. Explicit 400 + UI message (§7.3).

## 9. Phased implementation plan

**Milestone 1 — Replay-with-payload.** Pure frontend: `ReplayPayloadDialog` over the *existing* `replayRun` endpoint, pre-filled from trace body. Ships in days, zero backend, validates the loop end-to-end. **No S4 dependency** — works on the current read-only Studio.

**Milestone 2 — Live preview.** `hydrateCtxFromRun` + `POST /__blok/eval` + `ExpressionPreview`. **Gated on S3's LRU-cached compiler landing first.** This is the expression-footgun cure. (Hydration helper built here is reused by M3/M4.)

**Milestone 3 — Connect-picker.** `useNodeCatalog` + `GET /runs/:id/state` + `ConnectPicker` popover, merging schema ports with hydrated-state trace ports. **Depends on S4** (property inspector to host the picker). Emits persistence-shape-correct `$.state.<id>` references.

**Milestone 4 — Run-one-step + pin-data.** `POST /…/steps/:stepId/run` over `NodeTestHarness` (in-process nodes only) + `usePinStore`. Closes the Windmill per-step-test gap for the common case.

Ordering note: M1 is independent and ships first for momentum; M2 builds the shared `hydrateCtxFromRun`; M3/M4 layer on S4 + reuse the helper.

## 10. Open questions

1. **Side-effect guard for run-one-step:** warning banner only (n8n parity) for MVP, with a declared-side-effect mock layer deferred to S9 node-metadata? (Recommend: banner now.)
2. **Runtime-node run-one-step:** confirm deferral. Is iterating on a Python/Go node inside Studio a real near-term need, or do authors edit those in their IDE and use replay? (Recommend: defer until asked — building the synthetic-ctx gRPC path on spec is the over-build to avoid.)
3. **`GET /runs/:id/state` projection** (§7.4): build the hydrated-state endpoint so picker emit and `/eval` resolve share one shape, or accept the raw-`outputs` picker and tolerate `spread`/`as` mismatches? (Recommend: build it — it's one route reusing `hydrateCtxFromRun` and it kills a whole bug class.)
4. **Authoring kill-switch posture:** confirm `/eval` + run-one-step default-OFF in production (`BLOK_AUTHORING_ENABLED=1` to opt in), inheriting FW-1 on top. (Recommend: yes — authoring exec on a prod trace endpoint is a footgun.)
5. **Pin field reservation:** reserve `ui.pin` in S1's IR schema *now* (so shared pins are a later additive turn-on), or leave it unreserved? (Recommend: reserve the name in S1, build nothing.)

---

**Files referenced for grounding (absolute):**
`/Users/wellprado/Projects/Personal/blok/core/runner/src/tracing/TraceRouter.ts` (run detail :1062, replay :1118, overrides :1143, header filter :1149, auth gate :295) · `/Users/wellprado/Projects/Personal/blok/core/runner/src/tracing/types.ts` (NodeRun.inputs/outputs :229-230) · `/Users/wellprado/Projects/Personal/blok/triggers/http/src/runner/nodeCatalog.ts` (catalog + schemas :17-26) · `/Users/wellprado/Projects/Personal/blok/triggers/http/src/runner/HttpTrigger.ts` (GET /nodes :999) · `/Users/wellprado/Projects/Personal/blok/core/runner/src/testing/TestHarness.ts` (run-one-step engine) · `/Users/wellprado/Projects/Personal/blok/core/runner/src/workflow/PersistenceHelper.ts` (applyStepOutput — hydration backbone) · `/Users/wellprado/Projects/Personal/blok/apps/studio/src/lib/api.ts` (replayRun :294, sendWorkflowRequest :454) · `/Users/wellprado/Projects/Personal/blok/core/shared/src/utils/Mapper.ts` (eval engine + hint heuristics :139-163).
