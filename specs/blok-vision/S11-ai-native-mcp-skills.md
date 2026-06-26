# S11 — AI-Native Surface: MCP + Skills

## Status — Draft for review · depends on: S1 (JSON IR + published schema), S2 (node identity/scoping), S6 (registry), S7 (module-descriptor) · phase: 3 · compat: **additive** (one error tightened behind existing `BLOK_MAPPER_MODE`)

## 1. Problem & motivation

Blok's sharpest vision claim — *"an AI assembles a complex backend in a day"* — has **no first-class machine surface today**. An LLM building a Blok app works blind: it reads `CLAUDE.md`/`AGENTS.md` from context, hallucinates node names that may not be installed, guesses a node's input shape (the Zod schema is never surfaced programmatically), writes `inputs: {...}` that fail Zod at run time, and has no contract to install a node, scaffold a workflow, or run a headless test before declaring done. The loop is "edit → `blokctl dev` → read a stack trace → guess again" — exactly the loop agents are worst at (semantic misuse persists even when syntax is constrained — `research-ai-native.md:17`).

This is Blok's actual moat, not a nice-to-have. n8n can't do AI-native authoring — its source of truth is the canvas, not text (`research-n8n.md:79`). Blok already owns the three primitives an AI needs and competitors lack:

1. **Zod input/output schemas on every node** (`defineNode({input, output})`, `core/runner/src/defineNode.ts`) — the schema *is* the API.
2. **A clean text workflow IR** — the v2 JSON that mirrors the TS DSL one-for-one (formalized as a published JSON Schema in S1).
3. **A serverless test harness** — `WorkflowTestRunner`/`NodeTestHarness` (`core/runner/src/testing/index.ts`) that runs without a trigger process.

They are simply not wired into an agent-facing contract. S11 wires them together: a control-plane MCP server over the `blokctl` kernel, a steering-error audit so the AI self-corrects instead of looping, and invocable per-task Skills. **S11 is wiring, not new architecture** — and the wiring is the whole point.

## 2. Current state in Blok (grounded)

**MCP exists — but it's the data plane, the wrong layer for authoring.** `triggers/mcp/src/McpTrigger.ts` (555 lines) exposes *user workflows* as MCP tools to external callers: `trigger.mcp` on a workflow → a `tools/list` entry, the workflow's `input` Zod → JSON Schema via `zodToJsonSchema` (`McpTrigger.ts:65,163,331`), executed through the full runner. There is **no control-plane MCP** — no `blokctl mcp serve` that lets an AI search/inspect/scaffold/install nodes and workflows *before* anything is deployed. Reuse note: the `@modelcontextprotocol/sdk` server transports and the `zodToJsonSchema` dep are already in the tree (`McpTrigger.ts:53-65`) — S11 reuses both, not the trigger's execution model.

**Search + install exist, but hit a centralized backend and patch source by regex.** `search()` (`search/nodes.ts:33`) fetches `BLOK_URL/package-list` (`search/nodes.ts:20`). `install()` (`install/node.ts:22`) writes a temp `.npmrc` (`install/node.ts:72`), `npm install`s a scoped package, then **regex-patches `src/Nodes.ts`** to inject an import and a registration entry (`install/node.ts:117,149,152`). That regex patch is brittle — an AI installing many nodes could corrupt the file. **Pre-existing risk S11 inherits; S2/S9 replace it with a manifest. Flag, don't fix here.**

**Schemas are never surfaced for authoring.** The MCP *trigger* proves Zod→JSON-Schema works (`McpTrigger.ts:155-163`), but nothing answers "what inputs does `@blokjs/api-call` take?" to an author/AI before they write a step. `listNodes()` (`nodes/listNodes.ts:51`) lists installed nodes with a `schemaMark` (`listNodes.ts:21`) but not the full schema.

**Test harness is unwired from the AI loop.** `WorkflowTestRunner`/`NodeTestHarness` run serverless (`core/runner/src/testing/index.ts`); no CLI/MCP surface invokes them.

**Steering errors are partial.** Some name the fix — ``as` and `spread` are mutually exclusive — pick one.` (`core/workflow-helper/src/types/StepOpts.ts:329`), and Mapper's `guessHint` (`Mapper.ts:139`). But the highest-value one is **generic**: when `$.state.fetch` references a non-existent step, `guessHint` returns "Check the trigger payload (ctx.req.body) or the upstream step's output (ctx.state.<id>)" (`Mapper.ts:150`) — it **never enumerates the actual available step ids**. And the **branch `when` footgun** (dossier risk #5, a live silent-500): `WorkflowNormalizer` validates only that `when` is a non-empty string (`WorkflowNormalizer.ts:450-452`) — a bare `$`/`js/` in `when` passes load-time and 500s at run time.

**Skills exist as one monolithic doc, not invocable per-task units.** `.claude/skills/blok-framework.md` is a single always-on reference guide. There is **no** `blok-create-node`/`blok-create-workflow` Skill with progressive-disclosure frontmatter, bundled templates, and a `validate.sh`. (The draft's "no Skills directory" claim was wrong — the gap is *invocable task Skills*, not the directory.)

## 3. Goals & non-goals

**Goals**
- `blokctl mcp serve` — a control-plane MCP server exposing a **small, consolidated** tool set: discover (search registry + list installed), inspect (node Zod→JSON-Schema, workflow grammar), act (scaffold, install, add-trigger), verify (headless test, check).
- Every MCP tool is a thin call into the **same `blokctl` kernel** the human CLI uses (D7) — they cannot diverge, enforced by a lint rule.
- `blok_test` over `WorkflowTestRunner`/`NodeTestHarness` so the AI verifies before declaring done.
- A **steering-error audit**: every load/run author error names the fix *and enumerates the available alternatives*.
- A small set of invocable Claude Skills (`blok-create-node`, `blok-create-workflow`, `blok-add-trigger`) with progressive-disclosure frontmatter, bundled templates, and `scripts/validate.sh` over the kernel.

**Non-goals**
- Building the registry (S6), node-identity scoping (S2), or the published JSON Schema (S1) — S11 *consumes* them.
- A second/sandboxed expression language (deferred, D5).
- Replacing the data-plane MCP trigger — it stays; S11 adds an orthogonal control-plane server.
- An autonomous agent harness. S11 ships the *tools*; the agent (Claude Code / Cursor / Windsurf) is the caller.

## 4. Options & alternatives

### Option A — Skills-only (no MCP server)
Ship invocable Claude Skills that bundle templates and shell out to `blokctl` via `` !`blokctl nodes list` `` live-context injection (`research-ai-native.md:24`).
- **Pros:** Smallest diff, zero new runtime surface, works in Claude Code today.
- **Cons:** Claude-Code-specific — Cursor/Windsurf/Cline can't use them. No structured `tools/list` discovery. The model can't *query* a node's schema on demand mid-authoring — only a one-shot context dump. No `list_changed` "you just installed a node" signal.
- **Verdict:** strands the multi-client AI-native vision. Rejected as the whole answer.

### Option B — MCP control-plane server only
A standalone `blokctl mcp serve` over MCP (the standard the ecosystem is converging on — `research-ai-native.md:9`).
- **Pros:** Universal — every MCP client benefits. Structured `inputSchema` cuts format errors (`research-ai-native.md:17`). Schema-on-demand: `blok_node_schema` returns the exact Zod→JSON-Schema before the AI writes a step. `list_changed` fits "installed a node → new actions."
- **Cons:** New long-running surface. Install/scaffold = running/writing code → needs `destructiveHint` + a human gate (`research-ai-native.md:34`). Misses the procedural authoring knowledge that doesn't fit a tool call (the footguns).
- **Verdict:** the engine, but incomplete alone.

### Option C — MCP server + Skills, both thin over the `blokctl` kernel *(recommended)*
Option B is the engine; Skills are a thin Claude-Code-native presentation layer over the *same* kernel functions, carrying the procedural "how to author" knowledge (the four reads, persistence knobs, branch `when` footgun) that a stateless tool call can't.
- **Pros:** Covers every MCP client (server) *and* gives Claude Code users the richer guided flow (Skills). One kernel, two thin layers — exactly D7. The steering-error audit benefits both.
- **Cons:** Two surfaces to keep in lockstep — mitigated by the shared-kernel lint rule (neither contains logic).

### Option D — Fold authoring into the existing MCP *trigger*
Reuse `McpTrigger` for control-plane tools too.
- **Verdict:** **Rejected — wrong layer.** The trigger conflates data-plane (runs user workflows, needs the server up) with control-plane (authoring, needs only the kernel + registry, must work pre-deploy). It runs tools through the full runner (`McpTrigger.ts`) — wrong execution model for "scaffold a file."

## 5. Recommendation & rationale

**Option C — MCP control-plane server + invocable Skills, both thin over the `blokctl` kernel.**

**Ponytail lens — does the MCP server need to exist?** Yes. It's the only surface serving the cross-client vision (Cursor/Windsurf can't run Skills), and the schema-first contract is Blok's moat (`research-ai-native.md:40`). **Reuse before build:** the MCP SDK + `zodToJsonSchema` are already deps (`McpTrigger.ts:53-65`); `install()`/`search()`/`listNodes()`/`checkProject()` are already exported plain async functions; `WorkflowTestRunner`/`NodeTestHarness` already run serverless. S11 is a thin server calling existing functions, a Skills folder, and an error-message audit — the laziest path that delivers the vision.

**Honest gap in the "everything's already a plain function" claim:** the **scaffold path is NOT yet a plain function.** `NodeGenerator`/`WorkflowGenerator` export `default class` with a `generateNode`/`generateWorkflow` method (`generate/NodeGenerator.ts:24`, `generate/WorkflowGenerator.ts:20`). To honor D7, S11 must extract a thin `scaffoldNode(opts)`/`scaffoldWorkflow(opts)` function that the CLI action *and* the MCP tool both call — not wrap the class twice. This is the one place S11 writes real kernel code, not just wiring. (`WorkflowGenerator` also pulls in the `ai` SDK / `generateText` — `WorkflowGenerator.ts:3` — so `blok_scaffold_workflow` must support a deterministic template path with no model call, or it nests an LLM inside an LLM. See §7.4.)

Against the alternatives: A strands non-Claude clients and gives no schema-on-demand; B alone misses the footgun knowledge; D is the wrong layer.

**Consistency with D1–D8:**
- **D7 (CLI is the single kernel):** load-bearing. Every MCP tool and Skill script calls the identical exported kernel function. A lint rule forbids `commands/mcp/**` from importing anything but `commands/*` exports + formatters. The scaffold-function extraction above is the concrete D7 action.
- **D1 (JSON IR):** the AI authors/validates the **v2 JSON IR** (`research-ai-native.md:44`); `blok_workflow_schema` returns **S1's published JSON Schema** verbatim. JSON→TS codegen serves humans who want types. JSON/canvas are never the source of truth.
- **D4/D2 (scoped versioned refs):** `blok_install_node` resolves `@scope/node@version` (S2) and the `example` field in `blok_node_schema` pre-fills a version-pinned `use:` ref. `blok_search_nodes` returns scoped names, never bare.
- **D3/D6 (registry + descriptor):** `blok_search_*`/`blok_install_*` hit S6's registry; `blok_add_trigger` drives S7's generalized module-descriptor (same `scaffold/setup/verify/cleanup` path as `blokctl observability add`).
- **D5 (expressions):** the steering-error audit *is* part of the D5 fix surface — unresolved-`$.state.<id>` and the branch `when` footgun must emit available alternatives so the AI self-corrects.

## 6. How it improves Blok

- **AI authors correct steps the first time.** Before writing `inputs: {...}`, the AI calls `blok_node_schema("@blokjs/api-call")` and gets the exact Zod→JSON-Schema + a pre-pinned step example. Format errors drop (`research-ai-native.md:17`).
- **AI installs against reality, not hallucination.** `blok_search_nodes` + `blok_list_installed` compose workflows from *installed*, scoped, version-pinned nodes (D4).
- **Self-correcting loop.** `blok_test` runs `WorkflowTestRunner` headless; the AI verifies before declaring done — turning the existing harness into a feedback signal (`research-ai-native.md:43`).
- **Recovery in one shot, not a loop.** Audited steering messages ("`$.state.fetch` references no step; available ids: `validate`, `save`") let the AI fix immediately.
- **Every MCP client benefits**; Claude Code users get the guided Skills flow on top.
- **Human + AI never diverge** — both drive the same kernel.

## 7. Architecture & design

### 7.1 Control-plane MCP server

New command `packages/cli/src/commands/mcp/serve.ts` → `blokctl mcp serve [--stdio|--http]`. Stdio for local IDE wiring (`{"command":"blokctl","args":["mcp","serve","--stdio"]}` — `research-ai-native.md:11`), the default; HTTP for remote/team. Reuses `@modelcontextprotocol/sdk` (already in tree).

**Tool set (consolidated, namespaced `blok_*` — `research-ai-native.md:15,32`):**

| Tool | Annotation | Calls (kernel fn) | Returns |
|---|---|---|---|
| `blok_search_nodes({query, runtime?})` | read-only | `search()` `search/nodes.ts:33` (→ S6) | scoped names + one-line descriptions (semantic, no UUIDs — `research-ai-native.md:33`) |
| `blok_search_workflows({query})` | read-only | `search/workflow.ts` (→ S6) | template names + summaries |
| `blok_list_installed()` | read-only | `listNodes()` `nodes/listNodes.ts:51` + `.blok/config.json` | installed nodes + enabled triggers |
| `blok_node_schema({ref})` | read-only | local `defineNode` registry → `zodToJsonSchema` | `{input, output}` JSON Schema + pre-pinned example (§7.2) |
| `blok_workflow_schema()` | read-only | S1 published JSON Schema | the v2 IR grammar + persistence-knob constraints |
| `blok_scaffold_node({name, runtime, intent})` | **destructive** | `scaffoldNode()` (new, §5) | created file paths + next steps |
| `blok_scaffold_workflow({name, trigger, steps})` | **destructive** | `scaffoldWorkflow()` (new, §5) | created file path; rejects with steering error if invalid |
| `blok_install_node({ref})` | **destructive** | `install()` `install/node.ts:22` | install result |
| `blok_install_workflow({ref})` | **destructive** | `install/workflow.ts` | install result |
| `blok_add_trigger({kind})` | **destructive** | S7 trigger descriptor (`blokctl trigger add`) | scaffold result |
| `blok_test({target, input})` | read-only | `WorkflowTestRunner`/`NodeTestHarness` | `{success, trace[], errors[]}` |
| `blok_check()` | read-only | `checkProject()` `check/index.ts:13` | pass/fail + fix instructions |

12 tools, never one-per-CLI-flag. Destructive tools carry `annotations: { destructiveHint: true }` so clients gate them behind human confirmation (`research-ai-native.md:34`). Each `inputSchema` is a tight Zod→JSON-Schema; responses cap at ~25k tokens with pagination defaults (`research-ai-native.md:15`). `notifications/tools/list_changed` fires after `blok_install_node`/`blok_add_trigger` so the client re-lists.

**Kernel-sharing rule (D7):** the server file contains *zero* business logic. Each handler is `async (args) => formatForMcp(await install(args))`. Lint rule: `commands/mcp/**` may import only `commands/*` exports + formatters.

### 7.2 `blok_node_schema` — the highest-leverage tool

```jsonc
// blok_node_schema({ ref: "@blokjs/api-call" })
{
  "ref": "@blokjs/api-call@^1.2.0",
  "input":  { "type": "object", "properties": { "url": {"type":"string"}, "method": {"enum":["GET","POST"]} }, "required": ["url"] },
  "output": { "type": "object", "properties": { "data": {} } },
  "example": { "id": "fetch", "use": "@blokjs/api-call@^1.2.0", "inputs": { "url": "https://..." } }
}
```

The `example` is the step shape pre-filled with the scoped, version-pinned `use:` ref (D4) — the AI copies it and fills `inputs`. **This is the single move that makes AI authoring correct-by-construction.**

*Feasibility note:* `blok_node_schema` reads the **local `defineNode` registry** for installed nodes (zero registry dep). For *not-yet-installed* nodes, the schema must come from S6's published manifest (D8: each SDK emits a canonical JSON Schema from its typed input). Until S6 lands, `blok_node_schema` answers for installed nodes only and returns a `not_installed` hint pointing at `blok_search_nodes` — honest degradation, no hand-wave.

### 7.3 Steering-error audit (the recovery surface)

A pass over author-facing load/run errors to guarantee each names the fix **and enumerates alternatives**. Priority order:

1. **Unresolved `$.state.<id>` (the #1 AI footgun).** `Mapper.guessHint` (`Mapper.ts:139`) currently returns a generic string (`Mapper.ts:150`). Augment: when the failing path is `ctx.state.<id>` and `<id>` is not a known step, throw with `available step ids: [validate, save, ...]` from the normalized workflow's step list. **Feasibility:** the Mapper resolves expressions at run time and does not today receive the workflow's step-id set — it only sees the expression string. The audit must thread the available-ids list into the Mapper's error context (via the resolution call site that already carries workflow + step context for `MapperResolutionError` — `Mapper.ts:344`). This is a small plumbing change, not free; call it out so it isn't underestimated.
2. **Branch `when` raw-ctx footgun (D5, dossier risk #5, a live silent-500).** `WorkflowNormalizer` validates only non-empty `when` (`WorkflowNormalizer.ts:450-452`). Add a load-time check rejecting a bare `$`/`js/` in `when`: "branch `when` must be a raw `ctx.*` expression or use `eq/ne/gt` helpers from `@blokjs/helper`; got `$.req.method`". Gate it through `BLOK_MAPPER_MODE` (warn vs. strict, matching existing Mapper semantics) so operators have an escape hatch.
3. **Mutually-exclusive / unknown keys.** Already good (`StepOpts.ts:329`; `.strict()` schemas). Verify each lists the allowed set; no new work expected.
4. **`set_var`.** Already names the fix (load-time throw in `WorkflowNormalizer`). Keep.

Deliverable: a table mapping each error site → message quality (names fix? lists alternatives?) → fix. Mechanism is per-site edits; **no new abstraction.**

### 7.4 Skills (Claude-Code layer)

`.claude/skills/blok-create-workflow/`, `blok-create-node/`, `blok-add-trigger/` — **invocable per-task Skills**, distinct from the existing always-on `blok-framework.md` reference doc (which stays). Each `SKILL.md` frontmatter `description` is the trigger surface (`research-ai-native.md:13`); the body holds procedural authoring rules (the four reads, persistence knobs, branch `when` footgun) — progressive disclosure means zero token cost until invoked. Each bundles `examples/` (canonical templates already in the `create/utils` template set) and `scripts/validate.sh` → `blokctl check` + `blok_test`. Live context via `` !`blokctl nodes list` `` so the AI scaffolds against installed nodes (`research-ai-native.md:24`). `allowed-tools` pre-authorizes `blok_*` tools.

**Scaffold determinism (the LLM-in-LLM trap):** `WorkflowGenerator` calls `generateText` from the `ai` SDK (`WorkflowGenerator.ts:3,67`). `blok_scaffold_workflow` / the Skill MUST default to the **deterministic template path** (no model call) — the caller is already an LLM; nesting a second model is wasteful, non-reproducible, and adds a network dep to scaffolding. `scaffoldWorkflow()` exposes a `mode: "template" | "ai"` flag; MCP/Skills use `template`. The existing `WorkflowValidator` feedback loop (`WorkflowGenerator.ts:78`) is reused only for validation, not generation.

### 7.5 Dir changes

```
packages/cli/src/commands/mcp/
  index.ts          # registers `blokctl mcp serve`
  serve.ts          # BlokMcpServer — thin tool handlers over kernel fns
  tools.ts          # tool defs (name, description, zod inputSchema, annotations)
packages/cli/src/commands/generate/
  scaffold.ts       # NEW: scaffoldNode()/scaffoldWorkflow() plain fns wrapping the
                    #      Generator classes — shared by CLI action + MCP tool (D7)
.claude/skills/
  blok-create-workflow/SKILL.md + examples/ + scripts/validate.sh
  blok-create-node/SKILL.md + examples/
  blok-add-trigger/SKILL.md
core/shared/src/utils/Mapper.ts        # augment guessHint with available-ids (needs id plumbing)
core/runner/src/workflow/WorkflowNormalizer.ts  # branch `when` validation (gated by BLOK_MAPPER_MODE)
```

## 8. Compatibility, migration & risks

**Backward-compat:** Additive across the board — a new command, new invocable Skills (existing `blok-framework.md` untouched), sharpened error messages. Existing `.ts`/JSON workflows and the `$`/`js/` syntax are unchanged (hybrid appetite honored). The data-plane MCP trigger is unchanged.

**One behavior change, gated:** rejecting a bare `$`/`js/` in branch `when` at load time turns a *silent runtime 500* into a *loud load-time error*. Per the standing "framework bug → report" rule this is a fix, not a regression — but it could surface in workflows that currently 500 silently. Gated by `BLOK_MAPPER_MODE`: `warn` (the old log-and-pass) vs. `strict` (the default, throw), matching existing Mapper semantics.

**Migration tooling:** none for the additive surface. The branch-`when` tightening rides existing `blokctl migrate workflows` — add a rule rewriting bare-`$` conditions to `eq/ne` helpers.

**Risks / failure modes:**
- **Schemas fix syntax, not reasoning** (`research-ai-native.md:30`). `blok_node_schema` cuts format errors; the AI can still compose semantically-wrong workflows. Mitigation: `blok_test` in the loop + bundled worked examples in Skills.
- **Tool-list bloat** (`research-ai-native.md:32`). Held to 12 consolidated tools, never one-per-flag.
- **Install = running third-party code.** `destructiveHint` + human gate; relies on S6's checksums/provenance. Until S6, `blok_install_node` rides the existing Deskree path (`install/node.ts`) — authenticated but unsigned. **Flag the trust gap explicitly in the tool description.**
- **Regex-patching `src/Nodes.ts`** (`install/node.ts:117,149`) is brittle; an AI installing many nodes could corrupt it. Pre-existing; S2/S9 replace it with a manifest. **Flag, don't fix here.**
- **Scaffold-path coupling (the one real code risk in S11).** Extracting `scaffoldNode`/`scaffoldWorkflow` from the Generator classes without changing CLI behavior needs the existing generator tests (`NodeGenerator.test.ts`, `WorkflowGenerator.test.ts`, e2e) green throughout. Not a wrap-twice job.

## 9. Phased implementation plan

**M1 — Steering-error audit (ships first, independent, smallest).** No deps. Augment `Mapper.guessHint` with available step ids (incl. the id-plumbing into the error context, §7.3); gate branch-`when` validation behind `BLOK_MAPPER_MODE`; audit-table the rest. Immediate AI *and* human win; fixes a live bug.

**M2 — Read-only inspect core (`blok_node_schema` + `blok_list_installed` + `blok_workflow_schema`).** Stand up `blokctl mcp serve --stdio` with the three inspect tools (no registry dep — reads local `defineNode` registry + `.blok/config.json`; `blok_workflow_schema` can ship a hand-written grammar string until S1's published schema lands). Delivers correct-by-construction authoring alone.

**M3 — Verify loop (`blok_test` + `blok_check`).** Wire `WorkflowTestRunner`/`NodeTestHarness` + `checkProject()`. Completes the self-correcting loop. No external deps.

**M4 — Scaffold (`blok_scaffold_*`).** Extract `scaffoldNode`/`scaffoldWorkflow` (§5, §7.4 deterministic default), wire as destructive tools with dry-run. The one milestone with real kernel code.

**M5 — Distribution (`blok_search_*` + `blok_install_*` + `blok_add_trigger`).** Depends on S6 (registry) + S2 (scoping) + S7 (trigger descriptor). Until those land, rides the existing Deskree/regex path behind a "best-effort, unsigned" flag.

**M6 — Skills.** `.claude/skills/blok-create-*` over the now-stable kernel functions. Last because they're the thinnest layer and benefit from M1–M5 being solid.

**Smallest shippable: M1 + M2** — an AI gets correct schemas and self-correcting errors with zero registry/scoping dependency. That's the "build a backend in a day" core.

## 10. Open questions

1. **Stdio vs HTTP default for `mcp serve`?** Stdio is the dominant local-IDE pattern (`research-ai-native.md:11`); HTTP enables remote/team. *Recommend: stdio-first, HTTP later.*
2. **JSON-first or TS-first AI authoring?** Literature favors JSON for AI (`research-ai-native.md:44`); Blok humans prefer TS. *Recommend: AI emits/validates the JSON IR; `blok_scaffold_workflow` offers JSON→TS codegen.* Confirm default output format.
3. **Does `blok_install_node` wait for S6, or ship on Deskree now?** *Recommend: ship M5 best-effort now, annotate the trust + `Nodes.ts`-regex gaps in the tool description.*
4. **Reuse the data-plane trigger's transport, or stay separate?** *Recommend separate — different execution models; minor dup is cheaper than coupling authoring to the running server.*
5. **Eval suite for the AI loop.** Anthropic's guidance: drive tool design with evals measuring tool-call/error rates (`research-ai-native.md:15`). *Recommend a tiny `WorkflowTestRunner`-backed eval set in M3 — a fixture set, not a framework.*
6. **Where do Skills live for distribution** — in-repo `.claude/skills/` only, or scaffolded into new projects? *Recommend `blokctl create` scaffolds them so non-monorepo Blok projects get them.*
7. **`blok_scaffold_workflow` generation mode** — deterministic template vs. the existing `ai`-SDK `generateText` path (`WorkflowGenerator.ts:67`)? *Recommend deterministic-template default for MCP/Skills (the caller is already an LLM); keep `ai` mode behind an explicit flag.* (§7.4)

---

**Grounding corrections folded in vs. the draft:** (1) generators export `default class`, not plain functions — M4 must extract `scaffoldNode`/`scaffoldWorkflow`, the one place S11 writes real kernel code; (2) `.claude/skills/` already exists (`blok-framework.md`) — the gap is *invocable task Skills*, not the directory; (3) `search/nodes.ts` exports `search()`, the `as/spread` error lives at `StepOpts.ts:329` (not `Examples.ts`); (4) `Mapper.guessHint` doesn't receive step ids today — the available-ids enumeration needs explicit plumbing, not a one-line change; (5) `WorkflowGenerator` embeds the `ai` SDK — flagged the LLM-in-LLM trap and forced a deterministic scaffold default. Recommendation stands: **Option C**, with **M1 (steering-error audit) + M2 (read-only schema tools)** as the smallest shippable slice that delivers "AI builds a backend in a day."
