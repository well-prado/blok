# S9 — Node Packaging & Multi-Runtime Distribution

## Status — Draft for review · depends on: S2 (node identity, scoping & versioning), S6 (registry architecture) · informs: S11 (MCP install), S12 (trust tiers) · phase: 3

---

## 1. Problem & motivation

Blok's vision says an AI should "install nodes/workflows via MCP + CLI + Skills" and that "node authoring must become standalone/versioned/installable across all 8 runtimes." Today none of that is true.

A node is a directory inside the monorepo, hand-wired into a per-trigger `src/Nodes.ts`, sharing one monorepo-global `package.json` version. There is no per-node version, no content hash, no lockfile, and no manifest declaring which runtimes a logical node targets. `blokctl install node` installs **one** npm tarball from an authed private registry (`packages/cli/src/commands/install/node.ts:65-83`) and **regex-patches two spots in `src/Nodes.ts`** — an import line and the `nodes` object literal (`node.ts:106-130`). It is JS-only, version-unaware, and single-runtime.

Two specific facts make this worse than "needs polish":

- **The install seam still emits class instances.** `updateNodeFile` writes `new ${importName}()` into the `nodes` map (`node.ts:128`). That contradicts the project-wide `defineNode()` mandate (CLAUDE.md "Do NOT suggest class-based BlokService for new nodes"). Any packaging spec that says "replace the regex" must also move the discovery contract to a **default export** the runner registers — not a constructor call.
- **Identity is triple-collapsed.** `name` field = npm package name = step `use:` ref (dossier §1). `moduleResolver` (`Configuration.ts:626-627`) does `opts.nodes.getNode(node.node)` — a flat string lookup with **no version parsing**. Resolution is "whatever is registered." This is exactly n8n's `typeVersion`-rot precondition (dossier risk #8), multiplied by 8 runtimes.

This is the single biggest blocker to the marketplace (Vision #3) and to AI-native assembly. An AI cannot reason about, install, or trust a node it cannot resolve by `(scope, name, version, hash)`. And Blok's actual differentiator — 8 runtimes behind one gRPC contract — is **invisible at the packaging layer**: the same logical "validate-card" authored in Go and Python has no shared identity, so the marketplace can't present "this node, on the runtime you want."

**The expensive half is already built for typed SDK nodes.** Each non-Node SDK has a typed-node authoring API that can emit JSON Schema through gRPC `ListNodes` (`NodeDescriptor { name, description, input_schema_json, output_schema_json, tags }`, `proto/blok/runtime/v1/runtime.proto:272-275`) plus `sdk_version` (`:268`), and `Health` returns `registered_nodes` + `sdk_version` (`:288-289`). The schema-uniformity foundation Windmill spent years on exists for nodes that use those typed APIs. **Legacy/raw SDK handlers still report empty schema bytes, which the runner surfaces as `null`; typed handles are real for typed runtime nodes and aspirational for raw ones.** What's missing is a packaging envelope, a version-aware resolver, and loud null-schema diagnostics, not a second schema system.

---

## 2. Current state in Blok (verified)

| Fact | Evidence | Consequence |
|---|---|---|
| Node = directory, monorepo-global version | `nodes/web/api-call@1.0.0/package.json` → `"version": "0.7.0"`; dir `@1.0.0` is cosmetic (dossier §1) | Independent per-node semver is structurally impossible |
| Identity triple-collapsed, no version parse | `moduleResolver` → `getNode(node.node)` (`Configuration.ts:626-627`), flat string | `use:` resolution = "whatever's registered"; no two-versions-coexist |
| Install = authed npm tarball + regex-patch, class-instance | `node.ts:65-83` (`.npmrc` + `pm.INSTALL_NODE`), `node.ts:106-130` (`updateNodeFile`), `node.ts:128` `new ${importName}()` | JS-only, version-unaware, and contradicts the `defineNode()` mandate |
| Runtime nodes already declare requirements | `defineNode.ts:68,95,120` `runtimeRequirements?: Record<string,string>`, validated by `RuntimeVersionValidator` (`Configuration.ts:33`) | Seed of a manifest already exists |
| Schema reflection done for typed SDK nodes | Go `DefineNode`, Rust `TypedNode`, Java/C#/PHP/Ruby typed-node bases, Python `@node` with Pydantic models; `NodeDescriptor.input_schema_json` (`runtime.proto:275`) | The manifest's `inputSchema` is free per typed impl; raw handlers remain `null` |
| SDK + node + proto versions already on the wire | `runtime.proto:268` (`ListNodes.sdk_version`), `:288` (`Health.sdk_version`), `:289` (`registered_nodes`) | Three independent version axes are already observable |
| Module-descriptor pattern proven | `descriptor.ts:57-80` (`dependencies`, `scaffold/setup/verify/cleanup`), `:285` `resolveWithDependencies` | D6's generalization target; S9 is its first non-observability consumer |
| Dep resolver infinite-loops on a cycle | `descriptor.ts:290-296`: `out.add(mod.id)` happens *after* recursing deps, so A→B→A re-enters before either is in `out` | D6's "add cycle detection" is a real bug, not hypothetical |
| Compiled-runtime codegen already drops files in a scanned dir | `runtime add` codegens `register_user_nodes.go` / `user_nodes/mod.rs` (dossier §1) | Multi-runtime install reuses this path; no new wiring invented |

---

## 3. Goals & non-goals

**Goals**
- A per-node identity with its own scope+version (S2), an immutable content hash, and a lockfile — installable independently of the monorepo.
- **One manifest entry (`@scope/name@version`) describing N single-language implementations** (D8) plus the canonical JSON Schema each SDK already emits.
- `blokctl node install @scope/name@range --runtime go,python3` that fetches the right artifact(s) and wires them into each runtime's existing scan/codegen dir — **without** regex-patching a TS file and **without** emitting class instances.
- Version-pinned `use:` refs resolve through a lockfile to an exact `(scope, name, version, hash)`; versionless v1 refs keep working unchanged.
- Node-version migration shims so a `use:` ref to an older major keeps running after a new major ships (the `typeVersion`-drift killer).

**Non-goals**
- "Write once, run on any runtime" (one WASM/binary node). Explicitly rejected (D8) — N implementations under one entry.
- The registry server, integrity/provenance mechanics, the publish pipeline — that's **S6**. S9 is a *client* of S6's `resolve`/`integrity`/`manifest` API.
- Identity grammar + workflow-schema versioning — that's **S2**. S9 assumes `@scope/name@version` and the schema-version gate exist.
- Managed connections/auth (S10), MCP surface (S11), trust tiers (S12).
- **Behavioral** equivalence verification across impls. The publish gate (§7.1) verifies *schema* equality, which is mechanical. Proving two language impls behave identically is undecidable; S9 documents the contract and pushes enforcement to S12's test-on-publish + trust tier, not S9.

---

## 4. Options & alternatives

### Option A — Pure npm, JS-only (status-quo-plus)
Split the monorepo into independently-versioned npm packages; replace the regex-patch with a boot-time scan of `node_modules/@blokjs/*`.
- **Pros:** smallest diff; reuses npm wholesale (semver, SRI, provenance, lockfile all free); AI already "knows" npm.
- **Cons:** **cannot host Go binaries / Python wheels under one identity** — npm is JS-centric. Abandons the multi-runtime differentiator at exactly the layer where it matters.
- **Verdict:** rejected as the *whole* answer — but its JS path is reused inside C (federate to npm for `nodejs`, per D3).

### Option B — One artifact per runtime, no shared identity
Publish `@blok/validate-card-go`, `@blok/validate-card-python` as separate packages; the UI groups by `-go`/`-python` suffix.
- **Cons:** no shared schema contract; cross-impl drift invisible; **`use:` ref changes when you switch runtime → breaks the workflow.** This is `typeVersion` rot ×8. Fails the "one marketplace entry" promise.
- **Verdict:** rejected.

### Option C — One manifest, N implementations, canonical schema per impl (the D8 shape) ✅
A single entry `@scope/name@version` whose manifest lists per-runtime artifacts + the JSON Schema each SDK already reflects. `use:` references the logical node + version; the lockfile + project's enabled runtimes decide which impl runs.
- **Pros:** honest about D8 (N impls) while presenting one entry (Vision #4 reframed as "one entry, N impls"); reuses existing schema reflection; the manifest is the AI's and canvas's contract; cross-impl schema drift is **detectable at publish** (compare each impl's reflected schema to the manifest's).
- **Cons:** needs a manifest schema + a lockfile + version-aware resolution. (S2 already mandates the last one.)
- **Verdict:** recommended.

### Option D — WASM single binary
Rejected (D8; dossier risk #3). "Extreme complexity, cross-language interop nightmare." Defeats native runtimes.

---

## 5. Recommendation & rationale (ponytail lens applied hard)

**Option C** — the only option consistent with D8 and the only one that monetizes Blok's actual differentiator. Crucially it is **mostly formalization, not new machinery**:

- **Does this need to exist?** Yes — but *less than it looks*. The schema half is done for typed SDK nodes. Do not rebuild it. The manifest's `inputSchema`/`outputSchema` are **copied verbatim** from `ListNodes` output, not re-derived; if `ListNodes` returns `null`, the publish/sync path must fail loud or require an explicit `unknown` escape hatch.
- **Reuse before build (lifecycle):** the node-install lifecycle **is** a node-flavored `ModuleDescriptor` (D6). Reuse `scaffold/setup/verify/cleanup` + `resolveWithDependencies` (`descriptor.ts:285`); don't invent a parallel lifecycle. Fix the cycle bug once, in the shared resolver, where the trigger and runtime consumers also route through it.
- **Reuse before build (file placement):** the per-runtime "drop files in the dir" step is **exactly** what `runtime add` codegen already does. Install drops into the same scanned/codegen'd dir. No new wiring.
- **Reuse before build (registry):** don't reimplement semver/integrity/signing. Federate to npm for the JS path (D3); S6 owns the multi-runtime manifest + sidecar hosting. S9 is a *client*.
- **One artifact, not two, for the first ship.** The draft proposed `blok.manifest.json` *and* `blok.lock` as new files from M1. The manifest is a **registry-side, publish-time** artifact (S6 stores it immutably). The **only** new file a project needs is `blok.lock`. M1 doesn't need per-node manifest files sitting in the repo — it needs a lockfile and a version-aware resolver. (`ponytail:` one new project-local artifact, not two; promote a local manifest cache only if offline-resolve becomes a requirement.)
- **One hashing scheme, borrowed.** Content hash = `sha256` over the canonical-JSON manifest + artifact bytes, SRI format (`sha256-…`), the shape npm/JSR already use. No custom scheme.

Against the alternatives: A throws away multi-runtime; B re-creates `typeVersion` rot and breaks `use:` on runtime switch; D is a nightmare. C costs one manifest schema (S6-owned) + one lockfile + version-aware resolution (S2-mandated) and otherwise rides existing seams.

---

## 6. How it improves Blok (and what it does NOT)

**Real wins:**
- **AI installs a node it can trust.** `@scope/name@version` + hash + reflected schema is exactly what an MCP `resolve`/`get-contract` call needs (S11). The AI wires inputs against the manifest's `inputSchema` and pins the hash — reproducible, verifiable.
- **One node, the runtime you want.** Same `use:` ref, different impl resolved per project. The multi-runtime story finally shows up in the *product*, not just the architecture diagram.
- **Reproducible workflows.** `blok.lock` pins `(scope, name, version, hash)`; CI and teammates get byte-identical nodes. No more "whatever is registered."
- **Kills silent shadowing.** Today a user node named `api-call` silently overrides the built-in (dossier §1). Scoped+versioned identity (S2) + manifest resolution removes the entire class.
- **Ends `typeVersion` drift.** A workflow pinned to `@acme/foo@1` keeps running after `@acme/foo@2.0.0` ships, via a shim registered in the normalizer/resolver layer (§7.5) — the same layer that already does v1→v2.

**Honest non-wins (cut from scope, stated so):**
- This does **not** make a Go node and a Python node provably equivalent. It makes their *schemas* equal and their *identity* shared. Behavioral parity is a trust-tier/test concern (S12).
- This does **not** add value for a solo author who never publishes. For in-repo-only projects, the win is reproducibility (`blok.lock`) and nothing more — M1 is deliberately the *only* thing such a user gets, and it's opt-in.

---

## 7. Architecture & design

### 7.1 `blok.manifest.json` — registry-side, one per logical node version
Server-validated at publish (**S6 owns this**); stored immutably; `contentHash` is the registry's content address. **Not a file that lives in a user's project** — it's what S6 returns from `resolve`.

```jsonc
{
  "schemaVersion": "1.0",
  "id": "@acme/validate-card",          // scope+name from S2
  "version": "1.4.0",                    // independent semver, NOT monorepo-global
  "description": "Luhn + BIN validation",
  "tags": ["payments", "validation"],
  "contentHash": "sha256-Yq3…",          // SRI; over canonical manifest + artifact bytes
  "inputSchema":  { /* canonical JSON Schema — MUST equal every impl's reflected schema */ },
  "outputSchema": { /* … */ },
  "runtimes": {
    "nodejs":  { "package": "@acme/validate-card", "version": "1.4.0", "integrity": "sha512-…",
                 "deps": { "lodash": "^4.17.21" } },     // JS deps federate to npm (D3)
    "go":      { "artifact": "validate-card-go@1.4.0.tar.gz", "integrity": "sha256-…",
                 "runtimeRequirement": ">=1.21" },
    "python3": { "artifact": "validate-card-py@1.4.0.tar.gz", "integrity": "sha256-…",
                 "runtimeRequirement": ">=3.11" }
  },
  "migrations": [ { "fromMajor": 0, "shim": "v0-to-v1" } ]  // see §7.5
}
```

Deps live **per-impl** under `runtimes.*` — a Go node has Go deps, a JS node has npm deps; there is no shared top-level dep map (the draft had one, which is wrong — `lodash` means nothing to the Go impl).

**Publish-time anti-drift gate (S6 enforces, listed here as the contract S9 relies on):** for every entry in `runtimes`, the SDK's reflected `input_schema_json`/`output_schema_json` (already returned by `ListNodes`) MUST deep-equal `inputSchema`/`outputSchema`. Reject publish on mismatch, missing schema, or malformed schema unless the manifest explicitly marks that side as `unknown`. This is the one new check that makes "N impls, one schema" honest, and it sits on data the SDKs already produce. Deep-equality is over the **canonicalized** JSON (sorted keys, normalized `$ref` expansion where available), not byte equality.

### 7.2 `NodeModuleDescriptor` — generalize `ObservabilityModuleDescriptor` (D6)
Extract the shared contract from `descriptor.ts:57-80` into `@blokjs/cli/module-descriptor` and reuse it. The node-install lifecycle maps directly:

- `scaffold(opts)` → for each requested runtime, materialize the artifact into that runtime's node dir (`triggers/http/src/nodes/…` for `nodejs`; `runtimes/<lang>/nodes/…` for sidecars — **the dirs the existing scan/codegen already reads**).
- `setup(opts)` → write the `blok.lock` entry; for compiled langs, regenerate the registration shim `runtime add` already produces. **For the `nodejs` path, register via the node's default export, not `new X()`** — fixing the class-instance contradiction at `node.ts:128`.
- `verify(projectDir)` → hit each runtime's `Health`/`ListNodes` RPC; assert the node is registered and its reflected schema matches the locked manifest (`Health` already returns `registered_nodes`, `runtime.proto:289`).
- `cleanup(opts)` → reverse scaffold/setup (the modular-remove story the codebase flags as missing today).

Reuse `resolveWithDependencies` (`descriptor.ts:285`) for node-to-node deps — **but fix the cycle bug** (D6). The current visitor (`descriptor.ts:290-296`) calls `out.add(mod.id)` *after* recursing into deps, so a cycle A→B→A re-enters `visit(A)` while `A` is not yet in `out` and infinite-loops. Fix: a `visiting` set (gray/black DFS coloring) that throws `Cyclic node dependency: A → B → A` on a back-edge. **One fix in the shared resolver covers triggers, nodes, and runtimes** — the lazy fix is the root-cause fix.

### 7.3 CLI surface (D7 — `blokctl` is the kernel; MCP/Skills wrap it)
```
blokctl node install @acme/validate-card@^1.4 --runtime go,python3   # both impls
blokctl node install @acme/validate-card                              # all enabled runtimes
blokctl node update  @acme/validate-card                              # bump within lockfile range
blokctl node remove  @acme/validate-card                             # cleanup() per runtime
blokctl node lock                                                     # rewrite blok.lock from registered/installed nodes
```
Replace `updateNodeFile` (`node.ts:106-130`) with: resolve via S6 → verify integrity → `scaffold/setup` per runtime → record `(version, hash, runtimes[])` in `blok.lock`. JS path federates to npm (the existing `.npmrc` + `pm.INSTALL_NODE` flow at `node.ts:65-83`, kept) and records the npm `integrity`; sidecar artifacts fetch from S6 and verify the SRI hash before any write to disk.

### 7.4 `blok.lock` — the only new project-local artifact
```jsonc
{ "lockfileVersion": 1,
  "nodes": {
    "@acme/validate-card": { "version": "1.4.0", "hash": "sha256-Yq3…",
                             "runtimes": ["go", "python3"] } } }
```
`moduleResolver` (`Configuration.ts:626-627`) and `runtimeResolver` (`:492`) gain a version parse: `use: "@acme/validate-card@^1.4"` → look up the locked `1.4.0` → resolve to the registered impl. **Versionless v1 `use:` refs keep working** — when no version is specified, `getNode` is called exactly as today (the resolution path is unchanged; the lockfile holds a single registered version). Version-pinned refs are opt-in behind S2's schema-version gate. No existing `.ts`/JSON workflow breaks.

### 7.5 Node-version migration shims (the `typeVersion` killer)
When a workflow pins `@acme/foo@1` but only `@acme/foo@2` is installed, the resolver consults `manifest.migrations`. A shim is a pure `(inputV1) → inputV2` (+ `outputV2 → outputV1`) registered alongside the node, applied at the resolver boundary — analogous to how `WorkflowNormalizer` already normalizes v1→v2 at load. Ship it in the normalizer/resolver layer, not in every node. Authors only write a shim on a **major** bump; **absence + major mismatch = hard load-time error with a migration hint** (mirrors `assertNoSetVar`). This bounds authorship burden (open Q4) to "one shim per major you choose to bridge"; skip a major and the pinned workflow hard-fails with a pointer to install the matching version — which is correct, not lossy.

### 7.6 SDK versioning decoupled — already on the wire, just wire the check
`ListNodes`/`Health` already return `sdk_version` (`runtime.proto:268,288`). Pin SDK version in `.blok/config.json` `runtimes.<kind>.version` (already a field). Node `runtimeRequirement` (manifest §7.1) is validated against the live SDK's reported version by the **existing** `RuntimeVersionValidator` (`Configuration.ts:33`). Runner version, SDK version, and node version are three independent axes — the manifest names which it constrains. **No new validator; wire the manifest field into the one that exists.**

---

## 8. Correctness hazard promoted out of "open questions": cross-runtime idempotency cache

The idempotency cache key is currently runtime-agnostic (dossier §1). Under one-manifest-N-impls, `@acme/foo@1.4` on Go and on Python share a logical identity but may produce different bytes for the same input. A cache hit written by the Go impl could be replayed for a Python call (or vice versa), serving a result the wrong impl never produced.

This is a **bug the new model introduces**, not a question. Resolution: **include `runtime kind` in the idempotency cache key triple** — `(workflow, step.id, key)` becomes `(workflow, step.id, runtime, key)`. The §7.1 schema gate guarantees the *contract* is identical across impls; the cache key guarantees a replayed result came from the *same impl*. This is a small change to the cache-key constructor and must ship **in the same milestone as multi-runtime install (M3)**, never after.

---

## 9. Compatibility, migration & risks

**Backward-compat stance (hybrid appetite — explicit):**
- Existing versionless `use: "@blokjs/api-call"` workflows keep working unchanged — they resolve through the existing `getNode` path (§7.4). Version-pinned refs are opt-in behind S2's schema-version gate. **No existing `.ts`/JSON workflow breaks.**
- The monorepo `nodes/**` stay buildable; the in-repo `Nodes.ts` registration is untouched until a project opts into installed nodes. Publishing splits a node into a per-package version *at publish time*, not in the working tree.
- **Breaking change, gated:** the install seam stops emitting `new X()` and switches to default-export registration. This only affects *newly installed* nodes; existing hand-registered class nodes in `Nodes.ts` keep working (the runner registers both). New nodes follow the `defineNode()` mandate. State the stance plainly: the class path is frozen, not removed.

**Migration tooling:**
- `blokctl node lock` — generate `blok.lock` from currently-registered nodes (one-shot adoption, zero registry dependency).
- `blokctl migrate node-manifests` — emit a `blok.manifest.json` per existing `nodes/**` dir from its `package.json` + reflected schema (used at publish time; **requires booting the relevant SDK sidecar to call `ListNodes`** — this is not free, see §10 M1 honesty).
- `blokctl pin-node-versions` (dossier risk #4) — rewrite versionless `use:` refs to pinned ones for projects opting into S2.

**Failure modes:**
| Mode | Handling |
|---|---|
| Cross-impl schema drift | Caught at publish by the §7.1 equality gate; never reaches a consumer |
| Integrity mismatch on install | Hard fail **before any disk write** — no install-time code execution |
| Compiled-runtime build failure post-install | Today fails *silently* on `blokctl dev` (dossier §1). `setup()` MUST compile-check the regenerated shim before declaring success — surface the build error, don't swallow it |
| Cross-runtime cache poisoning | Resolved by the §8 cache-key fix — not deferred |
| Node-dep cycle | `resolveWithDependencies` throws with the cycle path (§7.2 fix) instead of hanging |
| Migration shim missing on major bump | Load-time error with hint, not a silent wrong-input run |
| Name shadowing built-in | Removed by scoped identity (S2) + lockfile-explicit resolution |

---

## 10. Phased implementation plan (smallest-shippable-first, honest about dependencies)

1. **M1 — Lockfile + version-aware resolver, JS-only, zero registry server.** Define `blok.lock` schema. `blokctl node lock` over the existing monorepo nodes. `moduleResolver`/`runtimeResolver` gain a version parse (gated behind S2). *Ships reproducibility for in-repo nodes with zero S6 dependency.* **Honesty:** `migrate node-manifests` is **not** in M1 if it requires booting sidecars to reflect schemas — keep M1 to the lockfile + resolver, which need no SDK round-trip. Manifest generation lands with M4 (publish), where booting SDKs is already part of the pipeline.
2. **M2 — Migration shims.** Shim hook in the normalizer/resolver; hard-fail-with-hint on missing major shim (§7.5). Gated behind S2's schema version.
3. **M3 — `NodeModuleDescriptor` extraction (D6) + multi-runtime install + cache-key fix.** Generalize `ObservabilityModuleDescriptor`; fix the cycle bug (§7.2); `blokctl node install --runtime` wiring artifacts into each runtime dir via `scaffold/setup`, reusing the codegen-shim path; **switch the JS install seam off `new X()` to default-export**; **ship the §8 cache-key fix in this same milestone.** (Depends on S6 for fetch/integrity.)
4. **M4 — Publish-time schema-equality gate + provenance + manifest generation.** The §7.1 anti-drift check, Sigstore provenance, and `migrate node-manifests` — all in S6's publish pipeline (where SDK boot already happens). `blokctl node remove` cleanup.
5. **M5 — `runtimeRequirement` enforcement end-to-end.** Wire manifest `runtimeRequirement` through the existing `RuntimeVersionValidator`.

---

## 11. Open questions

1. **Auto-discovery vs explicit registration at boot.** Scan `node_modules/@blokjs/*` vs lockfile-driven lazy-load of only `use:`-referenced nodes? **Recommendation: lazy-load from the lockfile** (the ponytail answer — load what the workflows reference, not a full FS scan). Confirm.
2. **Sidecar artifact hosting (S6 boundary).** S6's CDN for Go/Python artifacts, or federate to language-native registries (Go module proxy, PyPI) and only host the manifest? **Recommendation: federate** (mirrors the npm-federation stance D3; less to build) **unless** provenance/yank guarantees require hosting. This is an S6 decision S9 consumes — flagging the dependency.
3. **Migration-shim support window (§7.5).** Support every major, or cap at N majors back and hard-fail older with "install matching version"? **Recommendation: no support window — hard-fail with a pointer**, which is correct (not lossy) and zero ongoing burden. Confirm.
4. **JS path publish target (D3).** Real npm packages (so `npm install` works standalone) with the Blok manifest as an overlay, or Blok-registry-only? D3 says federate; **recommend real npm packages + manifest overlay.** Confirm.

*Resolved and removed from this list vs the draft:* cross-runtime cache safety (promoted to §8 as a must-fix bug); top-level shared deps (corrected to per-impl in §7.1).

---

**Files this spec would touch:**
- `core/runner/src/Configuration.ts` — `moduleResolver` (`:626`) / `runtimeResolver` (`:492`) version parsing; idempotency cache-key constructor (§8)
- `core/runner/src/defineNode.ts` — manifest emission helper from reflected schema (`:68` `runtimeRequirements` already present)
- `core/runner/src/workflow/WorkflowNormalizer.ts` — migration-shim hook (mirrors existing v1→v2 + `assertNoSetVar`)
- `packages/cli/src/commands/install/node.ts` — replace `updateNodeFile` (`:106-130`); **drop `new X()` (`:128`) for default-export registration**
- `packages/cli/src/commands/observability/descriptor.ts` — extract shared `ModuleDescriptor`; **fix cycle bug in `resolveWithDependencies` (`:285-301`)**
- `proto/blok/runtime/v1/runtime.proto` — **no change** (`NodeDescriptor` `:272-275`, `sdk_version` `:268,288`, `registered_nodes` `:289` already sufficient)
- **New:** `blok.lock` schema (project-local); `blok.manifest.json` schema (registry-side, S6-owned); `blokctl node {install,update,remove,lock}`

---

**Summary of changes from the draft (what the adversarial pass cut/fixed):**
- **Cut one new artifact:** `blok.manifest.json` is registry-side (S6), not a project file; `blok.lock` is the only new project-local artifact for M1.
- **Promoted open-Q#3 to a must-fix bug (§8):** cross-runtime idempotency cache poisoning is a defect the new model *introduces*; the cache-key fix ships in M3, not "later."
- **Corrected the manifest:** deps are per-impl under `runtimes.*`, not a shared top-level map (`lodash` is meaningless to the Go impl).
- **Surfaced the class-instance contradiction:** `node.ts:128` emits `new X()`, violating the `defineNode()` mandate; the install rewrite must switch to default-export registration, not just "replace the regex."
- **Made M1 honest:** manifest generation needs SDK sidecar boot; moved it to M4 where that boot already happens. M1 = lockfile + resolver only.
- **Pinned the cycle bug to evidence** (`descriptor.ts:290-296`, `out.add` after recursion) and routed the fix through the one shared resolver.
- **Tightened non-goals:** behavioral cross-impl equivalence is undecidable; S9 verifies schema equality only and pushes behavioral trust to S12.
