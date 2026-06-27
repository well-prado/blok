I have everything needed across all five areas with concrete detail. Writing the brief.

---

# Windmill Research Brief — Lessons for Blok's Multi-Runtime Nodes + Hub

*Confidence note: Windmill docs are first-party and detailed, so the "how they do it" is high-confidence. Item counts (Hub at ~116 shared items, 200+ resource types, 227 integrations) are point-in-time snapshots from the live Hub and will drift. Pricing figures are as of early/mid 2026 and one summary was AI-aggregated — treat exact dollar amounts as approximate.*

## How they do it (concrete)

**Scripts are the atom; the function signature IS the contract.** Every script in any language (TypeScript/Deno+Bun, Python, Go, Bash, SQL, PHP, plus PowerShell/Rust/etc.) exposes a single `main` function. Windmill parses that function's typed arguments and *auto-derives a JSON Schema* from them, which in turn auto-generates a UI form and pre-validates inputs. The exact same mechanism works across languages — `async function main(p: string, q: {nested: string})` in TS, `def main(p: str, q: dict)` in Python, `func main(x string, ...)` in Go — all collapse to one JSON Schema. There is no separate manifest; the type annotations are the single source of truth for inputs, typing, and form generation. ([script editor](https://www.windmill.dev/docs/script_editor), [resources & types](https://www.windmill.dev/docs/core_concepts/resources_and_types))

**Flows are a DAG in a portable serialized format ("OpenFlow").** A flow is a JSON-serializable value: an input spec (same schema machinery as scripts) plus a sequence of "modules" (steps). Each step is a script (Hub reference or inline), a loop, a branch, or an approval step. The format has a published OpenAPI source of truth (`openflow.openapi.yaml`) so it's a real spec, not an internal blob. ([flow architecture](https://www.windmill.dev/docs/flows/architecture), [OpenFlow](https://www.windmill.dev/docs/openflow))

**Step-to-step data flow uses restricted JS expressions over a small, well-named surface.** Inputs bind via an "input transform" that can reach *any* prior step, not just the previous one. The vocabulary is tiny and memorable: `results.<step_id>` (output of a named step), `flow_input` (the flow's inputs), `resource(path)`, `variable(path)`. Expressions run in QuickJS (8–16x faster cold start) or Deno/V8. Heavy/non-JSON data bypasses the result graph via a `./shared` folder. ([flow architecture](https://www.windmill.dev/docs/flows/architecture))

**Resource Types are the killer abstraction: shareable, JSON-Schema-typed connectors.** A "Resource" is a stored config/credentials object; its "Resource Type" (Postgres, OpenAI, Slack…) is a JSON Schema. A script *consumes* one just by typing a parameter as that type (`main(postgres: Postgresql)`), and the value can embed secrets via `$VARIABLE` / nested resources via `$res:<path>`. 200+ resource types live on the Hub, so integration typing is reusable across every language and every workspace. Admin-workspace resource types are shared globally. ([resources & types](https://www.windmill.dev/docs/core_concepts/resources_and_types))

**The Hub is the marketplace.** Four content types — Scripts, Flows, Apps, Resource Types — each published as portable JSON/OpenFlow. Publishing is dead simple: copy the flow JSON out of the editor, paste it into the "New Flow" page; submit a script with a summary + integration + markdown description. The Windmill *team approves* submissions, after which verified items integrate directly into every workspace of every synced instance (cloud + self-hosted). Items carry a "Verified" badge to separate vetted/official from raw community. Filterable by type and by integration service. ([Hub](https://hub.windmill.dev/), [share on Hub](https://www.windmill.dev/docs/misc/share_on_hub))

**Packaging/versioning is content-addressed and immutable.** Every create/update mints a new immutable, perpetual *hash* stored in Postgres. Dependencies are pinned inline in the script file itself (`import x from 'npm:mysql2@^2.3.3/promise'`) — no `package.json` — which guarantees reproducible execution and lets a whole script ship as a single file. Cached deps propagate across workers via S3. ([Deno blog: immutable scripts](https://deno.com/blog/immutable-scripts-windmill-production-grade-ops))

**Workflow-as-code + git sync is first-class.** A `wmill` CLI with `wmill.yaml` (schema-validated, fully-commented starter via `wmill init`) does push/pull/preview and `gitsync-settings` for CI/CD in monorepos. The visual editor and the on-disk code are two views of the same OpenFlow artifact. ([workflows as code](https://www.windmill.dev/docs/core_concepts/workflows_as_code), [gitsync](https://www.windmill.dev/docs/advanced/cli/gitsync-settings))

**Flow editor UX.** Visual DAG; add steps from Hub or as inline code; three input-binding modes per field — static value, JS expression, or a **"connect" picker** that visually wires a prior step's output to an input (so you rarely hand-type `results.x`). Per-step test/preview before running the whole flow, drag-reorder with ghost previews, group/multi-select, for-loops, while-loops, branches, approval/suspend nodes. An AI chat panel builds/edits flows from natural language. ([flow editor](https://www.windmill.dev/docs/flows/flow_editor), [platform/flow-editor](https://www.windmill.dev/platform/flow-editor))

**Self-host vs cloud.** Community Edition is AGPLv3, free, unlimited executions, up to 50 users — but bundles some proprietary closed features. Self-host Enterprise (~$120/mo floor, per-dev/per-operator) adds SSO/SAML/SCIM, audit logs, Kafka/NATS triggers, worker-group isolation. Cloud: Free (1k execs/day) → Team ($10/user, unlimited) → Enterprise. ([pricing](https://www.windmill.dev/pricing))

## Patterns worth stealing for Blok

1. **Function signature → JSON Schema → UI form, uniformly across runtimes.** Blok already uses Zod for Node nodes. The lesson is to make *the typed input the only schema* in every runtime (Go struct tags, Python type hints, Rust structs) and have each SDK emit a canonical JSON Schema. That single schema then drives: input validation, Studio's auto-generated forms, the visual canvas's port typing, and Hub listing metadata. One contract, eight languages.

2. **A portable, spec'd, serializable flow format (the OpenFlow move).** Blok's vision item #8 asks whether `.ts` is the right format. Windmill's answer: the *canonical* artifact is language-neutral JSON with a published OpenAPI schema; `.ts` and the visual canvas are both just *editors* over it. Blok should pick one canonical serialized DAG (your v2 JSON already nearly is this) and make TS DSL + JSON + visual canvas all lossless projections of it. The schema being published+versioned is what makes a marketplace and a visual editor both possible.

3. **Resource Types as first-class, Hub-shared, JSON-Schema connectors.** This is the strongest single idea for Blok. Blok has nodes but no equivalent of a *typed, reusable, credential-bearing connector* shared across the registry. Define a "Resource Type" (or "Connection") primitive: a JSON-Schema'd config object with secret-injection (`$secret:...`), declared by a node simply typing a parameter as that type. 200+ of these is what makes Windmill feel like it integrates with everything. Blok's multi-runtime story gets dramatically more valuable if a `Postgresql` connection type is authored once and consumed identically from a Go node and a Python node.

4. **Content-addressed immutable versioning + inline dependency pinning.** For Blok's "standalone, versioned, easily-updatable node packages" goal: hash every node version immutably, and pin deps *inside the package* so a node is reproducible and shareable as a self-contained unit. This is exactly what lets the Hub serve a node and have it run identically everywhere.

5. **The "connect" picker over hand-typed expressions.** Blok's `$.state.<id>` / `js/...` system is powerful but error-prone (your own memory notes the `branch() when` footgun and `MapperResolutionError` traps). Windmill keeps a small named surface (`results.x`, `flow_input`, `resource()`) AND a visual picker that writes the expression for you. Blok should: (a) shrink/normalize the expression vocabulary, (b) give the future canvas a connect-picker that emits valid `$.state.<id>` so authors don't typo references.

6. **Per-step test/preview before whole-flow run.** Each Windmill step is independently runnable in the editor. Blok's `NodeTestHarness` exists but isn't wired into Studio — surfacing "run just this step with these inputs" in Studio would close a major ergonomics gap vs n8n/Windmill.

7. **Publish = export JSON, paste, get reviewed, auto-distribute.** The Hub's publish flow is friction-free precisely because the artifact is already a portable JSON blob. Blok's registry should make "share this workflow/node" a one-command (`blokctl publish`) or copy-paste-JSON operation, with a Verified/official tier.

8. **Same artifact, two interfaces (CLI/git ↔ visual).** `wmill` CLI + git sync means power users live in code and CI, casual users live in the canvas, with no fork. Blok's `blokctl` + visual canvas should be two views of the identical canonical artifact — never diverging tools.

## Pitfalls / criticisms to avoid

- **AGPL + "open-core bait-and-switch" perception.** The loudest community complaint ([open letter #5014](https://github.com/windmill-labs/windmill/issues/5014)) is that "fully open source" marketing clashes with paywalled essentials: the FOSS edition reportedly lacks **private PyPI/NPM** support and **alerting when a critical process fails** is Enterprise-only. Charging by worker count/memory on *self-hosted* (i.e., paying to use your own compute) reads as anti-self-host. **Lesson for Blok:** keep the genuinely load-bearing primitives (alerting, private registries, the observability you just shipped) in the free tier; gate org/SSO/audit, not core reliability. Don't let the registry/marketplace become a paywall over basic functionality.

- **Restricted JS expression sandbox is a footgun surface.** Even with a small vocabulary, expression-based wiring fails at runtime in ways static typing misses (Blok's own `branch when` bug is the same class). Windmill mitigates with the connect-picker; raw-expression authoring is still where users get burned. Invest in the picker + fail-fast validation rather than richer expression syntax.

- **Hub approval is a human bottleneck.** "The Windmill team approves submissions" gates community growth and means the public Hub is relatively small (~100s of shared items, not the thousands an open registry like npm has). **Lesson:** Blok should allow *unverified self-publish* (open registry, npm-style) with a separate **Verified/Official** curation layer on top — get volume from open publishing, trust from curation, rather than gating volume on a team's review queue.

- **JSON-result-only data passing forces escape hatches.** Step outputs must be JSON-serializable; large/binary data needs the `./shared` folder workaround. Blok already hit this with binary responses (`@blokjs/respond`). Design the cross-step/cross-runtime data channel for binary from day one rather than bolting it on.

- **Closed code inside the "open" CE.** Windmill ships proprietary, non-public code inside the Community Edition. This erodes trust. If Blok wants the "best modular platform in the world" reputation, a clean open/closed boundary matters.

## Specific lessons for the Blok vision

- **(Vision #4, multi-runtime versioned nodes):** Adopt the *signature-is-the-schema* + *immutable-hash* + *inline-pinned-deps* triad. Each runtime SDK emits a canonical JSON Schema from the node's typed input; each node version is content-addressed; deps are pinned in-package. That's the mechanism that makes a node a self-contained, reproducible, shareable unit across Go/Rust/Python/etc.

- **(Vision #3, registry/hub website):** Mirror Windmill's *four content types* but split the trust model differently — open self-publish for volume, a Verified tier for trust. Make the published artifact the same portable JSON Blok already uses, so "publish" is `blokctl publish` or paste-JSON. Add **Resource/Connection Types** as a first-class Hub content type — this is what turns a node registry into an *integrations* marketplace.

- **(Vision #1/#2, Studio canvas):** The canvas should edit the *canonical serialized DAG*, not a TS file. Give it the connect-picker (emits valid `$.state.<id>`), per-step test/preview (wire `NodeTestHarness` into Studio), and node-palette-from-Hub. Windmill proves visual+code coexist only if they share one artifact.

- **(Vision #7/#8, expressions & format):** Windmill's verdict: keep the canonical format language-neutral and *shrink the expression vocabulary* to a few named accessors backed by a visual picker. Blok's `$.state` / `$.req` / `$.prev` is already close to Windmill's `results` / `flow_input` — formalize it as *the* small surface, validate fast (you already default `BLOK_MAPPER_MODE=strict`), and stop expanding expression power in favor of the picker.

- **(Vision #5, modular triggers):** Windmill's Enterprise-gated Kafka/NATS triggers validate that *triggers as pluggable modules* is the right axis — and that gating the basic ones behind a paywall is the wrong move. Blok's "modular observability → modular triggers" `blokctl add/remove` direction is sound; keep the common triggers free.

- **(Vision #6, AI-native):** Windmill ships an AI flow-builder chat panel and a `write-flow` agent skill — but their real AI enabler is the *portable typed JSON artifact*. An LLM (or MCP) can emit/validate OpenFlow because it's a published schema. Blok's MCP-installable-nodes goal depends on the same foundation: a published, schema-validated canonical workflow + node format that an AI can generate and verify against.

## Sources (URLs)

- https://www.windmill.dev/docs/flows/architecture
- https://www.windmill.dev/docs/flows/flow_editor
- https://www.windmill.dev/platform/flow-editor
- https://www.windmill.dev/docs/script_editor
- https://www.windmill.dev/docs/core_concepts/resources_and_types
- https://www.windmill.dev/docs/openflow
- https://www.windmill.dev/docs/core_concepts/workflows_as_code
- https://www.windmill.dev/docs/advanced/cli/gitsync-settings
- https://www.windmill.dev/docs/advanced/cli/wmill-yaml-reference
- https://hub.windmill.dev/ · https://hub.windmill.dev/flows · https://hub.windmill.dev/resources
- https://www.windmill.dev/docs/misc/share_on_hub
- https://www.windmill.dev/docs/core_concepts/private_hub
- https://deno.com/blog/immutable-scripts-windmill-production-grade-ops
- https://www.windmill.dev/pricing
- https://github.com/windmill-labs/windmill/issues/5014 (open letter — criticism)
- https://news.ycombinator.com/item?id=35920082 (HN discussion)
- https://github.com/windmill-labs/windmill (repo/README)