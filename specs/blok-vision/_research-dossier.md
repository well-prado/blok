I'll synthesize the dossier directly from the briefs provided.

## 1. Current-state summary

**Workflow format** — Canonical artifact is normalized v2 JSON. `.ts` DSL (`workflow()` + `$` proxy) and JSON both compile through `WorkflowNormalizer` into one `InternalWorkflow` shape. v1→v2 bridge is lossless. The format carries **zero visual/UI metadata** (no positions, colors, comments). Seam: `WorkflowNormalizer.normalizeWorkflow()` + `unwrapProxies()`. Constraint: step `id` is the sole flat-namespace identity; ids must be globally unique across all arms.

**Studio** — Read-only trace + analytics viewer. Pipeline `buildWorkflowDag(definition) → dagre layout → xyflow` is cleanly decoupled but ships with `nodesDraggable=false`, `nodesConnectable=false`. No write endpoint, no validation package, no node palette, no property inspector. Seam: `buildWorkflowDag()` accepts mutable `definition: unknown`; positions are ephemeral (dagre-computed). **No hard architectural blocker to editing — gap is API + validation + UX.**

**Node model** — `defineNode({name, input: Zod, output: Zod, execute})` → `FunctionNode`. Identity = `name` field = step `use:` ref = npm package name (all three collapsed). Nodes manually registered in `GlobalOptions.nodes` before boot — no auto-discovery, no version negotiation, monorepo-global versioning (dir `@1.0.0` suffix is cosmetic). Cross-runtime nodes wrap a gRPC `RuntimeAdapter`.

**Runtime SDKs** — 7 sidecar languages over one additive-only gRPC contract (`blok.runtime.v1`). Node = single-language. Discovery is fs-scan (dynamic langs) or codegen shim regenerated every `blokctl dev` (compiled langs). `NodeError` structured contract already uniform across SDKs. No node distribution story, no SDK versioning.

**Expression system** — Dual-phase: definition-time `$` proxy → `js/ctx.…` strings; runtime `Mapper` resolves `${...}` (string-coerced) and `js/...` (type-preserving). `BLOK_MAPPER_MODE=strict` is now default. **Footgun: branch `when` bypasses Mapper (raw ctx eval) and fails silently on bare `$`** — partially fixed via `eq/ne/gt` helpers. Every `replaceString()` recompiles a fresh `Function` (no cache).

**Triggers** — 8 hardwired `TriggerBase` subclasses. HTTP-family share one Hono app via pre-catch-all hook injection. **Not modular**: no descriptor, no registry, no `.blok/config.json` trigger block, no CLI. The observability descriptor pattern is the proven template to mirror.

**CLI + modular** — `blokctl` (commander). **Observability is the reference modular pattern**: `ObservabilityModuleDescriptor` (id, deps, scaffold/setup/verify/cleanup hooks) + hardcoded `REGISTRY` + fenced `.env.local` block + `.blok/config.json` flat map. MCP trigger already exposes workflows as tools. No cycle detection in dep resolver; partial-failure transaction gap between config-write and env-write.

**Distribution** — Centralized authenticated registry (Deskree backend); no offline mode. Nodes are npm-only (`@blokjs/*`), hand-registered in `src/Nodes.ts` via regex-patch. Workflows distributed as JSON via `/publish-workflow`. No node catalog API, no per-node versioning, no lockfile pinning node versions.

## 2. Competitive pattern matrix

| Capability | n8n | Trigger.dev | Windmill | Pipedream/Zapier/Make | **Best idea to adapt** |
|---|---|---|---|---|---|
| **Visual editor** | Canvas IS the JSON; drag-output-opens-contextual-palette; NDV input\|params\|output + run-one-step + pin-data | None (imperative code can't render as graph) | Visual DAG over OpenFlow; per-step test/preview; "connect" picker writes the expr | Make: JSON-config visual builder | **Drag-from-output → contextual filtered palette** (n8n's signature speed win) + **connect-picker that emits valid `$.state.<id>`** (Windmill) — kills the expression footgun |
| **Node packaging** | TS class + `n8n` package.json field, `n8n-nodes-` prefix; verified = no runtime deps | Any npm package (coder-only) | Function signature IS the schema, uniform across langs; content-addressed immutable hash; inline-pinned deps | Pipedream: Node module w/ `key`, semver required | **Signature→JSON-Schema uniformly across all runtimes** (Windmill) + **immutable hash + inline-pinned deps** |
| **Marketplace** | Two registries (templates JSON-site / nodes npm); verified gate = no-runtime-deps + provenance | "any npm package" | Hub: 4 content types, team-approved, Verified badge | Pipedream: **public Git monorepo + PR review**; namespaced `key`; declarative `type:"app"` auth | **Two-registry split + 3 trust tiers (local→community-unverified→verified)**; **declarative managed-connection auth prop** (the missing primitive) |
| **Expressions** | `{{ }}` JS, `$json`/`$('Node')`, live preview + variable picker, **name-keyed (fragile)** | Plain TS | Small named surface (`results.x`, `flow_input`) + connect-picker; QuickJS | — | **Live-preview resolver + variable picker**; keep **id-based refs** (never name-keyed); shrink vocabulary |
| **Format** | JSON, name-keyed connections, per-node `typeVersion` drift | TS functions (no graph) | OpenFlow: published-schema language-neutral JSON; TS+canvas are projections | Make: pure JSON; Pipedream: code | **TS canonical + published JSON IR as compile target** that canvas/registry/AI consume losslessly |
| **AI-native** | None (canvas is truth, not text) | NL→query over runs | AI flow-builder chat; portable typed JSON enables LLM emit/validate | Pipedream Connect MCP (~10k tools) | **Blok MCP server (discover/inspect-schema/scaffold/install)** + **steering error messages** + WorkflowTestRunner as `blok_test` tool |
| **Modular triggers** | Triggers = just node types | Webhooks "planned" (gap) | Kafka/NATS triggers Enterprise-gated (wrong move) | — | **`blokctl trigger add/remove`** mirroring observability descriptor — already beyond all competitors; keep common triggers free |
| **Durable exec** | Fails completely, retry from start | CRIU checkpoint-resume; replay-with-edited-payload | — | Inngest: step-memoization by id | **One-click replay-with-edited-payload** (Trigger.dev) + **trace-first run inspector with waterfall** — both sit on existing trace infra |

## 3. Cross-cutting architectural decisions

These are the load-bearing forks. Everything downstream depends on them.

**D1. Workflow source-of-truth format.**
Options: (a) TS canonical, (b) JSON canonical, (c) visual canonical, (d) TS canonical + published JSON IR as compile target.
→ **Recommend (d).** TS stays source-of-truth for humans (types, diffs, PR, npm); promote the existing v2 JSON to a **first-class JSON IR with a published JSON Schema**. Canvas and registry and AI all consume the IR; never make JSON or canvas the truth (round-trip-drift literature is unanimous). Blok already has the JSON mirror — this is formalization, not new architecture.
**Unblocks:** visual editing, AI authoring (constrained decoding), marketplace, validation package.

**D2. Canvas round-trip model.**
Options: (a) persist absolute x/y per step, (b) ephemeral dagre re-layout every load, (c) companion `.blok-canvas.json`.
→ **Recommend (b) for MVP, optional (a) later.** Treat positions as ephemeral UI state (n8n persists, but dagre auto-layout is simpler and Blok's DAG is already deterministic). Add optional per-step `ui: { x?, y? }` that the normalizer passes through unchanged (runtime already ignores unknown fields). **No breaking change.**
**Unblocks:** Studio editing without polluting the format or fighting merge conflicts early.

**D3. Is a node an npm package or a new artifact?**
Options: (a) pure npm, (b) brand-new registry/artifact, (c) **npm-protocol-compatible Blok registry, federate to npm for the JS path**.
→ **Recommend (c).** A Node/TS node CAN be a real npm package today (scope+semver+provenance+SRI all work). But multi-runtime (Go binary, Python wheel) won't host cleanly on npm. Build a **thin JSR-architected registry** (small stateless API + Postgres metadata + CDN object storage, custom code off hot path) with a **multi-runtime manifest** declaring which runtime(s) a logical version targets. Reuse npm's *protocol shape* (packument `GET /{scope}/{name}`, SRI integrity, Sigstore keyless provenance, semver) so tooling/AI mental models transfer.
**Unblocks:** marketplace, AI install via MCP, per-node versioning, cross-runtime distribution.

**D4. Node identity decoupling.**
Today package-name = node-name = `use:` ref. → **Recommend: decouple node name from npm package name; add mandatory scopes** (`@scope/node@version`, JSR-style — structurally kills typosquatting) and **version-pinned `use:` refs** in workflows (`use: "@blok/api-call@^1.2.0"`). Semver the workflow schema (v1 versionless `use`, v2 versioned).
**Unblocks:** independent per-node versioning, reproducible workflows, two-coexisting-versions.

**D5. Expression language strategy.**
Options: (a) keep `$`/`js/` as-is, (b) replace with CEL/JSONata, (c) **two-tier: typed `$`-proxy TS as power tier + a safe constrained tier for predicates**.
→ **Recommend (c), pragmatically.** The `$` proxy already beats raw `{{ }}` for typo-safety. The real wins are cheap: (1) **fix branch `when`** to route through Mapper or statically forbid bare `$`; (2) add the **connect-picker + live-preview** in Studio (biggest ergonomics lever, sits on trace data); (3) **LRU-cache compiled `Function`s** (forEach 1000× recompile is real). Evaluate CEL **only** as a sandboxable predicate language *if/when* marketplace runs untrusted downloaded expressions — defer until the marketplace is real. Don't ship two languages speculatively.
**Unblocks:** authoring ergonomics, the marketplace sandbox story (later).

**D6. Modular-everything descriptor pattern.**
→ **Recommend: generalize the `ObservabilityModuleDescriptor` into one shared module-descriptor contract** (id, deps, scaffold/setup/verify/cleanup) and reuse it verbatim for triggers, then nodes, then runtimes. Add **cycle detection** to `resolveWithDependencies()` (currently infinite-loops) and **fix the config-write/env-write transaction gap** (env-first-then-config, or wrap both). One pattern, four consumers.
**Unblocks:** modular triggers, modular runtimes, create-time picker, consistent CLI.

**D7. CLI as the single kernel.**
→ **Recommend: `blokctl` is the engine; MCP tools and Skills are thin presentation layers over identical code paths.** Already the observability pattern. AI-via-MCP and human-via-CLI must never diverge.
**Unblocks:** AI-native vision, MCP install, Skills.

**D8. Multi-runtime node packaging reality.**
→ **Recommend: accept the split — a "multi-runtime node" is N single-language implementations under one marketplace/manifest entry**, not one binary that runs everywhere (WASM is a nightmare, network-microservice defeats native runtimes). Each SDK emits a canonical JSON Schema from its typed input so the manifest is uniform. Lean into multi-runtime as the **sandboxing differentiator** n8n lacks (untrusted nodes run in constrained runtimes, not host process).
**Unblocks:** honest marketplace scope, the security story.

## 4. Proposed SPEC SUITE

Sequenced; dependencies noted. ~11 specs.

| # | Spec | One-line scope | Depends on | Phase |
|---|---|---|---|---|
| **S1** | **Workflow JSON IR + published schema** | Promote v2 JSON to canonical IR with published JSON Schema; optional pass-through `ui` metadata; TS/canvas/registry as lossless projections | — | 1 (foundation) |
| **S2** | **Node identity, scoping & versioning** | Decouple node-name from package-name; mandatory scopes; version-pinned `use:` refs; workflow-schema versioning | S1 | 1 (foundation) |
| **S3** | **Expression ergonomics & fixes** | Fix branch `when` footgun; LRU-cache compiled fns; formalize the small expression surface; spec `${}` vs `js/` | — | 1 (independent, ships fast) |
| **S4** | **Studio visual editing** | Write endpoint (`PUT …/definition` + dryRun); validation package; node palette; property inspector; drag/connect; ephemeral positions; undo/redo store | S1 | 2 |
| **S5** | **Studio editing UX: connect-picker + live-preview + run-one-step + replay** | n8n/Windmill/Trigger.dev authoring wins on existing trace infra | S4, S3 | 2 |
| **S6** | **Registry architecture** | JSR-architected, npm-protocol-compatible registry; mandatory scopes; immutable+yank; Sigstore provenance; server-side publish gate (schema+secret validation, zero install scripts); multi-runtime manifest | S2 | 2 (foundation for marketplace) |
| **S7** | **Modular-module descriptor (generalized)** | Extract shared descriptor contract from observability; cycle detection; transaction fix | — | 1 (foundation) |
| **S8** | **Modular triggers** | `blokctl trigger add/remove/list`; trigger descriptors; `.blok/config.json` trigger block; bootstrap-HTTP problem | S7 | 2 |
| **S9** | **Node packaging & multi-runtime distribution** | Per-node packages; signature→JSON-Schema per SDK; immutable hash + inline-pinned deps; `blokctl node install --runtime`; accept N-impls-one-entry split | S2, S6 | 3 |
| **S10** | **Managed connections / auth primitive** | Declarative `type:"app"` connection prop; secret injection; the marketplace-unlock primitive Blok lacks | S6 | 3 |
| **S11** | **AI-native surface (MCP + Skills)** | Blok MCP server (search/inspect-schema/scaffold/install/test); steering error-message audit; Skills over `blokctl`; WorkflowTestRunner as `blok_test` | S2, S6, S7 | 3 |
| **S12** *(optional)* | **Marketplace trust, verification & licensing** | 3 trust tiers; verified = CI-passes + no-runtime-deps + provenance; pick license once (the n8n/Windmill relicensing lesson); deprecation/ownership-transfer | S6 | 3 |

**Sequence rationale:** S1/S2/S3/S7 are the foundation forks (do first, mostly parallel). S3 ships independently and fast (real bug fixes). Phase 2 (S4/S5/S6/S8) builds Studio + registry + triggers on the foundation. Phase 3 (S9/S10/S11/S12) is the full marketplace + AI + distribution story.

## 5. Biggest risks & open questions for the user

1. **Marketplace is the long pole and depends on a backend you don't fully own** (Deskree registry, no offline mode, Workday acquired Pipedream — registry-openness precedents are shifting). Decision needed: build the JSR-architected registry in-house (S6) vs. extend the existing backend. This gates S9/S10/S11.

2. **License must be chosen once, deliberately, up front.** Both n8n and Windmill poisoned community trust by relicensing / paywalling core. If you want community contributions to the registry, decide the open/closed boundary NOW — and don't paywall load-bearing reliability (alerting, observability you just shipped, private registries). Open question: what's the commercial model, and does it conflict with community contribution?

3. **Multi-runtime node packaging has no clean answer.** The honest version (N single-language impls under one manifest entry) is achievable; "write once, run on any runtime" is not (WASM nightmare). Confirm you accept the split — it reframes Vision #4 from "one node, all runtimes" to "one marketplace entry, N implementations."

4. **Node identity decoupling (S2) is a breaking change.** Version-pinned scoped `use:` refs break every existing versionless workflow unless gated behind schema version. Migration tooling (`blokctl pin-node-versions`) required. Confirm appetite.

5. **Branch `when` footgun is a live bug, not just ergonomics** — it 500s silently and typecheck/WorkflowTestRunner both miss it. Per your standing rule, flagging: this should ship in S3 ahead of the visual work, since the canvas connect-picker will generate these conditions en masse.

6. **Studio editing's hardest sub-problem is step-id rename propagation** (subworkflow targets, `$.state.<id>` refs all break). Needs a lint/find-replace pass in S4. Open question: do you want concurrent-edit locking (post-MVP) or accept last-write-wins?

7. **Expression language: resist over-building.** The lazy path (fix branch `when`, cache compiled fns, add picker+preview) covers ~90% of Vision #7. CEL/JSONata are speculative until the marketplace needs sandboxed untrusted expressions. Confirm you're OK deferring a second expression language rather than designing it now.

8. **`typeVersion`-style drift is the marketplace's silent killer** (n8n's worst rot). Your normalizer is better-positioned, but node-version migration shims need designing into S6/S9 from day one, not bolted on.

→ skipped: nothing — full dossier per requested 5 sections. The one judgment call worth your sign-off is **D8 (accept the multi-runtime split)** and **risk #2 (license now)** — both reframe scope before any spec is written.