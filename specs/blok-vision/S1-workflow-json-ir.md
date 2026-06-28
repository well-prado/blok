# S1 — Workflow JSON IR + Published Schema

## Status — Final (adversarial pass) · depends on: — · phase: 1 (foundation) · feeds: S2, S4, S5, S6, S11

## 1. Problem & motivation

Blok compiles two author-facing surfaces — the TypeScript DSL (`workflow()` + `$` proxy) and v2 JSON — into one normalized runner shape (`InternalWorkflow`, `core/runner/src/workflow/WorkflowNormalizer.ts:114-119`). That convergence is the single most valuable asset Blok has for the vision: a visual canvas, an npm-like registry, and AI authoring all need *one* serializable, validatable, lossless representation of a workflow decoupled from TS source. Today that representation is an **implementation detail, not a contract**:

- The clean v2 step vocabulary is already a Zod discriminated union (`V2StepSchema`, `core/workflow-helper/src/types/StepOpts.ts:963`), and `WorkflowV2Schema` (`core/workflow-helper/src/types/WorkflowOpts.ts:63`) wraps it with name/version/trigger/steps. This *is* the IR — it just isn't *named* one, *versioned*, or *published as a stable contract*.
- There are **three schema artifacts for one format, two of them stale/divergent**:
  - `core/workflow-helper/dist/workflow.schema.json` — **generated** from `WorkflowV2Schema` by `scripts/build-schema.ts`, 699 lines, **complete** (already emits `forEach`/`loop`/`switch`/`tryCatch`/`subworkflow`/`wait`). Verified by running the generator: exit 0, all flow-control kinds present.
  - `packages/vscode-extension/schemas/workflow.schema.json` — **hand-maintained**, 387 lines, titled "Blok Workflow" (a *different, older* shape). **This is the file the VS Code extension actually points at** (`packages/vscode-extension/package.json:129`).
  - `packages/vscode-extension/schemas/workflow-v2.schema.json` — **hand-maintained**, 176 lines, titled "Blok Workflow v2", incomplete (branch + regular only). **Nothing consumes it** — it's pure dead drift.

  So the extension validates `.json` workflows against a hand-written schema that is *neither* generated *nor* the v2 shape, while a complete generated schema sits unused in `dist/`. This is the drift the vision must kill.
- Studio consumes `definition?: unknown` and narrows defensively (`apps/studio/src/lib/workflowDag.ts:17-18` documents this explicitly: "The builder accepts `unknown` and narrows defensively"). There is **no shared validator**; malformed input renders as placeholder nodes.
- The format carries **zero canvas metadata** (positions, notes), so a visual editor has nowhere to round-trip layout intent.

Per the dossier's D1, the AI-native and marketplace bets are *gated* on a published, versioned JSON IR that LLMs constrain-decode against and that canvas/registry consume losslessly. The fix is **formalization, not new architecture** — the IR and generator already exist, and `zod-to-json-schema` is already a build-time **devDependency**.

## 2. Current state in Blok (verified)

**The clean v2 IR already exists as Zod.** `V2StepSchema` (`StepOpts.ts:963`) is a discriminated union over: `V2RegularStepSchema` (`:201`), `V2BranchStepSchema` (`:352`), `V2SubworkflowStepSchema` (`:415`), `V2WaitStepSchema` (`:584`), `V2ForEachStepSchema` (`:678`, `z.lazy`), `V2LoopStepSchema` (`:734`, `z.lazy`), `V2SwitchStepSchema` (`:787`, `z.lazy`), `V2TryCatchStepSchema` (`:859`, `z.lazy`). `selectV2StepSchema()` (`:907`) field-discriminates exactly as Studio's `classifyStep()` does.

**A generator exists, is wired into the build, and works on the full union.** `scripts/build-schema.ts` runs `zodToJsonSchema(WorkflowV2Schema, { name: "BlokWorkflowV2", target: "jsonSchema7", $refStrategy: "none" })` → `dist/workflow.schema.json`. Wired via `build:schema` (`package.json:29`), part of `build` (`package.json:27`). `zod-to-json-schema` is a **devDependency** (`package.json`, `^3.25.2`) because schema emission happens at build time. A test exercises every step schema through the generator (`tests/schemas.test.ts`). **Verified: the generator currently runs clean (exit 0) and the 699-line output already contains all four recursive `z.lazy` kinds.** The draft's premise that the published schema is "missing loops/switch/tryCatch" is true only of the *hand-written* artifacts — the generated one is complete.

**The normalizer is the lowering pass, not the IR.** `normalizeWorkflow(raw, sourcePath?)` (`WorkflowNormalizer.ts:162`) unwraps the v2 builder envelope (`_blokV2: true`, `:172`) and emits the v1-shaped `InternalWorkflow` (`:114`). `InternalStep` (`:56`) carries a `[key: string]: unknown` index signature (`:98`) — unknown fields pass through structurally, but each normalizer (`normalizeRegularStep` `:340`, branch `:444`, subworkflow `:544`, wait `:647`) *explicitly constructs* its `InternalStep`, so a new field is only threaded if copied in each constructor.

**The `$` proxy is already a deterministic compile step.** `unwrapProxies()` replaces `$.state.x` proxies with `"js/ctx.state.x"` strings before validation — by the time anything is JSON, every expression is a plain string. The IR has no proxy objects to serialize.

**The `$ref` contract is layered, not "same Mapper resolves structured refs."** The accepted M1 decision is Option C: the published IR may carry structural `{ "$ref": { "step": "...", "path": [...] } }` so canvas/JSON twin/AI can reason about references, but a deterministic load-boundary lowering pass must convert those refs to today's runtime strings before execution: `js/ctx.state.<step>...` for step inputs and `tpl`, and raw `ctx.state.<step>...` strings for `branch.when` because the if-else node raw-evals its condition. The existing Mapper does **not** dereference `{ $ref }` objects; it resolves strings and recurses into plain objects. Runtime byte-identity is true only after this lowering.

**JSON workflow loading does not Zod-validate today.** `scanWorkflows.ts` parses JSON and hands it to `normalizeWorkflow`; it does not call `WorkflowV2Schema.safeParse`. Any `validateWorkflow()` added in S1 is therefore advisory for Studio/CLI/registry authoring and publish checks, not a mandatory load gate. Turning it into a JSON load gate would be a behavior change because the step schemas are stricter than the current structural normalizer.

**Studio is a projection consuming `unknown`.** `buildWorkflowDag()` classifies by field presence and preserves `raw` per node (`workflowDag.ts:124`); positions are dagre-computed at render, never stored. **Critical:** `apps/studio/package.json` has **no dependency on `@blokjs/helper`** (verified — grep returns nothing). Any plan that has Studio `import { validateWorkflow } from "@blokjs/helper"` must *first add that dependency*, or route validation through the runner's HTTP API. The draft asserted Studio "already imports from `@blokjs/helper`" — that is false and is the spec's one real feasibility hole. Resolved in §7.5.

**Hard invariants the IR must preserve:** step `id` is the sole flat-namespace identity, globally unique across all arms; `as`/`spread` mutually exclusive; nested-flow step configs inline; `$` proxies are strings before validation; structural `$ref` values lower before runtime; trigger config is per-kind; `"ANY"` (not `"*"`) is the wildcard method.

## 3. Goals & non-goals

**Goals**
- Promote the existing `WorkflowV2Schema` to a **named, versioned Workflow IR** with **one published JSON Schema** that is the shared authoring/registry/AI/VS Code validation source.
- **One generator, one consumed artifact.** The VS Code extension points at the *generated* schema. Both hand-written schemas are deleted. Drift becomes structurally impossible (a CI equality check guards it).
- Add an optional `schemaVersion` discriminant so the format can evolve under semver without breaking existing files — the hybrid-appetite opt-in lever S2/S3 need.
- Add optional pass-through `ui` metadata (per-step `ui: { x?, y?, notes? }`) the normalizer threads through and the runner ignores — the canvas round-trip slot (D2), zero breaking change.
- Ship a **shared advisory validator** (`validateWorkflow(json) → { ok, errors }`) with a clearly-specified consumption path for Studio (the only consumer that lacks the dep today). It warns/gates authoring and publish flows; it is not a runtime load gate.

**Non-goals**
- Replacing TS as the human source of truth (D1).
- Canvas write endpoint / inspector / validation UX (S4).
- Node identity, scoping, version-pinned `use:` refs (S2). The IR must *accommodate* a `use:` string that may later carry `@scope/node@version`; S1 does not change `use` semantics.
- A second expression language or the `branch when` fix (S3).
- Persisting positions as canonical layout, edit-locking, companion files (D2: ephemeral for MVP).

## 4. Options & alternatives

### Option A — Formalize the existing v2 Zod schema as the published IR (generate, version, consolidate) — RECOMMENDED
Name the contract (`WorkflowIRSchema = WorkflowV2Schema` + optional `schemaVersion`). Give the generated schema a stable `$id`, publish it as a package export, **delete both hand-written schemas**, point the VS Code extension at the generated one, add a thin `validateWorkflow()`, add optional `ui` pass-through, and guard the whole thing with a CI equality assertion.

**Pros:** Reuses everything already built (Zod schemas, `zod-to-json-schema`, the generator, the test). The schema is *provably* in sync with runtime acceptance — both derive from one Zod source. Matches D1. Constrained-decoding-ready. Net ~150 lines new, ~563 lines deleted (both stale schemas).
**Cons:** `zod-to-json-schema` output for `z.lazy` unions isn't pretty (already true today and already works with `$refStrategy: "none"` — no change needed). The runner-internal `InternalWorkflow` stays a separate lowering target — acceptable; it's an implementation detail, not a contract.

### Option B — Promote the runner-internal `InternalWorkflow` as the published IR
Publish the normalized v1-shaped `{ steps[], nodes{} }` form because it's what executes.
**Rejected:** it's the *worse* shape (the `nodes{}` indirection v2 removed), it's a TS `interface` not a schema, hand-maintaining its JSON Schema reintroduces drift, and it forces AI/canvas to author the ugly form. Contradicts the v2 ergonomics story.

### Option C — Greenfield language-neutral IR (Windmill OpenFlow-style)
Define a fresh IR; make TS+JSON+canvas all projections of it.
**Rejected:** throws away the v2 schema, normalizer mapping, Studio classifier, and every authored workflow's shape. Massive migration, breaking change, violates the hybrid appetite. Pure speculation that v2 is inadequate — no evidence it is. The IR already exists; a greenfield one is a research project nobody asked for.

### Option D — Do nothing
**Rejected:** every downstream spec re-invents validation; the three-schema drift continues; n8n's marketplace-rot lesson goes unheeded.

## 5. Recommendation & rationale

**Adopt Option A.**

**Ponytail lens — does this need to exist? Reuse before build?** The IR, the Zod schemas, the generator, and the generator test all already exist. S1 is mostly **deletion-and-consolidation**: the single highest-leverage act is **deleting both hand-written schemas and pointing every authoring consumer at the one generated artifact** — that permanently eliminates the drift class of bug. The genuinely new code is small: the `schemaVersion` field (one Zod line), the `ui` field (a few lines + per-normalizer copy), the `validateWorkflow()` wrapper (~10 lines), the `exports` entry, and the CI equality assertion. Building a new IR (C) or republishing the worse internal shape (B) is work the codebase actively argues against.

**Honest correction to the draft:** the draft over-claimed the problem ("published schema missing flow-control kinds") and prescribed a fix for a non-problem (`$refStrategy: "root"`). The *generated* schema is already complete and the generator already works with `"none"`. **Do not touch `$refStrategy`** — changing it risks regressing a working build for cosmetics. The real problem is narrower and worse: the *consumed* schema (VS Code) is a stale hand-written file that isn't even the v2 shape, and Studio validates nothing. S1 fixes exactly that.

**Consistency with D-decisions:** D1 ✓ (TS stays human source; IR is the projection target). D2 ✓ (`ui` optional/ephemeral, normalizer pass-through, runner ignores). D4 ✓ (`use` stays a plain string; `schemaVersion` is the lever S2 uses to require version-pinned refs only at v3+). D5 ✓ (runtime expressions stay strings after `$ref` lowering; S3 fixes `branch when` independently). D7 ✓ (`validateWorkflow()` is the one shared advisory primitive blokctl/registry/Studio reuse).

## 6. How it improves Blok

- **AI authoring becomes reliable.** A published, complete schema with `$id` lets any LLM constrain-decode and self-validate before handing back — the bridge to "AI assembles a backend in a day" (vision #6). The blocker isn't the *generated* schema (it's complete) — it's that nothing publishes it as a stable, addressable contract the AI can pin to.
- **Studio stops rendering garbage.** Studio gains a real advisory validator and shows errors instead of placeholder nodes; the canvas (S4) builds on a validated graph.
- **The registry gets a free publish gate (S6).** Server-side publish validation = `validateWorkflow(payload)`. One function, reused.
- **Schema drift is structurally impossible for authoring validators.** TS helper validation and published schema derive from one Zod source; the CI equality check fails the build if they diverge. The JSON load path remains structural/legacy until a later migration explicitly changes it.
- **The canvas gets a round-trip slot.** `ui: { x, y, notes }` passes through untouched.
- **VS Code authoring improves immediately.** Pointing the extension at the complete generated schema gives autocomplete + inline docs for *every* step kind — today it points at a 387-line hand-written file describing an older shape.

## 7. Architecture & design

### 7.1 Name the contract
```ts
// core/workflow-helper/src/types/WorkflowOpts.ts
export const WORKFLOW_IR_VERSION = "2" as const;
export const WorkflowIRSchema = WorkflowV2Schema;   // the contract, named — no new schema logic
export type WorkflowIR = WorkflowV2;
```

### 7.2 `schemaVersion` envelope discriminant (additive, defaulted)
Add to `WorkflowV2Schema` (`WorkflowOpts.ts:63`):
```ts
schemaVersion: z.literal("2").default("2")
  .describe("Workflow IR schema version. Absent ⇒ '2'. v1 (legacy steps[]/nodes{}) is versionless, detected structurally by the normalizer.")
```
Every existing TS/JSON file (no field) is a valid v2 IR. This is the lever S2/S3 use to gate breaking changes (version-pinned `use:` refs required only at `schemaVersion >= 3`). It does not change the current shape.

### 7.3 Optional `ui` pass-through (D2)
Add to `V2RegularStepSchema` (`StepOpts.ts:201`) and each flow-step schema:
```ts
ui: z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  notes: z.string().optional(),
}).passthrough().optional()
  .describe("Canvas metadata. Ephemeral layout hint; runner ignores it. Absent ⇒ dagre auto-layout.")
```
**Threading (the feasibility detail the draft glossed):** `InternalStep`'s `[key: string]: unknown` (`WorkflowNormalizer.ts:98`) only helps if the field is *copied* into the explicitly-constructed `InternalStep`. So each normalizer that builds an `InternalStep` (`normalizeRegularStep:382`, branch `:516`, subworkflow `:572`, wait, forEach, loop, switch, tryCatch) needs `...(step.ui ? { ui: step.ui } : {})`. This is the *only* runner-side change and it's mechanical. The runner already ignores unknown step fields, so no execution behavior changes. `toJson()` includes `ui` (it's data, not a Zod schema).

**Strict-schema surface:** `StepOpts.ts` has 18 `.strict()` schema sites across the eight step kinds plus nested control-flow arms. Add `ui` everywhere or it will be position-dependent: a top-level step accepts it while the same step inside a branch/forEach/switch/tryCatch arm rejects it.

> ponytail: `ui` is `.passthrough()` so the canvas can add `color`/`collapsed`/`icon` later without a schema bump. Don't enumerate those now — YAGNI until S4 actually needs them.

### 7.4 One generator, one artifact (the consolidation)
Extend `scripts/build-schema.ts` to:
1. Set a stable `$id`: `https://schemas.blok.build/workflow/v2.json`.
2. Emit the **same** output to a checked-in published location: `core/workflow-helper/schemas/workflow.v2.json` (in addition to / instead of `dist/`, so it ships via the package and consumers can `import` it).
3. **Keep `$refStrategy: "none"`** — verified working; do not change it.

Add to `core/workflow-helper/package.json`:
```jsonc
"exports": { /* ... existing ... */ "./schema": "./schemas/workflow.v2.json" },
"files": ["dist", "schemas"]   // currently ["dist"] only — schemas/ must be added or it won't publish
```

**Delete** `packages/vscode-extension/schemas/workflow.schema.json` **and** `workflow-v2.schema.json`. Point `packages/vscode-extension/package.json:129` (`json.schemas[].url`) at the generated artifact — either bundle a copy at extension build time (VS Code can't resolve a node `exports` path) or reference `@blokjs/helper/schema` resolved into the extension's `schemas/` dir by its build. *(Bundling a generated copy is simplest; the CI check below keeps it honest.)*

**Anti-drift guard (extend `tests/schemas.test.ts`):**
```ts
it("checked-in schema equals generated", () => {
  const generated = zodToJsonSchema(WorkflowIRSchema, { name: "BlokWorkflowV2", target: "jsonSchema7", $refStrategy: "none" });
  const onDisk = JSON.parse(readFileSync(resolve(__dirname, "../schemas/workflow.v2.json"), "utf8"));
  expect(normalize(onDisk)).toEqual(normalize(generated)); // normalize() strips $id/title/description wrapper
});
```
Fails the build if anyone hand-edits the schema or forgets to regenerate.

### 7.5 Shared validator (with Studio's consumption path resolved)
```ts
// core/workflow-helper/src/ir/validate.ts
export function validateWorkflow(input: unknown):
  | { ok: true; workflow: WorkflowIR }
  | { ok: false; errors: { path: string; message: string }[] } {
  const r = WorkflowIRSchema.safeParse(input);
  return r.success
    ? { ok: true, workflow: r.data }
    : { ok: false, errors: r.error.issues.map(i => ({ path: i.path.join("."), message: i.message })) };
}
```
Exported from `@blokjs/helper`. Consumers:
- **blokctl** and the **registry publish gate (S6)** — both already (or will) depend on `@blokjs/helper`. Direct import. ✓
- **Studio** — has **no `@blokjs/helper` dependency today** (verified). Two honest options; **pick (a) for S1**:
  - **(a) Add `@blokjs/helper` as a Studio dependency and import `validateWorkflow` directly.** The helper is already a leaf package (no runner dependency), so the decoupling that `workflowDag.ts:17` relies on is preserved — Studio depends on the *helper*, never on `@blokjs/runner`. Smallest diff; client-side validation; no new endpoint.
  - **(b) Validate server-side via the runner API** (`GET/POST …/validate`) and have Studio call it. Defer to S4 if Studio's bundle can't take the Zod weight — but that's a real endpoint to design, so it's out of S1's lazy path.

  Recommendation: **(a)**. It's the one-dep change that makes Studio's `definition: unknown` narrowing (`workflowDag.ts`) optional rather than load-bearing. If the Studio bundle-size cost of shipping Zod proves unacceptable, fall back to (b) in S4 — non-breaking either way.

This validator is **advisory**. It is safe for Studio hints, CLI checks, and registry publish gates. It must not be wired into `scanWorkflows.ts` as a mandatory load gate in S1; the existing JSON path is structurally tolerant and would become stricter overnight.

### 7.6 Example IR (the published shape)
```json
{
  "schemaVersion": "2",
  "name": "Fetch and Respond",
  "version": "1.0.0",
  "trigger": { "http": { "method": "GET" } },
  "steps": [
    { "id": "fetch", "use": "@blokjs/api-call",
      "inputs": { "url": "https://example.com/api" },
      "ui": { "x": 100, "y": 40 } },
    { "id": "respond", "use": "@blokjs/respond",
      "inputs": { "body": { "$ref": { "step": "fetch", "path": [] } } },
      "ui": { "x": 100, "y": 160 } }
  ]
}
```
At the published-IR layer the response input is structural. At the runtime layer the load-boundary lowering pass converts it to today's accepted string form before the Mapper runs.

### 7.7 File/dir changes
| Change | File |
|---|---|
| Name IR + add `schemaVersion` | `core/workflow-helper/src/types/WorkflowOpts.ts:63` |
| Add `ui` pass-through to step schemas | `core/workflow-helper/src/types/StepOpts.ts` (`:201` + each flow schema) |
| Shared validator | `core/workflow-helper/src/ir/validate.ts` (new) + export from `index.ts` |
| Generator: `$id`, checked-in published path (keep `$refStrategy: "none"`) | `core/workflow-helper/scripts/build-schema.ts` |
| Published schema artifact | `core/workflow-helper/schemas/workflow.v2.json` (new, generated, checked in) |
| `exports["./schema"]` + `files: ["dist","schemas"]` | `core/workflow-helper/package.json:11,23` |
| Thread `ui` through each `InternalStep` constructor | `core/runner/src/workflow/WorkflowNormalizer.ts` (`:382,516,572` + flow normalizers) |
| Anti-drift equality assertion | `core/workflow-helper/tests/schemas.test.ts` |
| Point extension at generated schema; **delete both** hand-written schemas | `packages/vscode-extension/package.json:129`, **delete** `schemas/workflow.schema.json` + `schemas/workflow-v2.schema.json` |
| Add `@blokjs/helper` dep; consume `validateWorkflow` | `apps/studio/package.json`, `apps/studio/src/lib/workflowDag.ts` / consumption site |

## 8. Compatibility, migration & risks

**Backward-compat stance (hybrid appetite): fully additive, zero breaking change.**
- `schemaVersion` defaults to `"2"` — every existing TS/JSON workflow validates unchanged.
- v1 (`steps[]`/`nodes{}`) stays versionless, detected structurally by the normalizer as today; the published IR schema describes v2 only (see open question 4).
- `ui` is optional; absence is the norm (dagre auto-layout, existing behavior).
- The runner sees no new required fields and ignores `ui`/`schemaVersion`; structural `$ref` values are lowered to existing strings before runtime — no runtime behavior change.

**Migration tooling:** none required for correctness. `blokctl migrate workflows` (already exists for `set_var`) *could* stamp `schemaVersion: "2"`, but it's cosmetic — skip until something needs it.

**Failure modes & mitigations:**
- *Generator output for `z.lazy` unions.* **Already works** with `$refStrategy: "none"` (verified: exit 0, 699-line complete output). Risk is regression if someone changes the strategy — so the spec explicitly says don't. The CI equality test catches any generator behavior change.
- *Validator accidentally becoming a load gate.* Do not wire `validateWorkflow()` into `scanWorkflows.ts` in S1. Keep it advisory for Studio/CLI/registry; add a separate warn-first migration if JSON load enforcement is ever desired.
- *Studio lacks `@blokjs/helper`.* Resolved in §7.5(a): add the leaf-package dep (no runner coupling) or fall back to a server-side validate endpoint in S4. Non-breaking either way. **This was the draft's one false plumbing claim — now corrected.**
- *VS Code can't resolve a node `exports` path for `json.schemas`.* The extension build bundles a generated copy into its `schemas/` dir; the CI equality test keeps it in sync.
- *`ui` bloats large JSON.* Accepted for MVP (D2); `ui` is opt-in and only the canvas writes it. A future companion-file option is non-breaking.
- *`schemas/` not in `files`.* Easy to forget — the package currently ships `["dist"]` only (`package.json:23`). Must become `["dist", "schemas"]` or the export 404s post-publish. Called out as a checklist item, not a footnote.

## 9. Phased implementation plan (smallest-shippable-first)

**M1 — Consolidate to one published schema (1 day).** Add `$id` + checked-in `schemas/workflow.v2.json` to the generator (keep `$refStrategy: "none"`); add `exports["./schema"]` + `files: ["dist","schemas"]`; **delete both hand-written schemas**; point the VS Code extension at the generated one; add the anti-drift equality test. *Ships: one complete, published, never-drifts schema; kills the three-way drift that exists today.* Independently valuable — unblocks AI constrained-decoding against a stable `$id`.

**M2 — Name the IR + `schemaVersion` (0.5 day).** Export `WorkflowIRSchema`/`WorkflowIR`; add the defaulted `schemaVersion`; tests proving existing files validate unchanged. *Ships: the semver lever S2/S3 need.*

**M3 — Shared advisory validator (0.5 day).** `validateWorkflow()` + tests, including v1 detection that returns a clear legacy/unsupported result instead of strict-rejecting with noisy v2 errors. *Ships: the primitive S4/S6/S11 reuse.*

**M4 — `ui` pass-through (1 day).** Add to step schemas; thread through each `InternalStep` constructor in the normalizer; round-trip test (IR → normalize → `toJson()` preserves `ui`). *Ships: the canvas round-trip slot (D2), ahead of S4.*

**M5 — Studio adopts the validator (0.5 day; may slip to S4).** Add `@blokjs/helper` dep; replace `definition: unknown` consumption with `validateWorkflow()`; surface errors.

Total ~3.5 days. M1 is the load-bearing deliverable (it's almost entirely deletion); everything after is small and additive.

## 10. Open questions

1. **Schema `$id` / hosting.** `https://schemas.blok.build/workflow/v2.json` implies a hosting commitment. Ship the schema *only* as a package export (`@blokjs/helper/schema`) + VS Code bundle for now, add the hosted URL when the docs site is ready? **Recommend: package export first; the `$id` string can point at the future URL immediately (it's just an identifier — it need not resolve for validation).**
2. **`schemaVersion` value space.** `"2"` (major-only) vs full semver `"2.0.0"`? **Recommend `"2"`** — the workflow's own `version` field is its semver; `schemaVersion` is the *format major*, bumped to `"3"` by S2/S3 for breaking changes.
3. **`ui` scope for MVP.** Just `{ x, y, notes }`, or also `color`/`collapsed`/`icon`? **Recommend the minimal three**; `.passthrough()` lets the canvas add fields later without a schema bump.
4. **Publish a v1 schema, or declare v1 "legacy, normalizer-only, no published schema"?** **Recommend the latter** — v1 is structurally detected and migration-discouraged; publishing its schema invites new v1 authoring. (Confirm: no demand for a v1 IR.)
5. **Does the registry (S6) validate against the *IR schema* or also resolvable `use:` refs?** Out of S1 scope. S1 commits: `validateWorkflow()` checks **shape only** as an authoring/publish primitive; node-existence / version-resolution is S2/S6's concern. Confirm this boundary so S6 doesn't assume S1 resolves refs.
6. **Studio validation transport — client-side dep (§7.5a) vs server endpoint (§7.5b)?** S1 recommends (a) for the smallest diff, but if Studio's bundle can't absorb Zod, (b) is the fallback and belongs in S4. Confirm appetite for adding `@blokjs/helper` to the Studio bundle.

---

**Key files grounding this spec (all verified):** `core/workflow-helper/src/types/StepOpts.ts:963` (the IR as a Zod union; recursive `z.lazy` kinds at `:678,734,787,859`, 18 `.strict()` sites across step kinds and nested arms), `core/workflow-helper/src/types/WorkflowOpts.ts:63` (`WorkflowV2Schema` envelope), `core/workflow-helper/scripts/build-schema.ts` (the generator — verified runs clean, complete 699-line output with `$refStrategy:"none"`), `core/workflow-helper/package.json:23,29` (`files:["dist"]`, `build:schema`, and `zod-to-json-schema` as a devDependency), `packages/vscode-extension/package.json:129` (extension points at the hand-written `workflow.schema.json`, **not** the generated one — the consolidation target), `packages/vscode-extension/schemas/{workflow.schema.json,workflow-v2.schema.json}` (387- and 176-line stale hand-written copies, both to delete), `core/runner/src/workflow/WorkflowNormalizer.ts:56,98,162,382,516,572` (the internal lowering target + eight `InternalStep` constructors that must copy `ui`), `triggers/http/src/runner/scanWorkflows.ts` (JSON parse/normalize path, no Zod gate today), `apps/studio/src/lib/workflowDag.ts:17,67,124` (the projection consuming `unknown`; **Studio has no `@blokjs/helper` dependency** — the one plumbing gap S1 must fund).

**Corrections applied to the draft:** (1) the VS Code extension consumes `workflow.schema.json` (387 lines), not `workflow-v2.schema.json` — both are stale and both get deleted; (2) the *generated* `dist/workflow.schema.json` is already complete (verified) — the "missing flow-control kinds" problem applies only to the hand-written files; (3) **do not** switch `$refStrategy` to `"root"` — `"none"` works today and the change is a regression risk for cosmetics; (4) Studio does **not** import `@blokjs/helper` — that dependency must be added (§7.5) or validation routed server-side; (5) `package.json` `files` is `["dist"]` and must become `["dist","schemas"]` or the schema export won't publish; (6) the existing Mapper does not resolve structured `{ $ref }`, so runtime byte-identity depends on a load-boundary lowering pass; (7) JSON workflows are not Zod-validated on load today, so `validateWorkflow()` is advisory unless a later migration intentionally changes the load path.
