I now have comprehensive, well-sourced material across all three platforms and all four research dimensions. Synthesizing the brief.

---

# Marketplace/Ecosystem Models: Zapier · Make · Pipedream → A Model for Blok

## How they do it (concrete)

### Pipedream — the closest analog to Blok (code-first, multi-step, open registry)

- **Registry = a Git monorepo.** All ~3,000+ apps' components live in the `components/` directory of the public `PipedreamHQ/pipedream` repo. Third parties contribute components (sources = triggers, actions = steps) by **opening a GitHub PR**. Only PR-merged components reach "verified/registry" status and become visible in the marketplace; you can also deploy private components via CLI without review. ([components overview](https://pipedream.com/docs/components), [repo](https://github.com/PipedreamHQ/pipedream))
- **Component interface is a Node.js module object** with required fields: `key`, `name`, `version`, `type` (action vs. source-when-absent), `props`, and an async `run()`. ([API ref](https://pipedream.com/docs/components/api))
- **Namespacing is enforced by the `key`**: registry components MUST follow `app_name_slug-slugified-component-name` (e.g. `slack-send-message`), unique across the whole registry. This is how collisions are prevented without a per-publisher namespace. ([API ref](https://pipedream.com/docs/components/api))
- **Auth is declarative via "app props"**: `props: { slack: { type: "app", app: "slack" } }`. Pipedream injects managed OAuth/key credentials at runtime — the component never touches secrets. They have managed auth for 3,000+ apps covering OAuth and key-based. ([overview](https://pipedream.com/docs/components), [API ref](https://pipedream.com/docs/components/api))
- **Other prop types** model the rest of the interface uniformly: user-input props (`string`/`integer`/`boolean`/`object`), interface props (`$.interface.http`, `$.interface.timer`) for how a source is invoked, and service props (`$.service.db`) for state. Sources declare a **dedupe** strategy (`unique`/`greatest`/`last`). ([API ref](https://pipedream.com/docs/components/api))
- **Versioning = semver required on every registry component** (`version: "0.0.1"`). ([API ref](https://pipedream.com/docs/components/api))
- **License = source-available, not OSS.** They moved off MIT to a custom license: you may read/modify/redistribute, but **cannot run a competing iPaaS** from the code. ([license blog](https://pipedream.com/blog/introducing-the-pipedream-source-available-license/))
- **Monetization is decoupled from the registry** (registry is free/open). Money comes from a **credits + platform-fee** model (paid plans from $29; public registry sources get a free credit per run) and from **Pipedream Connect** — an embeddable "connect your apps" widget that resells managed auth + the catalog (incl. an MCP server exposing ~10k tools to AI clients). Workday agreed to acquire Pipedream in Nov 2025. ([pricing](https://pipedream.com/docs/pricing), [Connect](https://pipedream.com/connect))

### Zapier — closed registry, heavyweight human gate, strong version discipline

- **Apps are private until reviewed.** Build via CLI or visual Platform UI; publish requires a **one-time human review** to enter the App Directory. After that you self-promote versions without re-review (automated validation still runs). ([publishing reqs](https://docs.zapier.com/platform/publish/integration-publishing-requirements))
- **Publishing gates**: app title must exactly match the real product name (no ™/®/extra words); **no duplicate integration** if an equivalent exists or if it shares the same auth+API as an existing one; you must demonstrate real usage (test Zaps from ~3 unique users, scaling to ~50 active users for full launch). ([publishing reqs](https://docs.zapier.com/platform/publish/integration-publishing-requirements), [branding](https://docs.zapier.com/integrations/publish/branding-guidelines))
- **Versioning is best-in-class semver with a managed migration path**: PATCH = invisible fixes, MINOR = additive + auto-migratable, MAJOR = breaking (forces reconnect). `promote` makes a version the public default; `migrate` moves users **only within the same major** (by %, by email, or single `--user`), and only migrates *active* (non-draft) Zaps. Labeled pre-release versions (`2.0.0-beta`) supported. ([versions](https://docs.zapier.com/platform/manage/versions), [promote](https://docs.zapier.com/platform/manage/promote), [migrate](https://docs.zapier.com/platform/manage/migrate))
- **Monetization is referral/partner-based, not rev-share on the connector**: tiered Solution Partner program (referral commissions, directory placement, badges) + Integration Partner program for app builders. ([partner program](https://zapier.com/developer-platform/partner-program))

### Make (Integromat) — JSON-config apps, slow QA gate

- **An app = 5 declarative JSON blocks**: `base` (shared HTTP settings + auth base URL), `connections` (auth definitions), `modules` (the actions/searches/triggers shown in the builder), `RPCs` (dynamic dropdowns), `webhooks`. Each module has a **Communication** tab (HTTP request), **Parameters** tab (typed user inputs), and **Output** tab (response mapping). Expressions use **IML** (Integromat Markup Language) inside the JSON. ([base](https://developers.make.com/custom-apps-documentation/basics/base), [custom apps](https://developers.make.com/custom-apps-documentation/custom-apps-documentation))
- **Publishing = formal QA review, ~4–6 weeks.** Requires logo, module descriptions per naming conventions, privacy policy. Apps are private until approved; after approval they're public to all users and the **developer owns maintenance + support**. ([request review](https://developers.make.com/custom-apps-documentation/app-review/request-app-review), [review overview](https://developers.make.com/custom-apps-documentation/app-review/overview))

## Patterns worth stealing for Blok

1. **Pipedream's "registry = public Git monorepo + PR review"** maps almost 1:1 onto Blok's vision (open, AI-native, CLI-installable). PR-as-submission gives you free version control, diff-based review, CI validation, and trust-via-history with zero bespoke infra.
2. **Namespaced keys instead of per-author namespaces** (`app-action` slug, semver required). Blok nodes already have a `name` + the runner already resolves `@blokjs/...` scoped names — extend that to `@scope/node-name@version` for marketplace identity.
3. **Declarative auth as a typed prop** (`type: "app"`). Blok's `defineNode` Zod input is the natural home: add an `auth`/connection declaration so the runner injects managed credentials and the node never sees raw secrets — this is the single biggest ergonomic win and the thing that makes a node "installable" across all runtimes.
4. **Zapier's promote/migrate semver discipline.** Blok already has rich workflow versioning; mirror Zapier's "migrate only within same major, by % or by user, active-only" for both nodes *and* published workflows.
5. **Tiered trust, not binary.** Pipedream "verified" (PR-merged) vs. private; Make "approved" vs. custom; Zapier "public" vs. private. Blok should ship 3 tiers: **local/private → community (published, unverified) → verified (reviewed/official)**, surfaced as a badge in Studio's palette.
6. **Source-available license** to keep the registry open and AI-readable while preventing a competitor from forking the whole catalog — directly relevant given Blok's "npm for Blok" ambition.
7. **The interface IS the discovery metadata.** All three derive search/categories/icons/descriptions from the component manifest itself. Blok's `defineNode({ name, description, input, output })` already carries this — make `description` + a `category`/`tags` field mandatory for publish.

## Pitfalls / criticisms to avoid

- **Make's 4–6 week human QA is a growth killer** and pushes builders to keep apps private. A heavyweight synchronous gate does not scale and contradicts "assemble a backend in a day." Prefer **automated validation + lightweight async review**, reserving human review only for the "verified" badge.
- **Zapier's "no duplicate integration" + 50-active-user bar** centralizes power and blocks experimentation/forks. For an open registry, allow competing/alternative nodes for the same service; let ratings + verification sort quality, not a gatekeeper veto.
- **Closed registries (Zapier/Make) can't be inspected by AI or forked.** Blok's AI-native goal *requires* the Pipedream-style open, readable manifest — a closed binary blob registry would defeat MCP/agent assembly.
- **Pipedream's credits model is opaque to users** (recurring confusion about what a "run" costs). If Blok monetizes execution, make the unit dead-simple and visible at author time.
- **Maintenance burden falls on publishers** (Make explicitly). An open registry accumulates abandoned nodes. Plan for **deprecation flags, last-updated/compat signals, and ownership transfer** from day one.
- **Namespace squatting / typosquatting** (npm's perennial problem). Reserve official-app names, require verified publishers for `@blok/*` style official scopes.

## Specific lessons for the Blok vision

- **Format question (vision item 8):** Make proves a **pure-JSON/declarative app** is viable and reviewable; Pipedream proves a **code module** is more expressive. Blok already supports both TS and mirrored JSON — keep both, but make the **manifest (name, version, auth, input/output schema, category) declarative and runtime-agnostic** so a Go/Rust/Python node publishes the same metadata shape as a TS node. The Zod schemas already give you the typed input/output contract Make builds by hand.
- **Marketplace = Git + CLI + Studio, three faces of one registry:** `blokctl install <node>@<version>` (npm-style), a PR-based publish flow, and a Studio palette that reads the same manifests. This satisfies "visually OR via CLI" (vision item 3) for free.
- **Managed connections are the missing primitive.** None of Blok's current node docs describe an auth/connection abstraction; adopting Pipedream's `type: "app"` prop is the unlock for the marketplace, modular triggers (item 5), and MCP install (item 6).
- **Verification via reproducible CI**, not vibes: a published node must pass `NodeTestHarness`/`WorkflowTestRunner` in CI to earn the verified badge — automatable, scales, and AI agents can read the test as the contract.
- **Monetization recommendation:** keep the registry free + source-available (drives adoption and AI-readability); monetize **hosted execution / managed connections / a Connect-style embed**, copying Pipedream — not a tax on connectors (Zapier/Make take nothing per-connector either).

## Uncertainty flags

- Zapier's exact active-user threshold is reported inconsistently across sources (one search said 3 testers + 50 for launch; another said 5). Treat the **specific numbers as approximate** — verify against the live [publishing requirements](https://docs.zapier.com/platform/publish/integration-publishing-requirements) (that page timed out twice on direct fetch, so the figures above come from search snippets, not the primary doc).
- Make's "verified badge" vs. plain "approved/public" distinction is **not confirmed** — docs confirm approved→public but I could not verify a separate verification tier or badge.
- Pipedream's per-component **rev-share to authors: none found** — registry appears unpaid/community; monetization is platform-side (credits/Connect). Stated as absence-of-evidence, not confirmed-absent.
- Workday's acquisition of Pipedream (announced Nov 2025, close ~Jan 2026) may change registry licensing/openness going forward — worth re-checking before relying on the source-available posture long-term.

## Sources (URLs)

- Pipedream components overview — https://pipedream.com/docs/components
- Pipedream Component API reference (key/namespace/version/props/auth/dedupe) — https://pipedream.com/docs/components/api
- Pipedream monorepo (PR-based contribution) — https://github.com/PipedreamHQ/pipedream
- Pipedream Source Available License — https://pipedream.com/blog/introducing-the-pipedream-source-available-license/
- Pipedream pricing/credits — https://pipedream.com/docs/pricing
- Pipedream Connect — https://pipedream.com/connect
- Zapier integration publishing requirements — https://docs.zapier.com/platform/publish/integration-publishing-requirements
- Zapier branding guidelines — https://docs.zapier.com/integrations/publish/branding-guidelines
- Zapier versions (semver) — https://docs.zapier.com/platform/manage/versions
- Zapier promote a version — https://docs.zapier.com/platform/manage/promote
- Zapier migrate users — https://docs.zapier.com/platform/manage/migrate
- Zapier partner program — https://zapier.com/developer-platform/partner-program
- Make custom apps documentation — https://developers.make.com/custom-apps-documentation/custom-apps-documentation
- Make base (5 building blocks / auth base) — https://developers.make.com/custom-apps-documentation/basics/base
- Make request app review — https://developers.make.com/custom-apps-documentation/app-review/request-app-review
- Make app review overview — https://developers.make.com/custom-apps-documentation/app-review/overview