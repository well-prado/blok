# S12 — Marketplace Trust, Verification & Licensing

## Status — Draft v2 (adversarially revised) · depends on: S6 (Registry architecture), S2 (Node identity/scoping); soft ties to S9 (multi-runtime), S11 (MCP install policy), S10 (auth) · phase: 3

## 1. Problem & motivation

Blok's vision is an AI-native marketplace where "an AI assembles a complex backend in a day; installs nodes/workflows via MCP + CLI + Skills." The moment an agent — or a human rubber-stamping an agent's suggestion — runs `blokctl install @acme/stripe-node` autonomously, **the trust question becomes load-bearing**. Every cautionary tale in the briefs lands here:

- npm's reactive-only malware posture: most compromises caught by *third parties*, hours after publish, via install scripts (research-registry-design.md:37). A node that runs arbitrary code at install time is a supply-chain bomb an AI will detonate without hesitation.
- VS Code "verified ✓" theater: a blue check that proves *domain ownership*, not code safety; >550 secrets leaked across 500+ extensions; a leaked publisher PAT auto-pushes malware to the whole install base (research-registry-design.md:39). Blok's current install path makes this concrete: `install/node.ts:71` writes a registry `_authToken` into a project `.npmrc`, and `publish/node.ts:242` publishes with whatever token is in scope — a leaked long-lived token is a catalog-wide write primitive today.
- n8n rejecting "nodes that compete with paid/enterprise features" (research-n8n.md:29) and the n8n/Windmill **relicensing churn** that "poisons community trust" (research-n8n.md:66, research-windmill.md:49) — Windmill paywalling alerting and private registries, the exact reliability primitives Blok just shipped as observability modules.
- Make's 4–6 week human QA gate "is a growth killer" that contradicts "assemble a backend in a day" (research-nocode-market.md:44).

S6 builds the registry *mechanics* (scopes, immutability, the publish endpoint, the multi-runtime manifest). **S12 answers three orthogonal policy questions S6 deliberately punts:** (1) what "trusted" *means* — what tiers exist and what each mechanically guarantees; (2) Blok's **license and commercial boundary**, decided once, deliberately, before a community forms around it; (3) the lifecycle policies — deprecation, ownership transfer, malicious-package response — that every open registry needs "from day one" (research-nocode-market.md:48) or accumulates rot and unowned attack surface.

These are decisions, not a code mountain. Getting them wrong is expensive and largely irreversible (you cannot un-relicense; you cannot retroactively make a flat-namespace registry typosquat-proof).

## 2. Current state in Blok

There is **no trust model, no verification, no provenance, and no marketplace license** today. Concretely:

- **License:** framework is `Apache-2.0` (`package.json` `"license"`; `/Users/wellprado/Projects/Personal/blok/LICENSE` is the full Apache 2.0 text). No per-package or marketplace-content license exists. Clean slate the briefs warn must be set deliberately.
- **Publish = `npm publish` with zero gating.** `packages/cli/src/commands/publish/node.ts:242` runs `manager.PUBLISH(...)` (literal `npm publish`) against a Deskree-proxied registry obtained via `registryManager.getRegistryToken()`. It auto-scopes (`node.ts:230-237`: `@${registry.namespace}/...`), bumps version (`node.ts:199`), writes a temp `.npmrc` (`node.ts:213`), and *that's it*. **No schema validation, no secret scan, no provenance, no test gate, no trust tier.** Anyone with a token publishes anything. The scoping is *client-side* — which means a gate that runs only in the CLI is trivially bypassed by publishing straight to the registry; **the authoritative gate must be server-side in S6's publish endpoint** (S12 defines the checks; S6 owns where they run).
- **Install hand-patches source with no integrity check.** `install/node.ts:80` runs `npm install`, then `updateNodeFile()` (`install/node.ts:107`) regex-rewrites `src/Nodes.ts` to add the import + `new XNode()`. No SRI check, no provenance verification, no tier surfaced.
- **Workflow publish is a raw POST** (per S6's current-state) with no schema validation.
- **Identity is collapsed and versionless** (the D4 problem S2 fixes): node-name = package-name = `use:` ref. A trust tier needs a stable, scoped, *versioned* identity to attach a badge to — **a badge on an unversioned name is meaningless** (the next publish silently replaces what was verified). S2 is a hard prerequisite, not a soft one.
- **The one proven modular pattern is observability.** `packages/cli/src/commands/observability/descriptor.ts` defines `ObservabilityModuleDescriptor` (`descriptor.ts:49-81`) with two distinct hook shapes worth keeping straight: **`validate(projectDir) => Promise<void>` that *throws* if requirements aren't met** (`descriptor.ts:78`) and **`verify(projectDir) => {ok, message}` that *reports* status** (`descriptor.ts:76`). S12's publish-gate checks are the **`validate`-throws shape** (a check is "throw to reject"); the registry's runtime tier/health surface is the `verify`-reports shape. The draft conflated these — corrected here.

So Blok has the *plumbing* (CLI publish/install, a registry token broker) but **none of the trust policy** — and a couple of active footguns (long-lived tokens, no install-time integrity). That gap is exactly what makes autonomous AI install unsafe today.

## 3. Goals & non-goals

**Goals**
- Define **three trust tiers** — `local` → `community` (published, passed the floor) → `verified` — each with a *mechanically-checkable* definition, surfaced as one badge field across CLI/MCP/Studio.
- Make `verified` an **automated CI gate**, not a human review queue: provenance + no-runtime-deps + tests-pass. Volume from open self-publish; trust from automation.
- **Decide the license once**: framework license, marketplace-content license, commercial boundary — with an explicit, public promise about what will *never* be paywalled.
- Define lifecycle policy: **deprecation, yank, ownership transfer, malicious-package response** (the npm-unpublish-hole and abandonment-rot failure modes).
- Give an **AI agent a trust signal it can reason about** before installing (`tier` + `provenance` in the resolve/install response), and a **default install policy** (S11 enforces; S12 defines).

**Non-goals**
- Building the registry API/storage (S6), node packaging mechanics (S9), or the install policy *enforcement* in MCP (S11). S12 is policy + the gate *definition* that runs inside S6's publish path.
- Managed-connection/secret-injection auth (S10).
- A human curation team/process at launch — explicitly avoided per the Make lesson.
- Runtime sandboxing of untrusted nodes (the D8/multi-runtime story; S12 *references* it as the containment layer but does not build it).
- Paid monetization mechanics (billing, Connect-style embed). S12 fixes the *boundary*, not the storefront.
- **A secret-scanner of our own.** S12 specifies *that* the floor includes a secret scan; the implementation reuses an existing scanner (gitleaks/trufflehog binary) shelled from S6's gate — not a hand-rolled regex set we maintain. (Ponytail: secret-detection is a solved, adversarial, full-time problem; do not enter it.)

## 4. Options & alternatives

### Option A — Binary trust (npm/community-nodes model): published vs. not
One registry, everything published is "community," a manual allowlist/blocklist on top (n8n's `security@` + blocklist, research-n8n.md:28).
- **Pros:** simplest; matches npm mental model.
- **Cons:** no automated trust *signal* — an AI can't distinguish a vetted node from a typosquat. n8n admits unverified nodes "can do anything, including malicious actions" (research-n8n.md:64). Curation becomes a human bottleneck as volume grows.
- **Changes to Blok:** a `blocklist` check on install. Minimal — and inadequate for autonomous install.

### Option B — Human-reviewed verification (Windmill Hub / Make model)
Self-publish open; a Blok team *approves* the verified badge (research-windmill.md:19).
- **Pros:** strongest quality signal; humans catch what CI can't.
- **Cons:** the documented anti-pattern. Make's 4–6 week gate is "a growth killer" (research-nocode-market.md:44); Windmill's Hub stays "~100s of items" because review gates volume (research-windmill.md:53). Contradicts "assemble a backend in a day."
- **Changes to Blok:** review dashboard + reviewer rota + SLA. Heavy org cost, wrong axis.

### Option C — Automated, mechanically-checkable verification (RECOMMENDED)
Three tiers. `community` = anyone self-publishes through S6's floor (scoped, immutable, **secret-scanned**, **zero install scripts**, **resolves to a real Blok node**). `verified` is earned **automatically** by passing a reproducible CI check: published via OIDC from CI with a **Sigstore provenance** statement, **no runtime dependencies**, and the node's **`NodeTestHarness`/`WorkflowTestRunner` tests pass in the gate** (research-nocode-market.md:56, research-n8n.md:51). No human in the loop.
- **Pros:** volume *and* trust; scales to AI velocity; every check is something an agent can also verify. "No runtime deps" is "cheap, high-leverage, mechanically checkable in CI" (research-n8n.md:51).
- **Cons:** "no runtime deps" strands legitimately heavyweight nodes at `community`; CI provenance requires authors to publish from CI, adding friction (the npm May-2026 path, research-n8n.md:29).
- **Changes to Blok:** the gate runs inside S6's publish endpoint; `tier` becomes a manifest field; install + MCP resolve surface it. Reuses the observability `validate`-throws hook shape.

### Option D — Reputation/identity verification (VS Code blue-check model)
Verify *publisher identity* (domain/org ownership, age) rather than artifact safety.
- **Pros:** legible ownership; defeats some impersonation.
- **Cons:** the briefs' single loudest warning — "theater" that "proves domain ownership, not that the code is safe" (research-registry-design.md:39). Implies a safety guarantee it doesn't deliver.
- **Changes to Blok:** an org-verification flow. Useful *as a separate axis*, never conflated with artifact trust.

## 5. Recommendation & rationale

**Adopt Option C (automated mechanically-checkable verification) as the tier model. Keep Option D's publisher-identity as a strictly separate, non-safety-implying axis — and DEFER building it (see §10 Q5): scopes (S2) already kill typosquatting structurally, so identity-verification is YAGNI until impersonation is an observed problem.**

On licensing: **keep the framework `Apache-2.0`** (it already is — do *not* relicense the core; relicensing is the trust-poison both n8n and Windmill demonstrate), and **publish first-party `@blok/*` nodes source-available with a Pipedream-style commercial-use clause**, while **community-published content stays author's-choice (default MIT)**. Make a **public, written "never-paywalled" promise** covering observability, alerting, private registries, and core reliability.

**Ponytail lens — does this need to exist, and how little can it be?** The *policy* must exist before autonomous install opens; the *build* is small because it reuses everything:

- The `verified` gate is **not a new engine** — it's three checks (`no-runtime-deps`, `provenance-present`, `tests-pass`) bolted onto S6's existing publish path, expressed through the observability `validate(...) => throws-if-not-met` shape that already exists at `descriptor.ts:78`. Reuse before build.
- `no-runtime-deps` is a one-line check (`Object.keys(pkg.dependencies ?? {}).length === 0`) — not a sandbox, not a scanner.
- `provenance` reuses **Sigstore wholesale** (OIDC→Fulcio→Rekor), "needs no key management" (research-registry-design.md:29), verified with `@sigstore/verify`. Don't build signing.
- The secret scan **shells out to gitleaks/trufflehog** — don't author a detector.
- The license is a **text-file decision**, zero code.
- yank/blocklist is a **boolean column** S6 already needs for immutability+yank (research-registry-design.md:27).

So S12's net new code is roughly: ~3 small check functions, one `evaluateTier()` reducer, a handful of manifest fields, and badge-printing in three already-existing front doors. Most of S12 is the **license decision (M0)** and **lifecycle policy** — words, not code.

Against the alternatives: A can't serve autonomous AI; B is the documented growth-killer; D-alone is theater (and D-now is premature). C is the only option that is simultaneously *automatable*, *AI-legible*, and *fast*. It honors **D7** (the gate is `blokctl`/S6 code; MCP/Studio are thin layers reading the same `tier` field) and **D3** (the trust signals — scopes, SRI integrity, Sigstore provenance — are the npm-protocol shapes S6 already reuses, so an AI "already knows" them).

## 6. How it improves Blok

- **AI can install safely on its own.** `resolve()` returns `{ tier, provenance }`; an agent's default policy (defined here, enforced in S11) is "auto-install `verified`; require explicit human confirmation for `community`; never auto-install `yanked`/blocklisted." This is the precondition that makes autonomous assembly real instead of reckless.
- **Trust is fast.** `community → verified` is wiring one GitHub Action — no review queue, no 4–6 week wait.
- **No relicensing time-bomb.** A founder-level decision made now, documented, with a never-paywalled promise, pre-empts the single most-cited community-trust failure of both direct competitors.
- **The marketplace can't become a malware vector at install time** — zero install scripts (JSR's stance, research-registry-design.md:37), so the npm "auto-updated install script" attack class is structurally absent. (And S12 closes the *current* long-lived-token hole at `install/node.ts:71` / `publish/node.ts:213` by moving to per-publish OIDC — see §7.4.)
- **Differentiator:** untrusted nodes run in a constrained runtime, not the host process (research-n8n.md:64) — S12 *names* multi-runtime containment (D8/S9) as the belt to verification's suspenders, an edge single-runtime n8n cannot claim. (S12 does not build it.)

## 7. Architecture & design

### 7.1 The three tiers

| Tier | How earned | Guarantees | Badge |
|---|---|---|---|
| `local` | Authored in-project, never published | None (your own code) | (none) |
| `community` | Passed S6 publish floor: scoped+immutable+versioned (S2), **resolves to a real Blok node** (manifest + at least one runtime impl loads), **secret-scanned**, **zero install scripts** | Won't leak obvious secrets; won't run code at install; is a real, scoped, immutable Blok node version | `community` |
| `verified` | `community` **plus**: published via OIDC-CI with **Sigstore provenance**, **zero runtime dependencies**, **declared-runtime tests pass in the gate** | Reproducible from a named commit; no transitive supply-chain surface; behaves as its tests assert | `verified` (green) |

**`community` is NOT "unscanned."** The floor (real-node + secret + no-install-script) is excluded from the npm "anything goes" failure mode even at the open tier. `verified` adds reproducibility + zero-dependency-surface.

Replaced the draft's `community`-floor "schema-valid (Zod parse)" check with **"resolves to a real Blok node."** Rationale: a node's input/output Zod schema is runtime JS, not statically parseable server-side without executing it (the server can't `import` and run an untrusted package to call `.parse`). The honest, server-side-checkable floor is *structural*: the package declares the multi-runtime manifest (S9), names a `defineNode` entry, and at least one runtime impl loads in the gate sandbox. Deep schema validity is naturally covered by the **`tests-pass`** check at the `verified` tier, where running the code is already in scope. Calling the floor "schema-valid" over-promised something the server can't cheaply verify.

A **separate, orthogonal** `publisher: { identity, verifiedOrg? }` axis (Option D) is **deferred** (§10 Q5). When/if built, it records domain/org verification, renders distinctly, and **never** implies artifact safety (the anti-theater rule, research-registry-design.md:39).

### 7.2 The verification gate (runs server-side inside S6's publish endpoint)

Reuse the observability `validate`-throws shape — a gate is a list of checks, each `(art) => Promise<void>` that throws to reject:

```ts
// where S6's publish endpoint runs it (server-side — NOT only the CLI)
export interface PublishCheck {
  id: "real-node" | "no-secrets" | "no-install-scripts"   // floor
    | "no-runtime-deps" | "provenance" | "tests";          // verified-only
  tier: "community" | "verified";
  run(art: PublishArtifact): Promise<void>;                // throws PublishGateError
}

const floorChecks:    PublishCheck[] = [resolvesToRealNode, noSecretsLeaked, noInstallScripts];
const verifiedChecks: PublishCheck[] = [noRuntimeDeps, provenancePresent, testsPass];

export async function evaluateTier(art: PublishArtifact): Promise<"community" | "verified"> {
  for (const c of floorChecks) await c.run(art);            // throws => publish REJECTED outright
  try { for (const c of verifiedChecks) await c.run(art); return "verified"; }
  catch { return "community"; }                             // verified is a best-effort upgrade
}
```

`noRuntimeDeps` is the one-liner:
```ts
const noRuntimeDeps: PublishCheck = {
  id: "no-runtime-deps", tier: "verified",
  async run(a) {
    if (Object.keys(a.packageJson.dependencies ?? {}).length)
      throw new PublishGateError("verified tier requires zero runtime dependencies");
  },
};
```

`provenancePresent` verifies the Sigstore bundle (Rekor inclusion proof + subject digest == artifact SHA-512) via `@sigstore/verify` — no custom crypto.

`testsPass` runs the node's `NodeTestHarness`/`WorkflowTestRunner` suite in the gate sandbox — "automatable, scales, AI agents read the test as the contract" (research-nocode-market.md:56). **This is the one genuinely heavy piece of S12** and the spec must not hand-wave it: running untrusted author code server-side requires the same constrained runtime D8/S9 provides for untrusted *node execution*. **S12 does not own that sandbox — it reuses S9's runtime-isolation harness.** If S9's sandbox isn't ready, `verified` ships *without* `tests-pass` (provenance + no-deps only) and `tests-pass` is added when S9 lands. This is called out as a hard sequencing dependency in §9, not buried.

For multi-runtime nodes (D8/S9), see §10 Q2 — the per-runtime-vs-all-runtimes decision is open.

### 7.3 Manifest additions (consumed by install/MCP/Studio)

S6's per-version manifest gains a `blok` block:
```jsonc
{
  "name": "@acme/stripe-node", "version": "1.2.0",
  "dist": { "tarball": "...", "integrity": "sha512-..." },
  "blok": {
    "tier": "verified",
    "provenance": { "sourceRepo": "github.com/acme/blok-nodes",
                    "commit": "a1b2c3d", "rekorLogIndex": 4827193, "builder": "github-actions" },
    "deprecated": false,
    "yanked": false,
    "runtimes": ["node", "python3"]          // D8 manifest, owned by S9
  }
}
```

`install/node.ts` (after S2's integrity-checked install replaces the current regex-patch at `install/node.ts:107`) and the MCP `resolve` tool read `blok.tier` + `blok.provenance`; CLI prints the badge, Studio's palette renders it, an AI policy gates on it. **One field, three front doors** (D7).

`publisher` is intentionally **absent** from this manifest until §10 Q5 is resolved — adding a field implying identity-trust before the axis is designed is exactly the theater the briefs warn against.

### 7.4 Lifecycle policy

- **Immutable + yank, never hard-delete** (JSR, research-registry-design.md:27). Yank hides a bad version from default resolution; existing pinned dependents (S2's version-pinned `use:` refs) still resolve it. Closes the npm unpublish / dependency-confusion hole (research-registry-design.md:38).
- **Deprecation** = `blok.deprecated: true` + a message + optional `supersededBy: "@acme/stripe-node@2"`. Warns at install and in Studio; does not break existing workflows.
- **Abandonment / freshness:** **shipped as warn-only, NOT auto-downgrade** (reversing the draft, per §10 Q3). A `verified` node with no release in N months *and* a newer major available surfaces a "stale" advisory at install/in Studio — it does **not** silently flip the badge. Rationale: a silent `verified→community` downgrade punishes a *correct, stable, finished* node (the best small nodes need no churn) and surprises authors who did nothing wrong. The original guarantee (reproducible build, no deps, tests passed) is still *true* — staleness is a separate dimension, so surface it separately. Mechanical, no human, no destructive state change.
- **Ownership transfer:** a scope is owned by an account/org (S2). Transfer is an explicit registry operation logged in an append-only audit trail; the new owner **cannot** retroactively alter published immutable versions (provenance still names the original CI commit). **Leaked-token / hostile-takeover blast radius is bounded by moving off long-lived tokens** — the current `_authToken` written to `.npmrc` (`install/node.ts:71`, `publish/node.ts:213`) becomes a **per-publish OIDC-minted short-lived credential** (research-registry-design.md:39 lesson #2). This is the concrete fix for the VS-Code-PAT failure mode and it's part of S6's publish endpoint, flagged here as the trust-relevant reason.
- **Malicious-package response:** fast `yanked: true` + blocklist entry (boolean column) pulls a bad version from resolution immediately; reported via `security@`. Because there are **no install scripts**, a malicious node can't execute until a workflow *runs* it — and untrusted nodes run in the constrained multi-runtime container (D8/S9), not the host process. Detection ≠ the remediation race npm loses.

### 7.5 License decision (the founder call)

| Surface | Recommended license | Rationale |
|---|---|---|
| Framework core (runner, CLI, SDKs, triggers, observability) | **Apache-2.0** (keep — already is) | Relicensing core is the trust-poison. Apache gives patent grant + permissive adoption. **Never** move to a fair-code/SUL model. |
| Marketplace **content** (community nodes/workflows) | **Author's choice, default MIT**; registry T&Cs grant Blok a hosting/index license | Keeps content AI-readable + individually forkable. |
| Blok **first-party** `@blok/*` official nodes | **Source-available, Pipedream-style commercial clause**: read/modify/redistribute, may NOT run a competing iPaaS from the catalog | Stops a competitor lifting the *whole curated catalog*; doesn't restrict individual node reuse (research-nocode-market.md:39). |

**Never-paywalled promise (written, public, in `MARKETPLACE.md`):** observability, alerting, structured logging, private/self-hosted registry, and all core reliability primitives stay free — the explicit inverse of Windmill's mistake (research-windmill.md:49). **No "reject nodes competing with paid features" rule** (the n8n resentment-breeder, research-n8n.md:67): competing/alternative nodes for the same service are allowed; ratings + tier sort quality, not a gatekeeper veto.

> Honesty note on the first-party clause: a source-available commercial clause is a **real, mild** divergence from "pure Apache everywhere," and is worth naming as such rather than selling as free. The trade-off is deliberate — it's the *only* moat against catalog-lifting that doesn't touch the framework or community content, and it's scoped to first-party `@blok/*` only. If the founder prefers zero friction and zero moat, fully-permissive everywhere is the alternative in §10 Q1. Either is defensible; pretending the commercial clause is "basically open" is not.

## 8. Compatibility, migration & risks

**Backward-compat stance (hybrid appetite):** S12 is **purely additive**. Existing published nodes default to `tier: "community"` (they passed nothing stricter than `npm publish`; floor checks apply on their *next* publish, not retroactively). No existing workflow breaks — `tier` is metadata. The license decision touches **text files**, not code; core stays Apache-2.0, so no existing user's rights change.

**Honest dependency-on-S2 caveat:** S12's badge is only meaningful *on top of* S2's versioned, scoped `use:` refs. Until S2 ships, a "verified" badge sits on a mutable name and the next publish silently invalidates it. **S12 must not ship its `verified` tier ahead of S2** — the floor tier (community) can ship earlier as a safety win, but `verified` is gated on S2. This is a real ordering constraint, not a nicety.

**Migration tooling:**
- `blokctl publish node --verified` runs the verified checks **locally as an advisory pre-flight** and prints exactly what fails (missing provenance → "publish from CI"; has deps → lists them). The local run is a *convenience*, not the authority — the **server-side gate in S6 is what actually assigns the tier** (the CLI auto-scopes client-side today at `node.ts:230`, so any CLI-only gate is bypassable). The check IS the migration guide.
- A backfill job re-evaluates existing community nodes against the verified gate opportunistically (read-only; only upgrades, never downgrades on backfill).

**Failure modes & mitigations:**
- *Verified-tier theater* (the VS Code trap): every guarantee is mechanical and the badge tooltip **names what verified does NOT mean** ("reproducible build + no deps + tests pass — NOT a guarantee the code is benign"). Identity stays a separate, deferred axis.
- *"No runtime deps" too strict* → heavy nodes stranded at `community`. Accepted: `community` is a *safe* tier (no install scripts, secret-scanned, runtime-sandboxed), not a scarlet letter. Document "community ≠ dangerous."
- *Provenance-from-CI friction* → some authors won't wire CI. Accepted: they stay `community`; the on-ramp is one Action file.
- *`tests-pass` needs an untrusted-code sandbox we don't own yet* → **hard dependency on S9's runtime isolation.** Mitigation: ship `verified` as provenance+no-deps first, add `tests-pass` when S9 lands (§9 M4). Named, not hidden.
- *License regret* → the point of deciding now; the risk is *not* deciding and relicensing later.
- *Scope squatting* → mandatory scopes + reserved `@blok/*` for first-party (S2/S6) structurally limit it; ownership audit trail handles disputes — which is *why* the identity axis (Option D) can be safely deferred.

## 9. Phased implementation plan

**M0 — License decision (no code, ship first).** Founder signs off: core stays Apache-2.0; pick the marketplace-content + first-party-node license; publish the never-paywalled promise + "no anti-competitive rejection" policy as `MARKETPLACE.md`. Unblocks everything socially; highest reversible-cost, so do it deliberately and first.

**M1 — Tier metadata + community floor (smallest shippable, no S2 dependency).** Add `blok.tier` to S6's manifest; wire the three **floor** checks (resolves-to-real-node, no-secrets via shelled gitleaks, no-install-scripts) into S6's **server-side** publish endpoint; default existing/new nodes to `community`. Surface the badge in `install/node.ts` output and MCP `resolve`. Also lands the **per-publish OIDC token** fix (kills the long-lived-`.npmrc`-token hole). Makes autonomous install *safer* than today even before `verified` exists.

**M2 — Verified gate (gated on S2).** Add `no-runtime-deps` + `provenance` (Sigstore verify); `evaluateTier()` upgrades to `verified` automatically; `blokctl publish node --verified` advisory self-check. Render the green badge. (`tests-pass` deferred to M4.)

**M3 — Lifecycle.** Yank + deprecate + blocklist columns and CLI verbs (`blokctl registry yank/deprecate`); ownership-transfer audit log; freshness **warn-only** advisory; `security@` runbook + committed yank-SLA.

**M4 — `tests-pass` + multi-runtime containment tie-in (gated on S9).** Add `tests-pass` to the verified gate using S9's runtime-isolation sandbox; decide per-runtime vs all-runtimes (§10 Q2); document untrusted-node-runs-in-constrained-runtime as the containment story.

**Deferred / conditional — publisher-identity axis (§10 Q5):** build only if impersonation becomes an observed problem.

## 10. Open questions

1. **License — the founder call.** Confirm: core Apache-2.0 (keep) + Pipedream-style source-available for first-party `@blok/*` + MIT-default for community content? Or fully permissive everywhere (more open, less moat against catalog-lifting)? (§7.5 names the trade-off honestly either way.)
2. **Does `verified` require ALL declared runtimes' tests to pass, or per-runtime verification** (verified for `node`, community for `python3`)? Per-runtime is more honest but adds badge/UI complexity. Ties to S9.
3. ~~Freshness auto-downgrade~~ → **resolved to warn-only** (§7.4). Confirm you agree silent badge-downgrade is the wrong call.
4. **Reserved scopes** beyond `@blok/*` — do partners get verified-org scopes (`@stripe/*`) and what's the claim process? (S2/S6 ownership.)
5. **Publisher-identity axis (Option D) — DEFER recommendation.** S12 recommends *not* building it in phase 3: scopes already kill typosquatting, and it's the most theater-prone, least-mechanical piece. Confirm defer-until-observed-problem, or insist on shipping it.
6. **Workflow content (not just nodes)** — does the same tier model apply to published *workflows*? Proposed definition: a "verified workflow" = its `WorkflowTestRunner` suite passes in the gate AND every `use:` ref resolves to a non-yanked version (the *referenced nodes' own* tiers are surfaced but not required-verified — forcing all-deps-verified would strand useful workflows). Confirm.
7. **Malicious-package SLA** — committed yank-response time, and who owns the `security@` rota at launch?
8. **`tests-pass` sequencing** — confirm acceptance that `verified` ships in M2 as provenance+no-deps and `tests-pass` arrives in M4 with S9, rather than blocking `verified` on the sandbox.

---

**Files grounding this spec:**
- `/Users/wellprado/Projects/Personal/blok/packages/cli/src/commands/publish/node.ts:242` (current ungated `npm publish`), `:230-237` (client-side auto-scoping — why the gate must be server-side), `:213` (long-lived `.npmrc` token written).
- `/Users/wellprado/Projects/Personal/blok/packages/cli/src/commands/install/node.ts:80` (ungated `npm install`), `:107` (regex-patches `src/Nodes.ts`, no integrity/provenance/tier), `:71` (token-in-`.npmrc` — the leaked-token hole S12 closes via OIDC).
- `/Users/wellprado/Projects/Personal/blok/packages/cli/src/commands/observability/descriptor.ts:78` (the `validate(...) => throws` hook shape reused as the publish-gate check contract), `:76` (the `verify(...) => {ok,message}` reporter shape — distinct, used for registry tier/health surface).
- `/Users/wellprado/Projects/Personal/blok/packages/cli/src/services/registry-manager.ts` (Deskree token broker the OIDC fix replaces).
- `/Users/wellprado/Projects/Personal/blok/LICENSE` + `package.json` `"license": "Apache-2.0"` (current license — keep, do not relicense core).
