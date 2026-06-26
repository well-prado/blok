# S6 — The Blok Registry: Architecture

## Status — Draft for review · depends on: S2 (node identity, scoping, versioning), S1 (workflow JSON IR) · feeds: S9 (multi-runtime packaging), S10 (managed connections), S11 (MCP), S12 (trust tiers, secret-scan, licensing) · phase: 2

## 1. Problem & motivation

Blok's vision is "npm for backends" — an AI assembles a complex backend in a day by installing nodes and workflows over MCP + CLI. That vision is gated on one piece of infrastructure that does not yet exist: **a registry Blok controls, that an AI and a human can trust to resolve, integrity-check, and provenance a node or workflow before installing it.**

Today distribution is a thin authenticated proxy over a third-party backend (Deskree). It works for the founder's private nodes, but it cannot host the marketplace the vision requires. Concretely it is missing: per-node versioning (everything is monorepo-global — `INSTALL_NODE` is literally `npm install ${node}` with no pin, `package-manager.ts:70`), mandatory scopes (typosquatting is structurally possible), immutability (an author can republish bytes under an existing version), provenance ("built from commit X of repo Y"), a server-side publish gate (a published node can carry arbitrary install scripts), a multi-runtime manifest (a node is npm-or-nothing — Go/Python/Rust nodes have **no distribution path at all**), and any offline/self-host story (a Deskree outage blocks every `blokctl install`).

This matters because the registry is the **trust boundary an autonomous AI crosses**. When an agent runs `blokctl install @acme/stripe-charge@^2.0.0` with no human in the loop, the registry's publish gate + provenance + integrity hash are the *only* things between "the AI wired up Stripe" and "the AI installed a credential exfiltrator that typosquatted `@acme/stripe-charge`." npm's reactive-only posture (most compromises caught hours after publish, install scripts auto-executing on `npm install`) is exactly the failure mode an AI-native registry cannot inherit.

## 2. Current state in Blok

The entire distribution path is a CLI-over-HTTP shim against a hardcoded backend:

- **One hardcoded endpoint host.** `packages/cli/src/services/constants.ts` pins `BLOK_URL` to a Deskree host. No config override, no offline fallback.
- **Token brokering, not a registry.** `packages/cli/src/services/registry-manager.ts:19` hits `/repository-token` for `{ url, namespace, token }`, then install/publish write a temporary `.npmrc` and shell out to `npm`. The "Blok registry" is a per-tenant npm registry URL the backend hands you — `RegistryManager.registry` defaults to `https://registry.npmjs.org/` (`registry-manager.ts:7`).
- **Node install = npm install + regex-patch a file.** `install/node.ts` runs `npm install @{namespace}/{node}` with **no version pin** (`INSTALL_NODE`, `package-manager.ts:70`), then regex-edits `src/Nodes.ts` to add an `import` + `new Node()` entry. Brittle (`updateNodeFile` breaks on non-standard formatting), unversioned, side-effect-registration-based.
- **Publish = monorepo-global version bump + npm publish.** `publish/node.ts` bumps `package.json`, rewrites the name to `@{namespace}/...`, `npm publish`es. No schema validation, no provenance, no immutability check, no manifest — npm-only (the Python branch is commented out, `publish/node.ts:18`).
- **Workflows are a separate ad-hoc store.** `publish/workflow.ts` POSTs raw JSON to `/publish-workflow`; `install/workflow.ts` GETs `/published-workflow-by-id/{id}`. No versioning, no scopes, no node-dependency resolution.
- **Search is one sparse endpoint.** `search/nodes.ts:20` hits `/package-list?searchTerm=X&format=npm` → `{ package, format, namespace }`. No schema, no description, no version list.

Two existing assets this spec leans on:

1. **Every node already emits a canonical JSON Schema.** `core/runner/src/defineNode.ts:2` imports `zodToJsonSchema`; `templates/node/config.json` already carries `input`/`output` as JSON Schema. The contract an AI needs to wire inputs is *already computable from the node* — the registry just stores and serves it.
2. **The descriptor pattern is proven.** `packages/cli/src/commands/observability/descriptor.ts` is a clean `id/dependencies/scaffold/setup/verify/cleanup` contract with transitive dep resolution (`resolveWithDependencies`, line 285). Per D6/S7, this generalizes; "install a node and wire it" is structurally the same lifecycle.

## 3. Goals & non-goals

**Goals**
- A registry **Blok owns**: a publish-time API + metadata + CDN object store, with custom code off the read hot path.
- **npm-protocol-compatible read API** — packument-shaped `GET /{scope}/{name}` so existing tooling and AI mental models transfer for free.
- **Mandatory scopes** (`@scope/name@version`), **immutable versions + yank** (never hard-delete, never reuse a version), **Sigstore keyless provenance**, **SRI integrity hashes Blok computes over the bytes it serves**.
- A **server-side publish gate**: the node's JSON Schema parses, the `defineNode` contract is met, declared runtime(s) match the artifacts, **zero install scripts**. Reject before public.
- A **multi-runtime manifest**: one logical version `@acme/stripe@1.2.0` carries a Node artifact *and* a Go binary *and* a Python wheel (D8 — N implementations, one entry; **S9 fills this shape**).
- Nodes **and** workflows as first-class artifacts.
- An **offline / self-host story** and a configurable registry URL, killing the single point of failure.

**Non-goals (this spec)**
- Marketplace website UX, trust tiers, secret-scanning, licensing (→ **S12**). This spec ships only the two non-negotiable, cheap controls (immutability + zero-install-scripts); deeper malware detection is S12's hardening.
- Managed connections / auth prop (→ S10).
- Per-SDK schema-emission mechanics + `blokctl node install --runtime` UX (→ S9 — this spec defines the *manifest shape* S9 fills, nothing more).
- MCP tool surface (→ S11 — this spec exposes the read API S11 wraps).
- The version-pinned `use:` ref **syntax** and the `pin-node-versions` migration tool (→ S2). This spec **consumes** pinned refs; S2 defines them.
- Rebuilding semver, SRI, or signing — reuse npm-the-protocol + Sigstore.

## 4. Options & alternatives

### Option A — Stay on Deskree, extend the existing backend
Ask Deskree to add versioning/scopes/provenance endpoints.
**Pros:** least code now; reuses login/token plumbing.
**Cons:** the trust boundary lives in a vendor you don't fully control; no credible path to provenance, immutability, or multi-runtime (npm can't host a Go binary cleanly — `understand-distribution.md:122`); no offline mode; the marketplace's security properties are outsourced. **The status quo's structural dead-end** (dossier risk #1).

### Option B — Pure npm + JSR (publish everything to public registries)
Make a Blok node a real npm package and lean entirely on npm/JSR.
**Pros:** zero registry infra; npm has Sigstore provenance GA; AI already "knows" npm.
**Cons:** **multi-runtime is unhostable** — npm won't resolve a Go binary or Python wheel under one logical version (D8). No home for the Blok manifest (which runtimes a version targets, the cross-runtime contract). npm's publish gate is generic and reactive, not `defineNode`-aware, and **npm executes install scripts** — the one thing an AI-native registry must forbid. Workflows aren't npm packages. Strands the multi-runtime differentiator.

### Option C — Greenfield bespoke registry (own protocol, own client)
**Pros:** maximal control.
**Cons:** reinvents semver resolution, SRI, signing, transparency logging — all solved. AI mental models *don't* transfer (the agent must learn a bespoke protocol). Maximal surface to get wrong on the exact path that must be airtight. Over-build — violates the ponytail ladder (reuse the protocol shape before inventing one).

### Option D — JSR-architected, npm-protocol-compatible Blok registry, pointing at npm for the JS path *(recommended)*
A publish-time API + metadata store + CDN-fronted object storage. **Reuse npm's protocol shape** (packument `GET /{scope}/{name}`, SRI `dist.integrity`, semver, dist-tags-as-channels) and **the security machinery** (Sigstore Fulcio→Rekor keyless provenance). Add only what npm can't express: the **multi-runtime manifest** and the **`defineNode`-aware publish gate**. For the Node-runtime artifact, **mirror the tarball into Blok's own object store and serve it with a Blok-computed integrity hash** — Blok owns the bytes it installs end-to-end (see §7.7 on why "federate to npm" had to become "mirror, don't federate").
**Pros/cons:** see §5.

## 5. Recommendation & rationale

**Adopt Option D.** It is the only option satisfying the multi-runtime requirement (D8) and the autonomous-AI trust boundary while obeying the ponytail ladder — *reuse the protocol, build only the delta*.

Ponytail, rung by rung:
- **Does this need to exist?** Yes — the marketplace and AI-install vision have no foundation without it, and Option A's vendor dependency is a structural dead-end (the founder doesn't own the trust boundary).
- **Reuse before build.** The whole design is reuse: npm packument shape, npm semver, Sigstore provenance, JSR's off-the-hot-path architecture, and Blok's *own* `zodToJsonSchema` + observability descriptor (S7). The genuinely new code is small: the multi-runtime manifest schema, the publish gate, the resolver client, the lockfile.
- **Cut the read-path DB (the one real simplification over the draft).** A packument is *a file*. The read path doesn't need a live SQL query per resolve — render each scope's packument to static JSON on publish and serve it straight from the CDN. The metadata store (Postgres or even SQLite to start) exists **only** for publish-time concerns: scope ownership, immutability checks, the transparency/provenance ledger. This means **the read API has no compute and no DB on the hot path** — it *is* the CDN. (§7.1.)

Consistency with cross-cutting decisions:
- **D3** — this is D3 verbatim: thin JSR-architected, npm-protocol-compatible, multi-runtime manifest. (The one deviation: "federate to npm" → "mirror from npm" — see §7.7. Same user-facing outcome; honest about integrity.)
- **D4 / S2** — the registry *enforces* mandatory scopes + immutability; **S2 owns** the `use: "@blok/api-call@^1.2.0"` ref syntax and migration. Clean seam.
- **D8 / S9** — the manifest models "N single-language implementations under one entry," not one binary. S9 fills per-runtime artifacts; S6 defines the slot.
- **D6 / S7** — the install lifecycle reuses the generalized module-descriptor (`scaffold`/`setup`/`verify`) so "install a node" and "add a trigger/observability module" are one code path. The `updateNodes.ts` regex-patch (`install/node.ts`) is replaced by the descriptor's `setup` hook.
- **D7** — the read API is the single kernel; MCP (S11) and Studio's palette (S4) are thin layers over it.
- **Hybrid appetite** — additive. v1 versionless `use:` refs keep resolving (registry serves the `latest` dist-tag); v2 version-pinned refs are the opt-in (S2).

## 6. How it improves Blok

- **AI can install autonomously and safely.** The packument read API doubles as the MCP surface: `search → resolve(scope/name, range) → get-contract(node) → provenance(node)`. The agent reads the JSON Schema to wire inputs, checks provenance + integrity, installs — the publish gate (zero install scripts + immutability) is what lets it trust an unknown node enough to do this unattended.
- **Reproducible workflows.** Version-pinned scoped refs + `blok.lock` with integrity hashes mean a workflow that ran today runs identically next year. Today `npm install ${node}` floats to whatever `latest` is.
- **Multi-runtime distribution finally exists.** A Go or Python node gets a real home: one marketplace entry, per-runtime artifacts, uniform metadata — the differentiator npm/n8n can't match.
- **No more single point of failure.** Configurable registry URL + offline cache means a vendor outage doesn't brick `blokctl`.
- **Typosquatting is structurally dead.** Mandatory scopes + no name-reclaim (immutability) close npm's dependency-confusion hole.
- **Self-hostable** — enterprises run a private Blok registry as a config line, not a fork (Windmill private-hub lesson: don't paywall it).

## 7. Architecture & design

### 7.1 Service shape (read path = CDN; compute only on publish)
```
 RESOLVE (hot path, no compute, no DB):
   blokctl ──HTTPS──> CDN ──> static packument JSON  +  artifacts (tarball/binary/wheel)

 PUBLISH (cold path, gated):
   blokctl ──PUT──> [publish API] ──> metadata store (scopes, immutability ledger, provenance)
                          │
                          └─ renders packument JSON ──> object store (S3/GCS) behind CDN
```
The publish API validates (§7.4), writes metadata, mirrors artifacts to the object store, and **re-renders the affected scope's packument as a static file**. Resolve never touches the API or the DB — only if the CDN goes down does resolve go down.

Metadata store: start with SQLite-on-the-publish-host or managed Postgres — it's small (scope ownership rows, one row per published version, provenance refs). It is **not** in the resolve path, so its scale ceiling is publish QPS, which is tiny. *(ponytail: SQLite to start; Postgres when concurrent publishers warrant it. The read path's scale is the CDN's problem, already solved.)*

### 7.2 Read API (npm-packument-compatible, static where possible)
```
GET /{scope}/{name}                    → packument (static JSON): all versions, dist-tags, time, manifests
GET /{scope}/{name}/{version}          → one version manifest (multi-runtime artifacts + integrity)
GET /{scope}/{name}/{version}/contract → the node's JSON Schema input/output (AI wiring)
GET /-/search?text=stripe&runtime=go   → search (the one read endpoint that needs an index, not static)
PUT /{scope}/{name}                    → publish (gated, §7.4)
POST /-/package/{scope}/{name}/yank    → yank a version (hidden, still resolvable by existing dependents)
PUT /-/dist-tags/{scope}/{name}/{tag}  → move a release channel (latest/next/beta)
```
Everything except `/-/search` and the mutating endpoints is a static file. `/contract` is just a slice of the manifest, served pre-rendered.

### 7.3 Multi-runtime version manifest (the one genuinely new shape)
```jsonc
{
  "name": "@acme/stripe-charge",
  "version": "1.2.0",
  "nodeName": "stripe-charge",            // D4: decoupled from package name
  "description": "Charge a card via Stripe",
  "category": "payments",
  "contract": {                          // canonical JSON Schema, emitted by each SDK (S9)
    "input":  { "$schema": "...", "type": "object", "properties": { /* zodToJsonSchema */ } },
    "output": { "$schema": "...", "type": "object" }
  },
  "runtimes": {                          // D8: N impls, one entry. S9 produces these artifacts.
    "node":    { "tarball": "https://cdn.blok.../node-1.2.0.tgz", "integrity": "sha512-…" },
    "python3": { "wheel":   "https://cdn.blok.../stripe-1.2.0.whl","integrity": "sha512-…" },
    "go":      { "binary":  "https://cdn.blok.../linux-amd64",     "integrity": "sha512-…" }
  },
  "dependencies": { "@blok/api-call": "^1.0.0" },  // node→node deps (transitive, lockfile-pinned)
  "provenance": { "rekorLogIndex": 123456, "sourceRepo": "github.com/acme/...", "commit": "abc123" }
}
```
- `contract` is identical across runtimes (each SDK emits the same JSON Schema — S9's job, D8).
- Every `integrity` is **computed by Blok over the exact bytes in Blok's object store** — including the Node tarball (§7.7). There is no "npm field" pointing off to a registry whose bytes Blok can't hash.
- A **workflow** artifact is the same shape minus `runtimes`/`contract`, with the v2 JSON IR (S1) as the payload and a `dependencies` map of node refs resolved transitively on install.

### 7.4 Publish gate (server-side, reject-before-public)
On `PUT`, the API validates synchronously and rejects on any failure. Scoped to the two controls that are **cheap, non-negotiable, and not security theater**; everything heavier is S12:
1. **Scope ownership** — publisher owns the scope (S2/D4).
2. **Immutability** — `(scope, name, version)` must not already exist. No byte-reuse, no version reclaim.
3. **Contract parses** — the input/output JSON Schema is valid; `nodeName`/`description`/`category` present.
4. **Runtime↔artifact match** — every declared runtime has an artifact whose Blok-computed integrity verifies; no declared-but-missing runtime.
5. **Zero install scripts** — reject any artifact carrying `scripts.{pre,post}install`/`prepare` (Node tarball) or equivalent runtime-hook in a wheel. **A node is data, not an install script.** This is the single most load-bearing control: it neutralizes npm's #1 malware vector even before provenance exists.
6. **Provenance (when present)** — accept the Sigstore SLSA statement from CI's OIDC token (Fulcio→Rekor); store the Rekor log index. Prefer token-less OIDC publish over long-lived PATs (VS Code leaked-PAT lesson). Provenance is **recorded, not required** at community tier (S12 gates trust on it; volume is gated on nothing but 1–5).

> **Explicitly deferred to S12:** secret-scanning the artifact. Building regex credential rules here is speculative security theater — it produces false confidence (necessary-not-sufficient) and false negatives, and the zero-install-scripts rule already means a leaked secret in a published artifact can't *auto-execute* on install. S12 owns real scanning as a hardening pass; S6 does not pretend to.

### 7.5 CLI / file changes
- `constants.ts` — `BLOK_URL` → resolved from (`--registry` flag › `~/.blok/config` › env › default). Offline cache under `~/.blok/cache/`.
- `registry-manager.ts` — gains `resolve(ref, range)`, `getManifest`, `verifyIntegrity`. **Stop defaulting `registry` to `registry.npmjs.org`** (`registry-manager.ts:7`) — the default is the Blok registry.
- `install/node.ts` — resolve version-pinned scoped ref → pick runtime-matched artifact → fetch from Blok CDN → verify Blok integrity → hand to the S7 descriptor's `setup` hook for registration. **Delete the `updateNodeFile` regex-patch** — registration is the descriptor's job (D6/S7), not a regex over `src/Nodes.ts`.
- **`blok.lock`** (new, owned here) — pins `(ref, resolvedVersion, integrity)` per installed node + workflow. Reproducible, tamper-evident. The **ref syntax** it pins is S2's; the **lockfile format + verify-on-install** is S6's.
- `publish/node.ts` — emit the multi-runtime manifest + provenance instead of a bare `npm publish`; the non-npm runtime branch (`publish/node.ts:18`) is now modeled by the manifest (artifacts produced by S9).
- `package-manager.ts:70` — `INSTALL_NODE` no longer shells `npm install ${node}`; resolution + fetch + verify move into the resolver. The `.npmrc`/`npm publish` plumbing is retired for the Blok path.

### 7.6 Offline / self-host
- **Read-through cache** keyed by integrity hash under `~/.blok/cache/`. `blokctl install` works offline for anything already cached. Because integrity is content-addressed, the cache is also the tamper check.
- **Self-host**: the same publish-API image + a metadata store + an S3-compatible bucket + any CDN/static host. Configurable base URL means a private registry is a config line, not a fork (Windmill lesson — don't paywall it).

### 7.7 Why "mirror from npm," not "federate to npm" (correctness fix vs. D3 wording)
The draft claimed the manifest's `node.integrity` "must match the npm tarball's." **It cannot.** npm rewrites tarballs on publish (injects `_integrity`/`_from`, may repack), so a Blok-computed hash of the source bytes will not byte-match npm's served tarball; and if Blok merely *links* to npm's URL, the integrity Blok serves is npm's, not Blok's — meaning the publish gate (zero install scripts) is unenforceable, because the bytes an AI actually installs were never gated by Blok.

Resolution, honest about the trade: **Blok mirrors the Node artifact into its own object store at publish time, runs the gate over those exact bytes, computes integrity over them, and serves them.** The JS *dependency* graph still resolves through npm at build time (a Blok node's `node_modules` are ordinary npm packages — Blok is not re-hosting all of npm), but the **Blok node artifact itself** is owned and hashed by Blok. This keeps the install trust boundary entirely inside Blok while reusing npm for the deep dependency tree. D3's intent (don't reimplement npm) holds; only the word "federate" was load-bearing-wrong about integrity.

## 8. Compatibility, migration & risks

**Backward-compat stance (hybrid):** additive.
- **v1 versionless `use:` refs keep working** — the registry serves the `latest` dist-tag when no range is given. No existing workflow breaks.
- **Existing `@blokjs/*` npm nodes keep installing during cutover** via dual-read (below); they migrate into Blok-owned, gated, hashed artifacts via backfill.
- **Version-pinned scoped refs are opt-in** (S2 owns the syntax + `blokctl pin-node-versions`).

**Migration tooling**
- `blokctl registry migrate` — backfill: read existing published nodes/workflows from Deskree, re-publish into the new registry **with the gate applied** (so even imported nodes are install-script-free and hashed). Provenance = "imported, unverified" — surfaced honestly as an S12 trust tier, never faked.
- **Dual-read during cutover:** the resolver tries the Blok registry, falls back to the old `/package-list` for anything not yet migrated. Removed once backfill completes.

**Failure modes & risks**
- **M0 over-promise (corrected).** The draft's M0 shipped a lockfile "for reproducibility" against the *existing* Deskree backend — but that backend has no per-version resolution (`INSTALL_NODE` floats to `latest`), so an integrity-pinned lockfile would pin a hash with no way to *re-fetch that version*. M0 is therefore **configurable-URL + offline-cache only**; the lockfile lands in M1 alongside real version resolution. (See §9.)
- **Provenance gap on imported packages** — backfilled nodes have no real Sigstore provenance. Surface as "unverified" (S12 tier), don't fake it.
- **`typeVersion`-style drift** (dossier risk #8, n8n's silent killer) — node-version migration shims must be designable from day one. The manifest carries `contract`, so the registry *can* diff schemas across versions and warn. Not built here, but the manifest shape must not preclude it. **Acceptance criterion: the manifest stores a full contract per version so a future S9 shim can diff `1.x.contract` against `2.x.contract`.**
- **The registry is now Blok-owned infra.** Mitigated by the static-read architecture (resolve = CDN, no compute/DB) and the offline cache. The blast radius of a publish-API outage is "no new publishes," not "no installs."
- **Mirror storage cost / staleness.** Mirroring Node artifacts means Blok stores bytes it could have linked. Accepted: it's the price of owning the integrity boundary (§7.7). Deep deps still live on npm, so the storage is per-node-artifact, not all-of-npm.

## 9. Phased implementation plan

**M0 — Configurable registry URL + offline cache (smallest shippable, no new service, no false promises).** Make `BLOK_URL` configurable; add an integrity-keyed read-through cache under `~/.blok/cache/`. Pure CLI change against the *existing* backend — kills the single point of failure today. **No lockfile yet** (the old backend can't re-resolve a pinned version; pinning without re-fetch is a lie — see §8). Ships independently.

**M1 — Read API (static packument) + manifest schema + lockfile.** Stand up the publish-host metadata store + CDN read path. Publish the multi-runtime manifest JSON Schema. Resolver resolves scoped version-pinned refs against the static packument. **`blok.lock` lands here**, now that versions are actually re-resolvable. Node-runtime artifacts are mirrored + Blok-hashed (§7.7).

**M2 — Publish gate + immutability + scopes (security-critical).** `PUT` with the full gate (contract parse, runtime-match, **zero-install-scripts**, immutability, scope ownership). Yank + dist-tags. Test the install-script rejection and immutability hard — these are the controls the AI trust boundary rests on. (Secret-scanning is *not* in scope — that's S12.)

**M3 — Sigstore provenance.** CI OIDC → Fulcio → Rekor on publish; store + serve the log index; `blokctl install` verifies when present. Reuse npm/Sigstore machinery wholesale.

**M4 — Multi-runtime artifacts + backfill migration.** Per-runtime artifact storage; `blokctl registry migrate` from Deskree (gate-on-import); dual-read cutover. Unblocks S9.

Each milestone is independently useful; M0 ships first and alone.

## 10. Open questions

1. **Build vs. extend Deskree** (dossier risk #1) — confirm appetite to run Blok-owned registry infra. M0 de-risks by shipping value before any new service.
2. **Mirror-all-Node-artifacts storage cost** — confirm acceptance that Blok stores its own copy of every Node artifact (not just a link to npm) to own the integrity boundary (§7.7). The alternative (link to npm, inherit npm's integrity) breaks the publish gate. Recommendation: mirror.
3. **Release channels** — adopt dist-tags-as-channels (`latest`/`next`/`beta`) alongside immutability? (`research-registry-design.md:40`.) Recommendation: yes, orthogonal to immutability.
4. **Provenance enforcement level** — unverified-but-immutable-and-script-free acceptable for community publish (volume), provenance required only for the verified tier (S12)? Recommendation: yes — gate volume on the cheap controls, gate *trust* on provenance.
5. **Workflow node-dependency resolution depth** — installing a workflow: transitively install its node deps, or fail-fast listing missing nodes? Recommendation: resolve + install transitively, lockfile-pinned (npm mental model).
6. **Metadata store: SQLite vs. Postgres at M1** — the read path doesn't touch it, so the only question is concurrent-publisher volume. Recommendation: SQLite until concurrent publishers warrant Postgres; the migration is trivial because it's off the hot path.

---

Key file references for implementation: registry plumbing at `packages/cli/src/services/registry-manager.ts` (drop the `registry.npmjs.org` default, line 7) + `constants.ts` (`BLOK_URL`); install/publish at `packages/cli/src/commands/{install,publish}/{node,workflow}.ts`; the brittle regex-patch to delete at `install/node.ts:updateNodeFile` (replaced by the S7 descriptor `setup` hook); the unversioned `INSTALL_NODE` at `packages/cli/src/services/package-manager.ts:70`; the JSON-Schema emission already present at `core/runner/src/defineNode.ts:2` (`zodToJsonSchema`) + `templates/node/config.json`; the descriptor/lifecycle pattern to reuse (D6/S7) at `packages/cli/src/commands/observability/descriptor.ts` (`resolveWithDependencies`, line 285).

---

**Material changes from the draft** (so the diff is auditable):
1. **Fixed the federation-integrity falsehood** (§7.7, new) — "federate to npm" → "mirror from npm." The draft's claim that Blok's `node.integrity` "must match the npm tarball's" is impossible (npm repacks); and pure federation makes the publish gate unenforceable. This was the most load-bearing error.
2. **Corrected M0** (§9, §8) — the draft's M0 lockfile against Deskree promised reproducibility the old backend can't deliver (no per-version re-resolution). Lockfile moved to M1.
3. **Cut the read-path DB** (§7.1) — packuments are static files; resolve = CDN, no compute/DB. Demoted Postgres to publish-only, SQLite-to-start. Real ponytail win, big blast-radius reduction.
4. **Deferred secret-scanning to S12** (§7.4) — building regex secret rules here is security theater; zero-install-scripts + immutability are the cheap non-negotiables, scanning is S12 hardening. Tightened the gate to what actually earns its place.
5. **Clarified seams with S2 and S9** — S6 consumes pinned refs / produces the manifest slot; S2 owns ref syntax + migration, S9 owns artifacts. Removed scope-creep ambiguity around `blok.lock` and `pin-node-versions`.
6. **Replaced the regex-patch with the S7 descriptor `setup` hook** (§7.5) — the draft kept `updateNodeFile`; D6 makes registration the descriptor's job.
