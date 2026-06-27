# S10 — Managed Connections: the Auth Primitive

## Status — Draft for review · depends on: S6 (Registry architecture), S7 (Generalized module-descriptor contract), S2 (Node identity & versioning) · phase: 3

> **Reviewer note (changes from the prior draft):** added S7 as an explicit dependency (the CLI surface is a *descriptor consumer*, not a re-derivation of the observability one). Corrected a load-bearing factual error about the env allowlist — its default path returns `process.env` **directly, un-proxied** (`envAllowlist.ts:106-113`), so "the allowlist excludes `BLOK_CONN__*` from `ctx.env` for free" is **false** unless an allowlist is configured. The v1 store design is reworked so secret isolation does not depend on the operator having configured an allowlist. Killed the `connection test` provider-`verify()` hook from Phase 1 (speculative). Tightened Phase 1 to be honestly shippable and made the gRPC/cross-runtime hop the explicit hard part rather than a footnote.

---

## 1. Problem & motivation

Blok's vision is "an AI assembles a complex backend in a day" over a real connector marketplace ("npm for Blok") spanning all 8 runtimes. Every connector marketplace that matters — Pipedream (~3,000 apps), Zapier, Make — rests on **one** primitive Blok does not have: **managed connections**. A node declares "I need a Slack credential"; the platform injects the live secret at run time. The node never sees, stores, or rotates the raw secret beyond the moment of use; the workflow author never pastes a token into a step input.

Today a Blok node that calls Stripe must reach into `ctx.env.STRIPE_KEY` or accept an `apiKey` input the author wires by hand. That is fatal for a marketplace for three reasons:

1. **Secrets leak into the workflow artifact.** A workflow with `inputs: { apiKey: "sk_live_..." }` cannot be committed, shared, published, or AI-generated. The D1 "TS canonical + published JSON IR that registry/AI consume losslessly" story breaks the moment the IR has to carry a live secret.
2. **No reuse across nodes/workflows.** Each node invents its own credential input shape. There is no "connect Slack once, use it in 40 steps." Rotation means find-and-replace across files.
3. **AI can't autonomously wire auth.** An MCP agent (S11) installing `@acme/stripe-charge` has no contract telling it "this needs a `stripe` connection" and no safe way to bind one — so a human must intervene at exactly the step that makes the marketplace valuable.

The dossier names this directly (research-nocode-market.md:55 via _DOSSIER.md:27): *"adopting Pipedream's `type:"app"` prop is the unlock for the marketplace, modular triggers, and MCP install."* This spec defines that primitive.

## 2. Current state in Blok

There is **no connection/credential abstraction**. What exists:

- **`defineNode` input is the only contract surface** (`core/runner/src/defineNode.ts:41-77`). A node declares `input: z.object({...})`; secrets, if any, are just more Zod fields. `FunctionNode.handle` validates `inputs` and calls `execute(ctx, validatedInput)` (`defineNode.ts:140-178`). No hook for "inject a managed credential before execute."
- **`ctx.env` is the de-facto secret channel — and it default-allows.** `BlokService.run` reads `ctx.env` via `getEnvForCtx()`. **Critical nuance the prior draft got wrong:** when neither `BLOK_NODE_ENV_ALLOW` nor `BLOK_NODE_ALLOW_PREFIX` is set, `getEnvForCtx()` returns `process.env` **directly, with no Proxy** (`envAllowlist.ts:106-113`). The filtering Proxy only exists when an operator *opts in* (`envAllowlist.ts:67-85`). So **a node can read any `process.env` key by default**, and a production warning fires acknowledging it (`envAllowlist.ts:93-98`). This means S10 **cannot** rely on "the allowlist hides `BLOK_CONN__*` from nodes" as a default guarantee — see §7.3.
- **Inputs are mapper-resolved immediately before execute.** `BlokService.run` runs `blueprintMapper(opts, ctx, data)` (`Blok.ts:95-99`) → `validate` (`Blok.ts:100`) → `handle` (`Blok.ts:103`). This is the exact pre-execute seam a connection resolver hooks into — the same place `$.state.x` becomes a value.
- **`ctx.connection` is taken** — it's the WebSocket per-connection API (`core/shared/src/types/ConnectionContext.ts:20-82`: `send`/`close`/`setAttachment`/`broadcast`). The credential primitive must NOT reuse that name. Use **`ctx.auth`**.
- **The descriptor + fenced-env-write pattern is proven.** `ObservabilityModuleDescriptor` (`packages/cli/src/commands/observability/descriptor.ts:49-81`) carries `id/label/description/dependencies/scaffold/setup/verify/cleanup`. The fenced-block writer (`packages/cli/src/services/observability-mutations.ts:15-54`) rewrites a delimited `.env.local` block idempotently and tracks state in `.blok/config.json`. **S7 generalizes this descriptor; S10's CLI is an S7 consumer**, not a fork of the observability one.
- **Registry/publish exists but is credential-blind** (understand-distribution.md via _DOSSIER.md:19). No field declares "this node needs auth."

Net: Blok has the *seams* (pre-execute mapper hook, descriptor+fenced-env pattern, S6 publish gate) but zero *concept* of a managed connection — and its default secret channel (`ctx.env`) is wide-open, which constrains the v1 store design.

## 3. Goals & non-goals

**Goals**
- A **declarative connection requirement** a node states in `defineNode` (the `type:"app"` equivalent), emitted into the JSON IR (D1/S1) so registry/canvas/AI see it.
- **Runtime secret injection**: the runner resolves a bound connection and hands the node *only* the credential fields it declared — never the raw secret in the workflow artifact, never in the trace, and (the corrected goal) **not casually readable by sibling node code via `ctx.env`**.
- A **connection store + binding model**: define once (`blokctl connection add stripe`), reference from N steps by name.
- A **provider catalog** (API-key shapes first; OAuth2 shape declared, refresh deferred) so common SaaS auth is declared once, reused across nodes.
- Works **uniformly across all 8 runtimes** (D8) — credentials cross the gRPC boundary as resolved fields, not a TS-only object.
- **CLI = kernel** (D7); MCP/Studio are thin layers over `blokctl connection`.

**Non-goals (ponytail — stated explicitly)**
- **No hosted OAuth broker in v1.** Blok ships the *primitive* (declare + bind + inject) with local credential storage. A hosted multi-tenant broker is a later, separately-funded surface (§9 Phase 4). `// ponytail: local store first; hosted broker only when there's a paying multi-tenant deployment.`
- **No secret-manager rewrite.** Vault/AWS-SM/Doppler are pluggable backends behind the same descriptor, *later*.
- **No `blokctl connection test` / provider `verify()` in v1.** Cut from the prior draft — it needs per-provider live-call code (a GET-balance probe per provider) for marginal value over "the next run fails with a clear error." Add when there are enough providers that pre-flight saves real debugging time.
- **No new expression language.** Connection refs are ordinary IR fields, never a `js/...` expression (D5 — deliberately keeps secrets out of the evaluated-expression surface).
- **No per-connection encryption-at-rest beyond the OS secret store in v1.** Honest statement of trust level in §8.

## 4. Options & alternatives

### Option A — Connection as a typed `defineNode` field (Pipedream `type:"app"` model)

Node declares a `connections` block; the runner resolves the binding and injects credential fields into a dedicated `ctx.auth`.

```ts
defineNode({
  name: "stripe-charge",
  connections: { stripe: { provider: "stripe" } },   // NEW
  input: z.object({ amount: z.number(), currency: z.string() }),
  output: z.object({ chargeId: z.string() }),
  async execute(ctx, input) {
    const key = ctx.auth.stripe.apiKey;               // injected, scoped to this step
    ...
  },
});
```

Author binds at the step: `{ id: "charge", use: "@acme/stripe-charge@^1", connect: { stripe: "prod-stripe" }, inputs: {...} }`.

- **How it changes Blok**: optional `connections` field on `FnNodeDefinition` (`defineNode.ts:41`); a `ctx.auth` accessor; a resolution pass in the pre-execute seam (`Blok.ts`, between :99 and :103); IR gains step `connect` + node-manifest `connections` (S1); `blokctl connection add/list/remove` as an S7 descriptor consumer; S6 publish gate validates declared `connections`.
- **Pros**: matches the proven Pipedream model 1:1; credentials never enter input/IR; clean cross-runtime story (resolved fields cross gRPC like any input); AI gets a machine-readable "needs `stripe`" contract; rotation is store-side, zero workflow edits.
- **Cons**: new top-level concept (`ctx.auth`, `connect:`); needs a provider catalog; binding is environment-specific so it must resolve **by name** against a per-machine store (a published workflow can't hardcode the binding's secret — only its name).

### Option B — Connections-as-nodes (a node returns a credential into state)

A "get connection" node runs first; downstream steps read `$.state.cred.apiKey`.

- **Pros**: near-zero new core — it's just a node + `$.state`.
- **Cons**: **the secret lands in `ctx.state`, therefore in the trace store / Studio** — a credential-leak machine, and it persists per `PersistenceHelper.applyStepOutput` default rule unless the author remembers `ephemeral: true`. No declarative contract for AI. **Rejected**: reintroduces the exact problem (secrets in the artifact/trace) the primitive must eliminate.

### Option C — Pure env-allowlist scoping (harden what exists)

Each node declares which env keys it may read; the runner narrows `ctx.env` per node via `requiresEnv: ["STRIPE_KEY"]`.

- **Pros**: smallest diff; reuses the (opt-in) allowlist machinery.
- **Cons**: still **env-key-coupled** — a marketplace node can't say "I need *a* Slack credential" without dictating the operator's env var name. No "connect once, reuse" object, no OAuth shape, no binding-by-name. Hardens *exposure*, is not a *connection* primitive — AI still can't wire auth declaratively. **Not the marketplace unlock**, but its per-node-narrowing idea is reused inside Option A's resolver (§7.3) to close the `ctx.env` leak.

### Option D — Hosted OAuth broker (full Pipedream Connect)

Blok-operated service holding OAuth tokens for N providers, serving them to runs.

- **Pros**: the actual SaaS end-state; sellable (research-nocode-market.md via _DOSSIER.md:97 — monetize managed connections, not connectors).
- **Cons**: enormous scope (stateful multi-tenant service, token refresh, per-tenant isolation); depends on a backend you don't fully own (dossier risk #1, _DOSSIER.md:97); premature before the primitive exists. This is a *backend for Option A*, not an alternative.

## 5. Recommendation & rationale

**Adopt Option A — connection as a declarative `defineNode` field with name-based binding and a pluggable backend — and fold in Option C's per-node env-narrowing inside the resolver to close the `ctx.env` leak.** Defer Option D (hosted broker). Reject Option B (leaks to trace).

Ponytail lens, run honestly:

- **Does this need to exist?** Yes, and only this. The marketplace (S6/S9), MCP install (S11), and AI-native auth wiring all dead-end without it. It is the dossier's named "missing primitive."
- **Reuse before build.** v1 reuses three shipped things: the **pre-execute mapper seam** (`Blok.ts:95-103`) for injection, the **S7 descriptor + fenced-`.env.local` writer** (`observability-mutations.ts:15-54`) for the CLI + persistence, and the **S6 publish gate** for validation. The genuinely new surface is small: a `connections` field, a `ctx.auth` accessor, a resolver, a step `connect:` field, and a thin provider catalog.
- **Smallest shippable.** Phase 1 ships **API-key connections only**, stored outside `process.env` (see §7.3 — this is the corrected design), injected via the resolver, on the **TS runtime only**. OAuth refresh, cross-runtime threading, and the hosted broker come later behind the same shapes — no rework of the IR or the node contract.

Against D1–D8: **D1/S1** — `connect:` (step) and `connections` (node manifest) are plain IR fields carrying only a *name*; the secret is never in the artifact. **D2** — orthogonal (canvas shows a connect-picker; positions unaffected). **D3/S6** — the publish gate validates declared `connections` against the provider catalog; a connection requirement is registry metadata, never an artifact. **D4/S2** — connection *providers* get scoped, version-pinnable ids (`@blok/provider-stripe@^1`) exactly like nodes. **D5/S3** — connection refs are NOT expressions; binding is by name, resolved by the runner — deliberately keeping secrets out of the `js/...` surface and away from S3's branch-`when` work. **D6/S7** — `blokctl connection` is an S7 descriptor consumer (cycle detection + config/env transaction fix inherited, not re-solved here). **D7** — MCP `blok_connection_*` tools and Studio's connect-picker (S5) are layers over `blokctl connection`. **D8/S9** — credentials cross the gRPC boundary as resolved primitive fields; each SDK exposes `ctx.auth.<name>.<field>` from the same wire shape, so a Go/Python node consumes a connection identically to a TS node.

## 6. How it improves Blok

- **Workflows become shareable/committable/AI-generatable even when they call authed APIs** — the artifact carries `connect: { stripe: "prod-stripe" }`, a *name*, never `sk_live_...`.
- **Connect once, use everywhere.** One `blokctl connection add stripe` powers 40 steps; rotation is one store edit, zero workflow changes.
- **AI wires auth autonomously.** An MCP agent installing `@acme/slack-post` reads its `connections: { slack: {...} }` contract, checks the local store, and either binds an existing `slack` connection or emits a single `blokctl connection add slack` instruction — the precise step previously human-only.
- **Secrets leave the trace AND the env.** Unlike Option B, injected credentials live on `ctx.auth` (excluded from trace persistence) AND are stored outside `process.env` so sibling node code can't grab them via the default-open `ctx.env` (closing the leak the production warning at `envAllowlist.ts:93-98` already flags).
- **Uniform across runtimes** — a Python marketplace node gets `ctx.auth.stripe.apiKey` the same way a TS one does; the D8 sandboxing differentiator now extends to "untrusted node runs in a constrained runtime *and* only sees the one credential it declared."

## 7. Architecture & design

### 7.1 Node-side declaration (`FnNodeDefinition` + `Context`)

Add `connections` to `FnNodeDefinition` (`defineNode.ts:41-77`):

```ts
export interface ConnectionRequirement {
  provider: string;              // catalog id, e.g. "stripe", "@acme/provider-foo"; version-pinnable per S2
  optional?: boolean;            // node runs without it if unbound (default false)
}
export interface FnNodeDefinition<...> {
  // ...existing...
  connections?: Record<string, ConnectionRequirement>;  // key = local handle the node reads via ctx.auth[key]
}
```

New `ctx.auth` accessor on `core/shared/src/types/Context.ts` (NOT `ctx.connection`):

```ts
/**
 * Resolved managed credentials for THIS step. Keyed by the node's
 * declared connection handle. Populated by the runner from the step's
 * `connect:` binding immediately before execute(); excluded from trace
 * persistence and ctx.state. Absent when the node declares no connections.
 */
auth?: AuthContext;   // Record<handle, Record<field, string>>
```

The injected object holds **only** the resolved fields for that provider (`{ apiKey }` or `{ accessToken, refreshToken? }`) — never the whole store.

### 7.2 Workflow-side binding (IR + TS DSL)

Step gains an optional `connect` field mapping node handles → connection names:

```ts
{
  id: "charge",
  use: "@acme/stripe-charge@^1.2.0",
  connect: { stripe: "prod-stripe" },     // node handle → connection name in the local store
  inputs: { amount: $.state.order.total, currency: "usd" },
}
```

JSON IR mirror (D1/S1), one-for-one:

```json
{ "id": "charge", "use": "@acme/stripe-charge@^1.2.0",
  "connect": { "stripe": "prod-stripe" },
  "inputs": { "amount": "$.state.order.total", "currency": "usd" } }
```

`connect` carries **only names**, resolved against the local store at run time. A workflow with `connect` is fully committable. The normalizer (S1) treats `connect` as a pass-through field — same discipline as `idempotencyKey`/`retry`.

### 7.3 The connection store (v1) — **corrected design**

The prior draft proposed storing secrets as `BLOK_CONN__<name>__<field>` env keys in `.env.local` and claimed the allowlist would hide them from `ctx.env`. **That is wrong by default**: with no allowlist configured, `getEnvForCtx()` returns `process.env` un-proxied (`envAllowlist.ts:106-113`), so any node could read `process.env.BLOK_CONN__prod-stripe__apiKey` directly and bypass the whole primitive.

Two ways to fix it; v1 takes the simpler one:

- **(chosen) Store secrets in a dedicated file the runner loads itself, NOT into `process.env`.** Two artifacts:
  - **`.blok/connections.json`** (committable, no secrets) — the manifest: `{ "prod-stripe": { "provider": "stripe", "addedAt": "...", "fields": ["apiKey"] } }`. Mirrors the `.blok/config.json` observability map.
  - **`.blok/connections.secret.json`** (gitignored, secrets) — `{ "prod-stripe": { "apiKey": "sk_live_..." } }`. Written via the same fenced/idempotent discipline as `observability-mutations.ts`, but to its own file (the env writer is line-based; a JSON secret map is cleaner here). The runner loads this file at boot into an **in-process map the resolver owns** — it is never copied into `process.env`, so `ctx.env` (open or allow-listed) cannot reach it. `.gitignore` gets `.blok/connections.secret.json` appended by `blokctl connection add` (it already manages `.env.local` ignoring).
- *(rejected for v1)* env-key storage + mandatory allowlist. It would force every operator to configure `BLOK_NODE_ENV_ALLOW` correctly or leak — making security depend on operator config. `// ponytail: own the secret file; don't make correctness hinge on an opt-in allowlist the prod warning already says most people skip.`

This is a strict improvement over today's `ctx.env.STRIPE_KEY` pattern: the secret is never in the workflow artifact, never in the trace, and not in `process.env`.

### 7.4 Provider catalog

A small shipped catalog (`@blok/providers`) declaring the credential *shape* per provider:

```ts
{ id: "stripe", label: "Stripe", kind: "apiKey",
  fields: [{ name: "apiKey", secret: true, prompt: "Stripe secret key (sk_...)" }] }
{ id: "slack", label: "Slack", kind: "oauth2",
  fields: [{ name: "accessToken", secret: true }, { name: "refreshToken", secret: true }],
  oauth: { authUrl: "...", tokenUrl: "...", scopes: [...] } }   // refresh wired in Phase 3
```

v1 ships ~10 common API-key providers under the official scope; `kind:"apiKey"` works end-to-end; `kind:"oauth2"` stores hand-pasted tokens until Phase 3 adds refresh. Marketplace providers publish as `@scope/provider-*` (D3/D4/S2). The catalog entry is itself a thin S7-style descriptor (id/fields/optional setup), so it reuses the same contract — no new abstraction.

### 7.5 Runtime resolution (the injection seam)

In `BlokService.run`, between `blueprintMapper` (`Blok.ts:95-99`) and `handle` (`Blok.ts:103`), add a `resolveConnections` step:

1. Read the node's `definition.connections` and the step's `connect` binding.
2. For each handle, look up the connection name in `.blok/connections.json`, load its fields from the resolver's in-process secret map (§7.3).
3. Build `ctx.auth[handle] = { <field>: value }` for **this step only** (set on the per-step ctx view; cleared after `handle` returns so it doesn't bleed into the next step or into `ctx.prev`).
4. Missing required connection → fail fast with a structured error: `Connection "stripe" required by step "charge" is not bound. Run: blokctl connection add stripe`. (`optional: true` → skip, leave `ctx.auth[handle]` undefined.)
5. **Per-node env narrowing (Option C fold-in):** while `ctx.auth` is the channel, the resolver also has the node's full declared surface, so it's the natural place to apply per-node `requiresEnv` narrowing in a later phase. v1 doesn't need it because secrets aren't in `process.env` at all (§7.3) — noted so we don't reintroduce env storage later.

**The hard part, stated plainly (cross-runtime):** for `runtime.*` nodes the resolved `ctx.auth` must cross the gRPC boundary. The `blok.runtime.v1` contract is additive-only (per CLAUDE.md / _DOSSIER.md:11), so this is a **new additive field on the execution-request message** carrying `{ handle: { field: value } }`, plus SDK-side code in all 8 runtimes to surface it as `ctx.auth`. This is real per-SDK work (8 implementations, D8) and is **Phase 2**, explicitly NOT Phase 1. Secrets cross one trusted hop (runner → co-located sidecar), the same threat model as every other input that already travels this wire — documented, not hand-waved.

**Trace exclusion**: `ctx.auth` is never persisted. The node-run input recorded for Studio is `inputs` only; `auth` is injected after the mapper and stripped before tracing — the same exclusion discipline as `ephemeral`. Add one regression test asserting a bound connection's secret never appears in a `node_runs` row.

### 7.6 CLI surface (S7/D7 — the kernel)

```
blokctl connection add <provider> [--name <name>]   # prompts for secret fields; writes manifest + secret file; ensures .gitignore
blokctl connection list                              # reads .blok/connections.json (names + providers, NEVER secrets)
blokctl connection remove <name>                     # removes manifest entry + secret-file entry (transaction-safe, secret-first)
```

Implemented as an **S7 descriptor consumer** — it inherits S7's cycle detection and config/secret write-ordering transaction guarantee rather than re-deriving the observability one. MCP exposes `blok_connection_list` / `blok_connection_add` (S11) over identical code paths; Studio's connect-picker (S5) calls the same. `connection test` is deferred (§3 non-goals).

### 7.7 Registry publish gate (S6)

`blokctl publish node` validates that every `definition.connections[].provider` resolves to a known catalog/registry provider id, and surfaces the requirement in the node's registry metadata so discovery/AI show "requires: stripe, slack" before install. A **lint in the publish gate** flags credential-shaped values appearing in the node's declared `output` schema (defense against a node author copying `ctx.auth.x` into its return and leaking it to state/trace).

## 8. Compatibility, migration & risks

**Backward-compat (hybrid appetite): fully additive.** `connections` on `defineNode` and `connect` on a step are both optional. Every existing `.ts`/JSON workflow and node keeps working unchanged — no `connections`, no resolver pass, no `ctx.auth`. The `$`/`js/` syntax is untouched (connection refs are deliberately not expressions, D5). **No workflow-schema version bump for v1** — the fields are pass-through in the v2 IR. A node that *uses* `connections` simply requires a newer runner — handled by S2's runtime/version negotiation, not a breaking change to authored artifacts.

**Migration**: none forced. Authors who today wire `inputs: { apiKey: ctx.env.X }` keep working. An optional `blokctl connection migrate-env` (scan workflows for hardcoded-secret-looking inputs, offer conversion) is *nice-to-have, not v1*. `// ponytail: ship the primitive; build auto-migration only if real users have hardcoded-secret workflows worth converting.`

**Failure modes & guards**:
- *Unbound required connection* → fail-fast structured error with the exact `blokctl` fix (never silent, never a bare 500).
- *Secret in `ctx.state`/trace* → prevented by construction: credentials live on `ctx.auth`, excluded from persistence and stripped before tracing. Residual footgun (author copies `ctx.auth.x` into `return`) is caught by output-Zod + the publish-gate lint (§7.7).
- *Secret readable via `ctx.env`* → **closed by storing secrets outside `process.env`** (§7.3), not by depending on the opt-in allowlist.
- *Name collision across environments* → binding is by name; dev/prod resolve the same `connect: { stripe: "prod-stripe" }` to different secret-file values per machine. Correct by design.
- *Cross-runtime secret on the wire (Phase 2)* → one trusted hop (already how every runtime input travels). **Documented trust boundary:** gRPC sidecars must be co-located/trusted, same threat model as today; do not run untrusted sidecars over an untrusted network with live credentials until a transport-encryption story exists.

**Honest trust-level statement (v1):** `.blok/connections.secret.json` is gitignored plaintext — **the same plaintext trust level as `.env.local` today**, no better, no worse. v1 does NOT add encryption-at-rest. That is acceptable because it's not a regression from the current `ctx.env`/`.env.local` baseline, and OS-keychain / Vault integration is a Phase 4 backend behind the same descriptor. This is stated so no one ships v1 believing it's a secrets vault — it isn't.

## 9. Phased implementation plan

- **Phase 1 (smallest shippable — API-key, local store, TS-only):** `connections` field on `defineNode`; `connect` on the IR + TS DSL (S1 pass-through); `resolveConnections` in the `Blok.ts:95-103` seam; `ctx.auth` (TS runtime only); `.blok/connections.json` + gitignored `.blok/connections.secret.json` loaded into the resolver's in-process map; `blokctl connection add/list/remove` as an S7 consumer; ~10 API-key providers; trace exclusion + its regression test. **This alone unblocks a TS-node connector marketplace.**
- **Phase 2 (cross-runtime):** additive `auth` field on the `blok.runtime.v1` execution-request message; expose `ctx.auth` in all 8 SDKs (D8/S9); document the sidecar trust boundary.
- **Phase 3 (OAuth + registry):** provider catalog as registry artifacts (`@scope/provider-*`, S2/S6); OAuth2 token storage + a local `blokctl connection oauth <provider>` device/redirect flow; refresh-on-expiry in the resolver; S6 publish-gate validation of declared connections; MCP `blok_connection_*` tools (S11); Studio connect-picker (S5). `blokctl connection test` (provider verify hooks) lands here if demand justifies it.
- **Phase 4 (hosted broker — separately funded):** pluggable secret backend behind the same descriptor (OS keychain → Vault/AWS-SM → a Blok-operated multi-tenant Connect-style broker, Option D). The monetization surface (_DOSSIER.md:97 — charge for managed connections, not connectors).

## 10. Open questions

1. **`ctx.auth` vs. merge-into-input.** Inject on a separate `ctx.auth` (clean separation; keeps secrets out of the input Zod schema and the recorded inputs — **recommended**) or merge resolved fields into validated `input` (one fewer concept, but risks secrets in recorded inputs)? Recommend `ctx.auth`.
2. **Binding scope: step-level only, or also workflow-level default?** `connect:` per step is explicit but verbose for 40 steps. A workflow-level `connections: { stripe: "prod-stripe" }` default that steps inherit (overridable per step) would mirror the global-middleware pattern (CLAUDE.md rule 14). **Recommend ship step-level first**; workflow-level default is a trivial additive follow-up if 40-step verbosity actually bites.
3. **Provider catalog ownership.** Ship a curated `@blok/providers` set, or open the registry from day one (typosquat risk on `provider-stripe`, which S2's mandatory scopes already mitigate)? Recommend curated official scope for the common 10; community providers under their own scopes, gated by S12 trust tiers.
4. **Encryption-at-rest in v1.** Gitignored plaintext `.blok/connections.secret.json` (= today's `.env.local` trust level) acceptable for v1, or must Phase 1 integrate the OS keychain? **Recommend match-current-trust for v1** (it is not a regression), keychain/Vault in Phase 4. Flagged honestly in §8.
5. **Does the S12 registry license cover providers + connections as first-class published artifacts?** Must be decided alongside S6/S12 before providers can be community-published (dossier risk #2, _DOSSIER.md:99).

---
*Planning document only — no repo changes made.* Load-bearing grounding refs: `core/runner/src/defineNode.ts:41-178` (node contract + no auth hook); `core/runner/src/Blok.ts:95-103` (pre-execute injection seam: mapper→validate→handle); `core/shared/src/types/ConnectionContext.ts:20-82` (`ctx.connection` is taken → use `ctx.auth`); `core/runner/src/utils/envAllowlist.ts:106-113` + `:67-85` + `:93-98` (**default path returns un-proxied `process.env`** — corrects the prior draft; drives the §7.3 secret-file design); `packages/cli/src/commands/observability/descriptor.ts:49-81` (descriptor contract S7 generalizes) + `packages/cli/src/services/observability-mutations.ts:15-54` (fenced idempotent `.env.local` writer reused as the model for the secret-file writer).
