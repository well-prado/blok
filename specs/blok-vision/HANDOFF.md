# 📋 Handoff — Blok Core Redesign (execute from GitHub Project #5)

> Paste-able briefing for a fresh Claude Code session in `/Users/wellprado/Projects/Personal/blok`. Long on purpose.

## 0. Operating mode — READ FIRST, non-negotiable

**You are in PONYTAIL MODE, level `full`** (it should auto-load; if not, run `/ponytail full`). It governs *what you build*: stop at the first rung that works — does this need to exist? is it already in the repo? stdlib? one line? — then the smallest working diff. Deletion > addition. No unrequested abstractions. Mark deliberate shortcuts with `// ponytail:` comments. **But never simplify away** input validation, error handling, security, or anything the task explicitly requires. Non-trivial logic leaves one runnable check (a small test) behind.

**Parallelism + branches (the founder's explicit instruction):**
- **Fan out aggressively.** For tasks that don't touch the same files, spawn **parallel sub-agents** (the `Agent` tool, multiple in one message). Independent spikes, independent impl tasks across different packages, and the per-area test tasks are all parallelizable.
- **One branch per task.** Every task gets its own branch off `main` and its own PR. When sub-agents mutate files in parallel, give each agent **`isolation: "worktree"`** so their branches can't collide on disk.
- **But respect dependencies — do NOT blind-parallelize.** Several tasks are gated by contract decisions (see §4–§5). Resolve the gating spikes *first and alone*, then fan out the dependents. Two impl tasks editing `core/shared/src/utils/Mapper.ts` must be sequenced, not parallel.
- **You open PRs; the founder merges.** One task per PR. Branch from `main` (`git checkout main && git pull` first).

## 1. Mission & current stage

Rewrite **how Blok workflows are authored** so the variable/reference surface stops feeling unnatural. The founder dislikes `$.state.x` / `js/ctx...` / raw-`ctx` `when`; he *likes* the `.ts` workflow format. The agreed redesign (full detail in §3) replaces the stringly surface with **typed `step()` handles**, consolidates the framework into **`@blokjs/core`**, **deletes `Nodes.ts`**, and gives cross-runtime nodes **typed stubs** — while keeping `defineNode()`, the auto-persistence engine, and the 7 runtimes.

**Stage: spec + validation complete; implementation NOT started.** This is spec-first. The work has been adversarially validated and decomposed into a board. **Do not write core engine code until the M1 contract spikes resolve (§5).** Early work = resolve spikes → produce short decision docs (ADRs) → then implement.

## 2. The work board — GitHub Project #5 (exact location + IDs)

**Project:** `https://github.com/users/well-prado/projects/5` — title **"Blok Core Redesign"**. Repo: **`well-prado/blok`** (`gh` is authed as `well-prado`, scopes `project`+`repo`).

```
PROJECT_NUMBER = 5
PROJECT_ID     = PVT_kwHOAyzkKc4Bb2sX
STATUS_FIELD   = PVTSSF_lAHOAyzkKc4Bb2sXzhWkBlA
  Todo        = f75ad846
  In Progress = 47fc9ee4
  Done        = 98236657
```

**Contents:** 145 issues — 12 epics + 133 tasks (24 spike · 53 impl · 50 test · 6 docs). Every issue is labeled `redesign` + a type (`epic`/`task`/`impl`/`test`/`spike`/`docs`) + a milestone label (`M1`–`M4`), is on the board with Status **Todo**, and tasks link to their epic ("Part of #NNN"). Each task body carries **acceptance criteria** + **edge cases to test** (the test tasks target the validation holes).

**Milestones (repo milestones, by number):**
- `#10` **M1 — Foundation: freeze the contracts** (6 epics) — the decisions everything depends on
- `#11` **M2 — Authoring surface, packaging & migration** (4 epics)
- `#12` **M3 — Canvas round-trip + JSON twin** (1 epic)
- `#13` **M4 — Bulletproof: e2e, perf, marketplace seam, docs** (1 epic)

**The 12 epics (issue # → area):**

| # | Epic | Verdict |
|---|---|---|
| **#413** | **Typed `step()` handles + `$ref` engine** — *the core* | sound-with-risks |
| #296 | Workflow IR + published schema | sound-with-risks |
| #310 | Control-flow over handles (branch/switch/forEach/loop/tryCatch) | sound-with-risks |
| #323 | Remove the `ctx` authoring surface | sound-with-risks |
| #338 | Auto-persist-all + handle resolution | sound-with-risks |
| **#349** | **defineNode unchanged + import-registration (kill `Nodes.ts`)** | **needs-rework** |
| #363 | Typed `runtimeNode` stubs + `ListNodes` manifest codegen | sound-with-risks |
| #374 | `@blokjs/core` consolidation + packaging | sound-with-risks |
| #386 | Codemods + back-compat + hybrid coexistence | sound-with-risks |
| **#401** | **IR ↔ canvas round-trip + separate `layout.json`** | **needs-rework** |
| #428 | All 10 triggers as typed entry handles | sound-with-risks |
| #440 | End-to-end & bulletproofing | sound-with-risks |

**Read the board / a task:**

```bash
gh project item-list 5 --owner well-prado --format json --limit 300   # all items
gh issue view <N> --repo well-prado/blok                              # a task (acceptance + edge cases in body)
gh issue list --repo well-prado/blok --label "M1" --label task --state open   # M1 tasks
```

**Move a task on the board (you MUST keep this in sync — standing rule, §8).** Note: `gh project item-list` emits literal control chars in issue bodies that break `jq` and default `json.load` — parse with Python `json.loads(s, strict=False)`:

```bash
# find the board item id for issue #N (strict=False tolerates control chars):
gh project item-list 5 --owner well-prado --format json --limit 300 > /tmp/items.json
ITEM=$(python3 -c 'import json,sys;d=json.load(open("/tmp/items.json"),strict=False);print(next(i["id"] for i in d["items"] if i.get("content",{}).get("number")==int(sys.argv[1])))' <N>)
# set In Progress (or Done = 98236657):
gh project item-edit --project-id PVT_kwHOAyzkKc4Bb2sX --id "$ITEM" \
  --field-id PVTSSF_lAHOAyzkKc4Bb2sXzhWkBlA --single-select-option-id 47fc9ee4
```

Set a task **In Progress** when you start it, **Done** when its PR is up (or merged). Closing the issue (`Closes #N` in the PR, or `gh issue close`) also reflects on the board.

## 3. The agreed design (the "after" — this is what you're building toward)

- **Workflows stay TypeScript** (one orchestration language). The **7 sidecar runtimes are for NODES only** (Go/Rust/Java/C#/PHP/Ruby/Python).
- **Authoring (the handle syntax):**
  ```ts
  workflow("order-intake", { trigger: http.post("/orders") }, (req) => {
    const validate = step("validate", validateOrder, { body: req.body });
    const stock = step("checkStock", httpGet, { url: tpl`https://inv/stock/${validate.productId}` });
    return branch(stock.inStock, {
      then: () => step("ok", respond, { status: 201, body: step("create", createOrder, { qty: validate.qty }) }),
      else: () => step("no", respond, { status: 409, body: { error: "out of stock" } }),
    });
  });
  ```
  `step("id", node, inputs)` returns a **typed handle** shaped like the node's Zod `output`. Reading `x.field` records `{ $ref: { step, path } }`. `tpl` (tagged template) keeps refs structural inside strings. `branch(boolean handle | gt/eq/lt op)`, `forEach(handle, (item)=>)`. **No `$`, no `js/`, no `ctx`** in authoring — only handles + the per-trigger entry handle (`req`/`event`/`job`/`msg`/`tick`/`conn`/`args`/`rpc`).
- **Persistence (decided):** keep **auto-persist-every-output** to `state[id]` (the engine already does this via `applyStepOutput`); referenceable **anywhere** via its handle; `ephemeral:true` opts out. Not a manual "save" step.
- **Nodes:** `defineNode()` **UNCHANGED**. `Nodes.ts` **deleted** — local TS nodes imported directly (`import = registration`); cross-runtime nodes get a **generated `runtimeNode<In,Out>("name","runtime.x")` stub** from each runtime's `ListNodes` JSON-Schema manifest (`blokctl nodes sync`).
- **Package:** `@blokjs/core` = `runner` + `shared` + `helper`(DSL), one package; **nodes stay separate packages**; triggers opt-in; old `@blokjs/*` as deprecated re-export shims; lockstep release ends.
- **IR (S1):** the .ts DSL compiles to language-neutral JSON the canvas, JSON twin, and AI all consume; same `GrpcRuntimeAdapter` dispatch as today.

Full old→new with complete code: **`specs/blok-vision/Blok-Core-Redesign.pdf`**. Authoring-option comparison: **`specs/blok-vision/Workflow-Authoring-Options.html`** (Option **D** = the chosen direction).

## 4. Validation findings — RESOLVE THESE BEFORE BUILDING (full report: `specs/blok-vision/Core-Redesign-Validation.md`)

The design was adversarially attacked. It's buildable, but **several "drop-in" claims are false** and there are real gaps. These are already tasks on the board — don't re-discover them, *resolve* them:

1. **🔴 THE CONTRACT FORK (gates everything; first M1 spike, epic #413/#296).** The "byte-identical engine" claim is **FALSE**. The real Mapper (`core/shared/src/utils/Mapper.ts:269-288`) only resolves *string* values and recurses *into* plain objects — a structural `{ $ref: { step, path } }` is **never dereferenced**. And a handle compiles to **three different wire forms by position**: input value (`{$ref}` or `js/` string), inside `tpl` (structured segment), and **`branch.when`** (a **bare `ctx.state...` raw string**, because the if-else node raw-`eval`s a string). **Decide:** (A) DSL lowers handles to `js/ctx.state...` strings → reuse the engine byte-for-byte, but `{$ref}`-in-the-IR is then a fiction; or (B) add a real `$ref` branch to the Mapper → an engine change. **Pick A or B before any code.** This decision determines the published IR's `inputs` value type and unblocks ~half the board. → **RESOLVED in `specs/blok-vision/adr/0001-handle-ref-lowering.md`: Option C (structural `{$ref}` in the IR, deterministic load-boundary pass lowers to today's wire strings; engine untouched).**
2. **🔴 `needs-rework` — node keying (#349):** "`use` derived from `node.name`" is false — `node.name` is `"api-call"` but the registry key is `"@blokjs/api-call"`; there are **3 competing keying schemes** (the hand maps, `node.name`, HMR-by-file-path) and collisions are **silently last-write-wins**. Design the ONE canonical key rule first (its spike is on the board).
3. **🔴 `needs-rework` — Studio (#401):** `buildWorkflowDag` (`apps/studio/src/lib/workflowDag.ts:165`) mints **synthetic build-order ids** (`step-N`/`merge-N`), not `step.id`; synthetic nodes (merge/trigger/end) have **no step id** → a step-id-keyed `layout.json` can't position them; and the `$ref` IR it assumes doesn't exist yet.
4. **🟠 Expressiveness regression (#323/#386):** ~**65 of 393** shipped `js/` expressions carry *logic* (`||default`, `??`, ternary, `.map`) that a pure `{$ref}` path **cannot encode**. The handle model needs an escape hatch (or those move into nodes). The codemod must mark un-migratable exprs, not guess.
5. **🟠 `step()` registration mechanism is unspecified (#413):** how does `step()` called inside `then: () => …` append to the right arm? (ambient builder stack?) Biggest impl risk — spec it before implementing.
6. **🟠 Cross-arm handles make the type system lie** (a typed field that's `undefined` at runtime in the untaken arm); **ephemeral handle reads are silent** (must be made loud); **no-schema runtime nodes are the *common* case** (all 7 SDKs make the node schema optional → stubs get no types as nodes are written today); **tree-shaking unverified** (no `sideEffects:false`; 168 files import `@blokjs/runner`).

## 5. The execution gate — do this order

1. **M1 first, and within M1 the contract spikes first.** The `{$ref}`-vs-`js/`-string decision (finding #1) and the canonical-node-key decision (#2) are the two that unblock the most. Do them as focused spikes that output a short **ADR** (decision + rationale) committed to `specs/blok-vision/adr/`. These are NOT parallel with each other's dependents. → finding #1 is **DONE** (ADR 0001).
2. Once the contract is frozen, **fan out the rest of M1** (IR schema, control-flow lowering, context-surface removal, persistence guards) as parallel sub-agents in worktrees — they no longer conflict once the wire form is decided.
3. M2 (authoring surface, `@blokjs/core` packaging, migration codemod) builds on the frozen M1 contracts. M3 (Studio) needs the `step-N`-vs-`step.id` fix first. M4 is the bulletproof e2e/perf suite.

## 6. How to work (conventions — match the repo exactly)

- **Tooling:** `bun` (never npm), **Biome** not ESLint/Prettier (`bunx @biomejs/biome check --write <files>`; the pre-commit husky hook runs it — fix nits or it blocks the commit; common: `require("fs")`→`require("node:fs")`, string-concat→template, are auto-fixable with `--write --unsafe`). **Vitest** for tests.
- **CI is capped (spending limit):** every PR shows an instant **0-step ~1–3s "failure"** — that's GitHub refusing to start the job, **not** a code failure. **Validate locally** before opening a PR: `bun run ci` (full integration, needs Docker) or `bun run ci:fast` (no Docker). Tell the founder a red ✗ from the cap is safe; a real failure runs the full 7–9 min job.
- **Branches/PRs:** one task → one branch off `main` → one PR. PR body: `Closes #<task>` (use separate `Closes #a, Closes #b` keywords — a comma list only closes the first). **`Closes` on a task does NOT close its parent epic** — close epics manually when all children land.
- **Commits:** conventional; **always** end the body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Parallel sub-agents:** spawn them for independent tasks; pass `isolation: "worktree"` when they edit files; one PR each. Sequence anything touching the same file (esp. `Mapper.ts`, `core/workflow-helper/src/proxy/$.ts`, `workflowV2.ts`, the 8 `InternalStep` constructors in `WorkflowNormalizer.ts`).
- **Don't regenerate the PDFs/board unless asked** — they exist. PDF build scripts are in `specs/blok-vision/deck/` (need `npm i playwright highlight.js` + `npx playwright install chromium`; the scratch `node_modules` from this session won't persist).

## 7. Key locations

- **Specs & artifacts:** `specs/blok-vision/` — `S0`–`S12` specs, `_research-dossier.md`, `research/` (16 grounding briefs incl. `understand-runtimes.md`, `study-blok-current.md`, `understand-mapper.md`), `Blok-Core-Redesign.pdf`, `Workflow-Authoring-Options.html`, **`Core-Redesign-Validation.md`**, **`core-redesign-plan.json`** (the structured 12-epic/133-task source), **`adr/`** (decision records — start at `0001-handle-ref-lowering.md`).
- **The code the redesign touches:** `core/shared/src/utils/Mapper.ts` (resolution); `core/workflow-helper/src/proxy/$.ts` (today's `$` proxy + `unwrapProxies`), `…/components/workflowV2.ts` + `branch.ts`/`switchOn.ts`/`forEach.ts`/`tryCatch.ts`/`eq.ts`, `…/types/{StepOpts,WorkflowOpts,TriggerOpts}.ts`; `core/runner/src/{defineNode,NodeMap,Configuration}.ts` + `workflow/PersistenceHelper.ts` + `WorkflowNormalizer.ts`; `triggers/http/src/Nodes.ts` (the file to delete) + `runner/scanWorkflows.ts`; `proto/blok/runtime/v1/runtime.proto` (`ListNodes`); `sdks/*` (the 7 SDKs); `apps/studio/src/lib/workflowDag.ts`.
- **Open PRs from the spec phase** (founder may not have merged all — check `gh pr list`): #290 specs, #291 local-k8s, #292 vision deck, #293 authoring options, #294 core-redesign PDF, #340 validation report.

## 8. Standing rules (from founder memory — honor these)

- **Keep Project #5 in sync** as work progresses (you and sub-agents) — move items Todo→In Progress→Done. The active board is #5; #4 (Modular Observability) shipped as 0.7.0; #3 closed.
- **Any Blok framework bug you find → STOP and tell the founder immediately, in full detail. Never silently work around it.**
- The founder works **spec-first** — prefer decisions/specs/feasibility over code until a contract is frozen; don't write speculative core code.

## 9. Suggested first move

```bash
git checkout main && git pull
gh issue list --repo well-prado/blok --label M1 --label spike --state open   # the gating spikes
```

Open epic **#413** (handles + `$ref`) and epic **#296** (IR), find the **`{$ref}`-vs-`js/`-string contract spike**, set it **In Progress** on the board, and resolve it into a short ADR under `specs/blok-vision/adr/` — *that one decision unblocks the rest.* (Done: ADR 0001.) Then fan out M1 in parallel worktrees. Confirm with the founder before any breaking change to existing authored workflows (the appetite is **hybrid**: bold for new surfaces, backward-compatible for existing `.ts`/JSON + `$`/`js/` behind an opt-in schema version).
