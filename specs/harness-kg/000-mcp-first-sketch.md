# Harness-KG — MCP-first architecture sketch

## Status — Draft sketch · phase 0 design · validates before any harness fork

## 0. The one-paragraph thesis

Build the differentiator — a knowledge-graph memory layer plus an enforced
"loop engineering" workflow layer — as an **MCP server over Tetrix data,
running inside existing harnesses first** (Claude Code, OpenCode, Cursor).
Prove the delta with a real eval before owning a harness. Fork OpenCode
(MIT, TypeScript/Bun, client/server + TUI + beta desktop) only if and when
the eval shows the layer wins, because full loop control (forced per-turn
context injection, hard workflow gates) genuinely requires harness
ownership — but nothing else does.

Explicitly rejected: "agent never reads files, 100% from the graph." Code
is ground truth; the graph is either **derived** (code index — always
carries staleness provenance, always verifiable against files) or
**authoritative** (knowledge files don't contain — decisions, conventions,
guardrails, run history, memory). The graph is authoritative only in the
second region. This split is the load-bearing design decision.

## 1. What exists to build on (grounded)

| Primitive | Where | Role here |
|---|---|---|
| Data-plane MCP trigger | `triggers/mcp/src/McpTrigger.ts` | serves the KG tools as MCP tools (`serverName: "tetrix-platform"` precedent already in tree) |
| Control-plane MCP concept | `specs/blok-vision/S11-ai-native-mcp-skills.md` | S11's design rules apply verbatim: small consolidated tool set, thin over a kernel, destructive hints, steering errors that enumerate alternatives |
| Eval pipeline shape | `triggers/http/src/nodes/eval/index.ts`, `triggers/http/src/workflows/eval/` | load → retrieve → normalize → score → aggregate; the A/B harness eval reuses this shape |
| Headless test runner | `@blokjs/core/testing` (`runNode`/`runWorkflow`) | eval scoring + gate verification without a server |
| Bulk-data lesson | `specs/blok-vision/adr/0014-runtime-boundary-bulk-data.md` | tetrix-blok #138/#140: never pass full code bodies through workflow state; pass refs/blob handles |
| Input enforcement lesson | `specs/blok-vision/adr/0015-workflow-input-enforcement.md` | malformed MCP args must fail at the boundary, not deep in nodes |
| Tetrix platform | tetrix-blok (external) | symbol index, meili-search, MCP index of repos — the data source. See §8 assumptions |

## 2. The three planes

### 2.1 Knowledge plane — the graph, two truth regions

**Derived region (code index).** Entities: `File`, `Symbol`, `Module`,
`Route`, `Test`. Edges: `defines`, `calls`, `imports`, `tests`,
`references`. Every node/edge carries `{ indexedAtCommit, indexedAt }`.
Never authoritative: answers from this region are *navigation hints* with
`file:line` spans the agent verifies by reading. The server compares
`indexedAtCommit` to the working tree's HEAD + dirty file list on every
query and stamps `stale: true` per hit when they diverge — the tool output
then *tells the agent* to verify with a file read. Incremental re-index
(watcher → changed-files-only, tree-sitter) is a Blok `worker` workflow;
per ADR-0014, the pipeline moves symbol-span refs, not code bodies.

**Authoritative region (what files don't contain).** Entities:
`Decision` (ADR-grade, with status + supersedes edges), `Convention`,
`Guardrail` (machine-checkable where possible — a command or assertion,
not just prose), `Incident`, `TaskRun` (every agent session: task, diff,
outcome, cost), `Observation` (memory), `WorkflowDef` (the org's loop
definition), `Skillpack` (guidelines/templates per task type). Edges:
`supersedes`, `derivedFrom` (provenance to a TaskRun/commit/human),
`contradicts`, `appliesTo` (scopes a convention to paths/langs/repos).

**Memory lifecycle — "never lost" done honestly.** Nothing is deleted;
nothing is silently trusted either. Observations enter as `proposed`,
get promoted to `confirmed` (human ack or repeated independent
observation), and exit via `superseded`/`expired` — always by edge, never
by overwrite. Retrieval ranks by status, recency, scope match, and
provenance strength. A contradiction between two confirmed observations
is surfaced to the human, not auto-resolved. This is the curation layer
that makes "store everything" survivable.

### 2.2 Write plane — what gets captured per agent turn

Phase 0 needs no harness changes: Claude Code hooks (`PostToolUse`,
`Stop`) and the OpenCode plugin API both fire on tool calls and session
end. Hook → `POST` to a Blok `http`-triggered ingest workflow → `worker`
extraction pipeline:

1. **Raw event append** (cheap, lossless): tool call, diff hunks (as blob
   refs), test results, session id → `TaskRun` timeline.
2. **Distillation** (async, batched at session end): an extraction step
   proposes `Observation`s ("`bun run build` required, bare nx breaks
   ESM — see #687", "auth lives in `core/auth`, not `apps/api`") with
   evidence links.
3. **Dedupe/contradiction pass** against existing graph → write as
   `proposed`, or attach `contradicts` edge.
4. Explicit writes: the agent can call `kg_remember` mid-session for
   things it was told or learned; same lifecycle applies.

### 2.3 Control plane — loop engineering

A `WorkflowDef` is a state machine over phases (e.g. `intake → plan →
implement → verify → review → done`), each phase declaring: allowed tool
classes, required context packs (which Skillpacks/Guardrails to inject),
and **gates** — exit criteria with machine-checkable evidence
(`bun run test` output, lint pass, diff-size ceiling, reviewer ack).
Stored in the graph, versioned, per-org/per-repo/per-task-type.

- **Phase 0 (inside foreign harnesses):** *advisory-plus*. `wf_current`
  tells the agent its phase + obligations; `wf_gate` refuses passage
  without evidence; a `PreToolUse` hook can hard-block edit tools while
  the workflow says `plan` (Claude Code hooks can deny tool calls, so
  this is real enforcement for the biggest gates, not just prompting).
- **Phase 2 (own harness):** full enforcement — the loop itself asks the
  workflow engine which tools to expose and injects the phase's context
  pack every turn. This is the *only* capability that requires the fork.

## 3. MCP tool surface (phase 0)

One server, S11 rules (small, consolidated, thin, steering errors
enumerate alternatives, `destructiveHint` on writes). Nine tools:

| Tool | Region | Returns |
|---|---|---|
| `kg_context({task, files?, budget?})` | both | the **session boot pack**: applicable Conventions + Guardrails + top Decisions + Observations scoped to the working set, ranked, hard token budget (default ~4k), each item with provenance |
| `kg_search({query, kind?})` | both | ranked hits; derived hits carry `file:line` + `stale` flag |
| `kg_symbol({ref})` | derived | definition span, signature, direct deps — hints, with staleness stamp |
| `kg_callers({ref})` | derived | call/reference sites as `file:line` spans |
| `kg_decisions({topic})` | auth. | decision log incl. superseded chain |
| `kg_remember({kind, observation, evidence})` | auth. | writes `proposed` Observation (destructive) |
| `wf_current({sessionId})` | control | phase, obligations, allowed tools, required next gate |
| `wf_gate({sessionId, gate, evidence})` | control | pass/fail + exactly what's missing (steering-error style) |
| `kg_feedback({itemId, useful})` | meta | retrieval-quality signal consumed by the eval loop |

Boundary rules: Zod-validated args that fail fast (ADR-0015), responses
capped/paginated, large payloads returned as refs (ADR-0014).

## 4. What Blok is and is not, here

Blok/Tetrix runs the **ingestion pipelines, the indexer worker, the eval
harness, and the MCP data plane** — request/worker-shaped workloads it is
built for. The interactive agent loop (streaming, REPL, permissioning) is
*not* a Blok workflow and should not be forced into one; in phase 2 it
lives in the OpenCode fork, which calls this layer over MCP/HTTP exactly
like foreign harnesses did in phase 0. That symmetry is the point: the
layer never depends on owning the loop.

## 5. The eval — prove it before forking anything

Reuses the eval pipeline shape already in `triggers/http/src/workflows/eval/`.

- **Task suite:** ~20–30 tasks mined from blok/tetrix-blok git history —
  real merged bug fixes (ground truth = the merged diff + its tests) and
  "where/why" questions with known answers. Plus 5 guardrail-violation
  traps (tasks where the tempting fix violates a stored Guardrail, e.g.
  "speed up the build" → bare `nx run-many` is the trap, #687).
- **Arms:** (A) baseline Claude Code headless (`claude -p`, agent SDK);
  (B) same + this MCP server; (C, later) forked harness. Same model,
  same task prompts.
- **Metrics per task:** success (tests pass / answer matches), tokens,
  wall-clock, tool calls, wrong-files-touched, guardrail violations,
  and for arm B: staleness-flag correctness + `kg_feedback` usefulness.
- **Runner:** a Blok workflow per task run (spawn headless agent →
  collect transcript → score with `runWorkflow`-style checks →
  aggregate). Runs are written into the graph as `TaskRun`s — the eval
  dogfoods the write plane.
- **Decision rule (pre-committed):** fork OpenCode only if arm B beats A
  on success rate **or** cuts tokens/wall-clock ≥25% at equal success,
  *and* wins the guardrail traps. If B loses, the fix is in this layer,
  and owning a harness would not have saved it.

## 6. Phasing

- **P0 — Read layer (1–2 weeks of real work):** MCP server with
  `kg_context`, `kg_search`, `kg_symbol`, `kg_callers`, `kg_decisions`
  over existing Tetrix index; staleness contract; seed Conventions/
  Guardrails by hand from `CLAUDE.md`/`AGENTS.md`. Usable in your own
  Claude Code sessions immediately — the "test it for real" milestone.
- **P1 — Write plane + eval:** hooks → ingest → distillation lifecycle;
  `kg_remember`; build the eval suite; run A/B; iterate retrieval until
  the decision rule resolves.
- **P2 — Fork (gated on P1):** fork OpenCode; graph-first turn context
  injection; `WorkflowDef` enforcement wired into tool exposure;
  keep MCP compatibility so the layer still serves foreign harnesses.
- **P3 — Desktop + multi-model:** inherit OpenCode's desktop app and
  provider layer; the KG/workflow layer is already harness-agnostic.

## 7. Risks (named, not hidden)

1. **Stale-index inner loop** — the whole design stands on the staleness
   contract + incremental indexer latency (< a few seconds per edit). If
   Tetrix indexing is batch-only today, P0 ships with `stale` flags doing
   the safety work and the watcher-indexer is the first P1 item.
2. **Memory noise** — store-everything degrades retrieval; the
   proposed/confirmed lifecycle and scope edges are the mitigation, and
   `kg_feedback` + eval metrics are the measurement.
3. **Fork treadmill** — OpenCode moves fast; the fork must stay a thin
   integration layer (context assembly + tool gating), never diverge in
   the commodity parts.
4. **DMCA hygiene** — base only on upstream OpenCode (MIT). Nothing
   derived from de-minified Claude Code sourcemap clones enters the tree.

## 8. Assumptions to verify against Tetrix (no MCP access from this session)

1. What actually stores the graph — Meilisearch is search, not a graph
   store; are relations in Postgres/SQLite, and can `supersedes`/
   `contradicts`/`appliesTo` edges be added cheaply?
2. Symbol index coverage (languages, call-edge fidelity) and whether
   `indexedAtCommit` provenance exists per record today.
3. Incremental indexing: batch or watcher-driven, and current latency.
4. Existing Tetrix MCP tool names/shapes, to avoid a breaking rename.
5. Whether TaskRun-sized payloads fit current message ceilings or need
   the blob-ref path from day one (ADR-0014 says assume blob-ref).
