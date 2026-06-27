# S2 — Node Identity, Scoping & Versioning

## Status — Draft for review · depends on: S1 (Workflow JSON IR + published schema) · feeds: S6 (registry), S9 (multi-runtime distribution), S11 (MCP install) · phase: 1 (foundation)

## 1. Problem & motivation

Blok's vision is an npm-like registry where an AI installs nodes and assembles a backend in a day. That requires one thing the framework does not have: **a stable, versioned, collision-proof way to name a node and pin it from a workflow.**

Today a node's identity is a single free-form string that collapses three distinct concepts: the npm package name, the human-facing node name, and the `use:` reference an author types. There is no version anywhere in that string, no scope guarantee, and no resolution logic. The runner runs "whatever happens to be registered under that key" — a bare `Map.get` (`Configuration.ts:627`).

This blocks the vision concretely:

- **No reproducibility.** A workflow that ran green last month can silently change behaviour on node upgrade — the workflow names the node, never its version.
- **No marketplace safety.** Without mandatory scopes the registry inherits npm's typosquatting hole (`@blokjs/api-call` vs `apicall`). Without versioned identity an AI cannot *trust* an installed node.
- **No independent versioning.** Every node shares the monorepo `package.json` version, so "bump api-call" means "release everything."

Per the dossier this is **D4**, a Phase-1 foundation fork that S6 (registry) and S9 (distribution) depend on. It is breaking-change-by-nature, so it must be gated behind a workflow-schema version with migration tooling — exactly the hybrid appetite the founder set.

**Scope discipline (ponytail):** this spec ships the *identity contract and the local resolver* — nothing more. The lockfile-with-integrity, multi-version coexistence, and the registry are explicitly **deferred** to the specs that make them real (S6/S9). Building them in S2 means writing `integrity: null` and an unused version-index — speculative scaffolding for consumers that don't exist yet. We ship the grammar and the one-chokepoint resolver change; everything downstream targets *that*.

## 2. Current state in Blok

Identity collapses at three layers:

1. **Authoring** — `core/workflow-helper/src/types/StepOpts.ts:210` defines `use` as a plain `z.string().min(1)` with description "Node reference. Examples: `'@blokjs/api-call'`, `'my-custom-node'`." No version grammar, no scope requirement.
2. **Normalization** — `WorkflowNormalizer.normalizeRegularStep` (`core/runner/src/workflow/WorkflowNormalizer.ts:352`) does `const nodeRef = pickString(step.use) ?? pickString(step.node)` and stores it verbatim as `internalStep.node`. `inferStepType` (`:1082`) only inspects a `runtime.` prefix; everything else becomes `type: "module"`. **A version you typed would be swallowed into the lookup key.**
3. **Resolution** — `Configuration.moduleResolver` (`core/runner/src/Configuration.ts:627`) is the whole story: `const nodeHandler = opts?.nodes?.getNode(node.node)` against `NodeMap` (`core/runner/src/NodeMap.ts`), a bare `Map<string, NodeBase>` (verified: 17-line file, `get`/`set` only). No semver parse, no range satisfaction. `if (!nodeHandler) throw new Error(\`Node ${node.node} not found\`)` (`:630`).

Node identity itself: `defineNode({ name })` — the interface field at `defineNode.ts:46`, assigned to the registry key at `:106`. That `name` IS the registry key AND the `use:` string AND, by convention, the package name. `understand-nodes.md:63` confirms "there is NO separate package name ↔ node name mapping." Directory suffixes (`nodes/web/api-call@1.0.0/`) are cosmetic; `package.json` `version` is monorepo-global (`understand-nodes.md:32`).

Install is a **regex patch** of a hand-written file: `packages/cli/src/commands/install/node.ts:updateNodeFile` matches `/const\s+nodes\s*:\s*\{[^}]+\}\s*=\s*\{([\s\S]*?)\n\};/` (`:120`) and splices an entry. The damning line: `const entryKey = importPath.replace(/^@[^/]+\//, "")` (`:127`) — it *strips the scope* to derive the workflow key, so the workflow references the unscoped short name while npm holds the scoped name. **The two identities are already silently diverging, by hand, in a fragile regex.** This is the concrete bug S2 fixes.

There is no schema-version gate: `WorkflowNormalizer.ts:188` reads `version` but treats it as documentation (`typeof wf.version === "string" ? wf.version : "1.0.0"`) — that's the *workflow's* semver, not a *schema* discriminator.

## 3. Goals & non-goals

**Goals (this spec)**
- A canonical node identity grammar: `@scope/name`, scope mandatory under the new schema, decoupled from npm package name (D4).
- Version-pinnable `use:` refs: `@scope/name@^1.2.0` (range) or `@scope/name@1.2.3` (exact); versionless still legal under the old schema.
- A version-*aware* resolution path in `moduleResolver` that satisfies a semver range against the registered node (D3 reuse-npm-shape).
- A workflow-schema-version gate that **opts a file into** the versioned-identity rules, so existing files keep working untouched (hybrid appetite).
- Migration tooling (`blokctl migrate node-refs`) to upgrade in bulk, reusing the existing `blokctl migrate workflows` plumbing.
- **Delete** the scope-stripping `entryKey` divergence in the install path; make the scoped `id` the canonical install key.

**Non-goals (this spec — deferred to named consumers)**
- **The lockfile with integrity hashes — deferred to S6/S9.** A lockfile's only load-bearing field (SRI `integrity`) is meaningless for local/unpublished nodes; it requires the registry. S2 defines the *identity that a lockfile will key on*, not the lockfile. (See §7.4 for the one stub we do ship.)
- **Two-versions-coexist in one process — deferred (probably to S9, possibly never).** This needs the registry AND a multi-version registration path AND a real user pulling two majors at once. None exist today; you *cannot* even register two versions under the current one-file hand-registration. We ship a resolver whose signature *admits* a version index later without re-plumbing — but we do not build the index. (See §7.3.)
- The registry server, packument API, provenance — **S6**.
- Multi-runtime artifact packaging — **S9** (S2 only names the manifest entry).
- A new expression language — **S3**.
- Auto-discovery / `node_modules` scanning — orthogonal; can land independently of S2.

## 4. Options & alternatives

### Option A — Parallel `version` field on the step
`{ id, use: "@blokjs/api-call", version: "^1.2.0" }`; resolution reads `step.version`.
- **Pros:** smallest grammar change; `use` string untouched, no parser.
- **Cons:** version lives *outside* the identity, so the future lockfile, the registry URL, and the `use` ref disagree on what "the thing" is. Copy-pasting a step loses its version. AI learns two fields. Violates D3 (reuse npm's protocol shape).

### Option B — Version inside the ref: `@scope/name@range` (npm/JSR shape)
Version is part of the one identity string, parsed at normalization into `{ scope, name, range }`.
- **Pros:** one canonical identity, matches npm/JSR exactly (D3, D4), copy-paste-safe, the registry URL *is* the parsed ref, AI already knows the shape.
- **Cons:** needs a small parser and a clear "versionless = old schema" rule. The `use` string stops being a literal Map key — `moduleResolver` must parse + range-match.

### Option C — Content-addressed identity (`@scope/name@sha256:…`, Windmill-style)
- **Pros:** maximal reproducibility, tamper-evident.
- **Cons:** unreadable, hostile to authoring and AI prompting, and semver ranges (what authors actually want) sit *on top* anyway. This is what a future **lockfile** carries, never the surface ref. **Reject as surface identity; adopt the hash as the lockfile integrity field in S6** (npm SRI / `dist.integrity`, `research-registry-design.md:32`).

### Option D — Do nothing; document a convention
- **Cons:** convention without enforcement is exactly how the `entryKey` regex-strip already drifted (`node.ts:127`). YAGNI cuts the other way: S6 is a committed roadmap item and *requires* this contract.

## 5. Recommendation & rationale

**Option B for the surface identity (`@scope/name@range`); Option C's hash deferred to S6's lockfile.** This is the npm/JSR shape the dossier committed to in D3/D4 — one canonical string the workflow, the (future) registry URL, the AI prompt, and the (future) lockfile all agree on.

**Ponytail lens — does each piece need to exist, what can we reuse?**
- *Parser:* yes, but it's ~15 lines. The grammar `@scope/name@range` is **semver's own grammar** — split the string, hand the range to `semver`. We do **not** invent a comparator.
- *Reuse `semver`:* it's already present transitively in `node_modules` (verified) but **not a declared direct dependency** — S2 must promote it to a direct dep of `@blokjs/runner`. Honest cost: one `package.json` line, not "free."
- *Resolver change is one chokepoint:* `module:` lookups already funnel through `moduleResolver` (`Configuration.ts:627`). The version logic goes *there, once* — not in every caller. Root-cause fix, smallest diff.
- *Reuse the schema-version idea, not a new field name:* the workflow already carries a `version` (its own semver, `:188`). Don't overload it — add a **distinct `schema` discriminator** (§7.5). Reuse the *migration-tool pattern* (`blokctl migrate workflows`), not a greenfield migrator.
- *Defer hard:* lockfile, multi-version coexistence, registry, manifest — all to the specs that consume them. S2 is the contract + local resolver.

## 6. How it improves Blok

- **AI can trust an install — today, locally.** With `@scope/name@1.2.3` the MCP `install` tool (S11) resolves a deterministic, scope-namespaced identity. Mandatory scopes structurally kill typosquatting (`research-registry-design.md:28`) — an AI installing `@acme/stripe` cannot be fooled by `stripe`. This is true the moment scopes are enforced, *before* the registry ships.
- **Fixes a live divergence bug.** Deleting the `entryKey` scope-strip (`node.ts:127`) means the workflow ref equals the scoped npm name — the two stop drifting by hand.
- **Independent node releases (path opened).** Decoupling node-name from package-name lets one package export several named nodes and lets a node version without a monorepo-wide release. S2 opens the door; S9 walks through it.
- **Copy-paste-safe authoring.** The version travels *in* the step ref, so dragging a step in the canvas (S4) carries its pin.
- **Reproducibility (path opened, not delivered).** Pinned `@x@1.2.3` refs are deterministic against a given registry; the *integrity*-guaranteed lockfile lands in S6. S2 honestly delivers "pinned refs," not "verified reproducibility" — see compat §8.

## 7. Architecture & design

### 7.1 Identity grammar
```
nodeRef    := scopedName ("@" range)?
scopedName := "@" scope "/" name              // scope MANDATORY under schema v2
range      := semver | semver-range | dist-tag    // "1.2.3" | "^1.2.0" | "latest"
```
Examples: `@blokjs/api-call@^1.2.0`, `@acme/stripe@1.0.3`, `@blokjs/respond@latest`. Backward-compat: bare `api-call` and scoped-but-versionless `@blokjs/api-call` remain legal under **schema v1** (§7.5).

**Node-name vs package-name decouple (D4):** `defineNode` gains an optional `id` distinct from the npm package name:
```ts
defineNode({
  id: "@blokjs/api-call",   // canonical workflow identity (scope/name) — NEW, optional
  name: "api-call",          // human label (unchanged meaning)
  version: "1.2.0",          // NEW, optional — defaults to host package.json version
  input, output, execute,
})
```
When `id` is omitted it derives from the host package's `name` (preserving today's behaviour byte-for-byte). `version` defaults to the package's `package.json` version at build time — ending the cosmetic directory-suffix duality (`understand-nodes.md:32`) at zero author cost.

### 7.2 Parsing (one function, normalizer-owned)
Add `parseNodeRef(ref): { scope?, name, range?, raw }` in `WorkflowNormalizer.ts`, called from `normalizeRegularStep` (`:352`). It splits the trailing `@range` — critically, the *leading* `@` is the scope sigil, so it splits on the **last** `@` only when a `/` precedes that `@`. Result lands on `InternalStep` as `{ node: scopedName, nodeRange?: range }` — `node` stays the lookup key for back-compat; `nodeRange` is new and optional. `inferStepType` (`:1082`) is unchanged except it parses the ref first, so `runtime.go:my-node@^1` still classifies as a runtime step.

**Runnable check (ponytail):** `test_parse_node_ref.ts` — `@blokjs/api-call@^1.2.0` → `{scope:"blokjs", name:"api-call", range:"^1.2.0"}`; `api-call` → name only; `@blokjs/api-call` → no range; `runtime.go:x@1` → range split after the `runtime.` classification. One assert-based self-check; it's a parser, so it earns its test.

### 7.3 Version-aware resolution (single-version today; index-ready)
`NodeMap` keeps its `Map<string, NodeBase>` API and gains **one** method:
```ts
// resolve(name, range?) — today: validate the single registered node against the range.
// Tomorrow (S9): back this with a per-name version list. Signature does NOT change.
resolve(name: string, range?: string): NodeBase | undefined
```
Behaviour shipped in S2:
- Look up the single registered node by `name` (today's `getNode`).
- If `range` is set, check `semver.satisfies(node.version ?? "0.0.0", range)`. **Mismatch is a loud error, not a silent pass** — `Node @acme/stripe@^2.0.0 not found: registered version 1.4.1 does not satisfy ^2.0.0`.
- `getNode(name)` stays untouched → every existing caller and versionless workflow runs unchanged.

`moduleResolver` (`Configuration.ts:627`) changes one line:
```ts
const nodeHandler = opts?.nodes?.resolve(node.node, (node as RunnerNode).nodeRange);
if (!nodeHandler) throw new Error(`Node ${node.node}${nodeRange ? `@${nodeRange}` : ""} not found`);
```

**Why no version *index* now (ponytail):** two-versions-coexist needs (a) the registry, (b) a registration path that admits multiple versions, and (c) a user pulling two majors into one process. None exist — the current install path is one hand-edited file with one import per node, so you *physically cannot* register two versions today. Building `Map<name, Map<version, node>>` now is scaffolding for a consumer that arrives in S9. The `resolve(name, range)` signature is deliberately the same one a future index needs, so S9 swaps the body without touching `moduleResolver` or any caller. `// ponytail: single registered version per name; back resolve() with a version list in S9 if two-majors-in-one-process becomes real.`

### 7.4 Pinning artifact — minimal stub, NOT a lockfile
S2 does **not** ship `blok.lock` with integrity. What it ships, only if M3 needs it for deterministic migration, is the smallest possible pin: `blokctl migrate node-refs` rewrites each `use:` to an *exact pinned version it read from the installed package* (`@blokjs/api-call` → `@blokjs/api-call@1.2.4`). That pin lives **in the workflow ref itself** — the single source of truth — so there's no second file to keep in sync and no `integrity: null` placeholder lying about a guarantee we can't make.

The real lockfile (`resolved` + SRI `integrity` + `runtime`, CI `lock --check`, lockfile-precedence in the resolver) is **S6's deliverable**, because integrity is only computable against a registry artifact. S2's contract is: *the identity a lockfile will key on is the parsed `@scope/name@range` ref.* That's the dependency S6 targets. Stating this boundary here prevents S2 from shipping dead scaffolding and prevents S6 from re-litigating the identity grammar.

### 7.5 Workflow-schema versioning (the gate)
Add a **distinct** `schema` discriminator (not the existing `version` at `:188`, which is the workflow's own semver):
```ts
workflow({ name, version: "1.0.0", schema: 2, ... })   // schema:2 opts into mandatory scopes + version-aware resolution
```
- **`schema` absent / `1`:** today's rules, byte-for-byte. Bare names legal. Versionless `use` legal. **Zero existing files break.**
- **`schema: 2`:** scope **mandatory** — the normalizer **throws** at load time on a missing scope: `[blok] step "X": use "api-call" must be scoped (@scope/name) under schema 2 — run \`blokctl migrate node-refs\``. A versionless-but-scoped `use` is **allowed with a warning** recommending a pin (a pin is best-practice, not a safety boundary — scope is the typosquatting defence, version is reproducibility hygiene). `nodeRange`, when present, is enforced by §7.3.

**Resolving the draft's own contradiction:** the gate **throws on missing scope from day one of schema-2** (it's the security boundary and the whole point), and only **warns** on a missing version pin. There is no "warn-only first" phase for scope — a half-enforced scope rule is a scope rule that doesn't defend anything. This mirrors how `BLOK_MAPPER_MODE=strict` became the default: the safety-critical rule fails fast.

**Sequencing gotcha (must surface):** schema-2's throw-on-missing-scope is only mechanically migratable if `defineNode.id` (§7.1) lands **first** and the install path (§7.6) stops stripping scopes. Order is `id` → install-fix → schema-2 enforcement. If schema-2 ships before the install fix, `blokctl install` would write an unscoped key that schema-2 immediately rejects — a self-inflicted break. Encoded in the phase plan (§9): M0 ships `id`+parser, M3 ships install-fix+enforcement together.

### 7.6 File/dir changes
- `core/workflow-helper/src/types/StepOpts.ts:210` — `use` description documents `@scope/name@range`; add optional `schema` to the workflow-level schema.
- `core/runner/src/workflow/WorkflowNormalizer.ts:188,352,1082` — `parseNodeRef`, `nodeRange` on `InternalStep`, the schema-2 scope gate.
- `core/runner/src/NodeMap.ts` — add `resolve(name, range?)` (keep `getNode`).
- `core/runner/src/Configuration.ts:627` — `resolve(node.node, nodeRange)` + range in the not-found message.
- `core/runner/src/defineNode.ts:46,106` — optional `id`/`version`.
- `core/runner/package.json` — promote `semver` to a **declared direct dependency** (it's only transitive today).
- `packages/cli/src/commands/install/node.ts:127` — **delete** the `entryKey` scope-strip; use the scoped `id` as the key. `blokctl migrate node-refs`.

## 8. Compatibility, migration & risks

**Backward-compat stance (hybrid, honest):** default is schema v1 = today's behaviour, byte-for-byte. `getNode(name)` is untouched, so every existing caller and versionless workflow runs unchanged. **Nothing breaks until a file opts into `schema: 2`.** What S2 honestly delivers is *scoped, version-pinned identity* — NOT *verified reproducibility* (that's the SRI lockfile in S6). Don't claim the latter from S2.

**Migration tooling:**
- `blokctl migrate node-refs` — walks `workflows/`, rewrites `use: "@blokjs/api-call"` → `use: "@blokjs/api-call@1.2.4"` from installed versions, bumps the file to `schema: 2`. Built on the existing `blokctl migrate workflows` walker, not a new one.
- Unscoped *local* nodes get a default scope (config-driven, e.g. `@local/`) so schema-2 promotion is mechanical rather than asking the author to invent a scope per node.

**Failure modes & mitigations:**
- *Ref-parsing ambiguity (leading scope `@` vs trailing version `@`):* split on the **last** `@` only when the substring before it contains `/`. Covered by `test_parse_node_ref.ts` (§7.2).
- *Range mismatch passes silently:* eliminated — §7.3 makes a non-satisfying registered version a loud not-found error, not a fall-through.
- *Loose range ships a regression (`understand-nodes.md:114`):* S2 mitigates only partially (migration pins exact). The full guard (lockfile + CI `lock --check`) is **explicitly S6** — flagged, not pretended-solved.
- *Install writes a key schema-2 rejects:* prevented by the M0→M3 ordering in §7.5 (install-fix and enforcement ship together).
- *`semver` was only transitive:* promote to a direct dep (§7.6) — otherwise a consumer dedup could remove it.
- *Core (`@blokjs/runner`/`@blokjs/shared`) still monorepo-versioned (`understand-nodes.md:120`):* out of scope — S9 owns the SDK-version boundary.

## 9. Phased implementation plan

**M0 — parser + decoupled identity (no runtime behaviour change).** `parseNodeRef`, `nodeRange` on `InternalStep`, `defineNode.id`/`version`, `schema` field parsed (not yet enforced). Ships value immediately: the published JSON Schema (S1) can express versioned refs and the docs document the grammar. Self-check: `test_parse_node_ref.ts`.

**M1 — version-aware resolution.** `NodeMap.resolve()` + the one-line `moduleResolver` change + range satisfaction with the now-direct `semver` dep. A pinned `@x@1.2.3` against a mismatched registered version fails loudly. `getNode` back-compat preserved.

**M2 — schema-2 enforcement (warn pin / throw scope) + install fix + migration.** Ship `defineNode.id` as the canonical install key, **delete** the `entryKey` scope-strip (`node.ts:127`), turn on the schema-2 scope gate, ship `blokctl migrate node-refs`. These land together by necessity (§7.5 sequencing).

**Deferred out of S2:** lockfile + integrity + `lock --check` → **S6**; multi-version coexistence index → **S9**; registry resolution of `dist-tags` (`@latest`/`@next`) → **S6** (S2 *parses* them, S6 *resolves* them).

M0–M1 unblock S6 (registry has a target identity) and S9. M2 closes the install-path divergence bug.

## 10. Open questions

1. **`schema` integer vs semver string?** Recommend a small integer (`schema: 2`) — schema evolution is rare and ordered; semver here is overkill. *Confirm.*
2. **Default scope for local/unpublished nodes** — `@local/` vs `@<project-name>/`? Affects how mechanical schema-2 promotion is for hand-written nodes. Recommend `@local/` (project-agnostic, no config read).
3. **`dist-tags` (`@latest`/`@next`):** parse now (M0), resolve-against-registry in S6. They're orthogonal to immutability (`research-registry-design.md:40`) and meaningless without a registry. *Confirm defer-resolution.*
4. **`defineNode.version` default source** — host `package.json` at build time (recommended, kills the cosmetic-directory duality at zero author effort) vs required-explicit. *Confirm default-from-package.json.*
5. **Is two-versions-coexist ever a real requirement, or YAGNI permanently?** S2 ships the resolver signature that admits it but builds the single-version body. If you have a concrete "run api-call@1 and @2 in one process during a cutover" use case, name it and it moves into S9's plan; otherwise it stays a `ponytail:` note. *Your call.*

---

Files grounding the claims (verified this session): `core/runner/src/workflow/WorkflowNormalizer.ts:188,352,1082`; `core/runner/src/Configuration.ts:627,630`; `core/runner/src/NodeMap.ts` (full 17-line file: flat `Map<string,NodeBase>`, `get`/`set` only); `core/runner/src/defineNode.ts:46,106`; `core/workflow-helper/src/types/StepOpts.ts:210`; `packages/cli/src/commands/install/node.ts:120,127` (regex `/const\s+nodes\s*:\s*\{[^}]+\}\s*=\s*\{([\s\S]*?)\n\};/`; scope-strip `importPath.replace(/^@[^/]+\//, "")`); `semver` present transitively in `node_modules` but undeclared as a direct dependency.

**Material changes from the draft** — skipped: the `blok.lock`-with-integrity (deferred to S6, where SRI is computable; S2 would only write `integrity:null`) and the `Map<name,Map<version,node>>` coexistence index (deferred to S9; un-buildable today since registration is one-import-per-node). Resolved the draft's warn-vs-throw self-contradiction (throw on missing scope from day one, warn on missing pin). Surfaced a real sequencing dependency the draft missed: `defineNode.id` + install-fix must precede schema-2 enforcement or `blokctl install` writes a key the gate rejects. Corrected refs: `moduleResolver` is `:627` (not `:626`), install regex includes the `= {([\s\S]*?)\n};` tail; flagged `semver` as undeclared-direct (the draft called it "already-installed," which is only transitively true).
