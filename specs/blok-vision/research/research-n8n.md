I have enough concrete material across all six areas. The editor-interaction specifics are well-known from the search snippets and my knowledge of n8n; I'll flag where I'm relying on that vs. fetched docs. Compiling the brief.

---

# n8n Research Brief — for the Blok Vision

## How they do it (concrete)

### 1. Visual canvas / editor UX
- **Three-panel layout**: left/right node palette ("nodes panel", opened via the **+** in the top-right), an infinite center canvas, and a contextual properties panel. Data flows **left → right**; connection lines visually represent data movement. ([docs.n8n.io level-one ch.1](https://docs.n8n.io/courses/level-one/chapter-1/), [n8n.spot UX deep-dive](https://n8n.spot/n8n-ui-ux-deep-dive-how-thoughtful-design-streamlines-visual-automation/))
- **Build loop = Drag → Drop → Connect → Run.** Each step is one node. The signature interaction: drag from a node's **output dot**, drop on empty canvas, and the **searchable node palette opens in-context** filtered to what can connect there — so you never lose flow to go pick a node. (Well-documented n8n behavior; the UX-philosophy article confirms "progressive disclosure" but doesn't enumerate the interaction — *flagged as my knowledge, not a fetched quote*.)
- **Node Detail View (NDV)**: double-click a node → modal with three columns: **input data (left) | parameters (center) | output data (right)**, all as live JSON/table/schema views. You can **execute a single node** and immediately see its output without running the whole workflow.
- **Pinned data**: you can pin a node's output so re-runs during editing replay frozen data instead of re-hitting an API — fast iteration without burning rate limits. This pin is stored in the workflow JSON (`pinData`).
- 800+ nodes; categorized palette with search. ([docs.n8n.io level-one](https://docs.n8n.io/courses/level-one/chapter-1/), [DeepWiki: canvas & node management](https://deepwiki.com/n8n-io/n8n/6.2-workflow-canvas-and-node-management))

### 2. Node format — declarative vs programmatic
Two authoring styles, both a TypeScript class implementing `INodeType` with a `description` object:
- **Declarative (preferred default)**: JSON-ish config. You declare `properties` (UI fields) and a **`routing`** block that maps resource/operation selections directly to HTTP requests — **no `execute()` written**. n8n builds the request. "Simpler, less bug-prone, more future-proof, for REST APIs." ([docs: choose node method](https://docs.n8n.io/integrations/creating-nodes/plan/choose-node-method/))
- **Programmatic (required for non-REST)**: you implement `async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]>` — read items + params, build requests, transform data. Needed for GraphQL, external deps, data transforms, triggers. ([docs: programmatic execute](https://docs.n8n.io/integrations/creating-nodes/build/reference/node-base-files/programmatic-style-execute-method/))
- **Package shape**: npm package, `nodes/MyNode/MyNode.node.ts` + `.svg` icon, separate `credentials/*.credentials.ts` implementing `ICredentialType`. `package.json` has an **`n8n` field** listing exported nodes + credentials, requires the **`n8n-nodes-` name prefix** and the **`n8n-community-node-package` keyword**. ([Medium: building custom nodes](https://medium.com/@sankalpkhawade/building-custom-nodes-in-n8n-a-complete-developers-guide-0ddafe1558ca), [n8n-nodes-starter](https://github.com/n8n-io/n8n-nodes-starter))
- **`n8n-node` CLI**: official scaffolder/builder/runner; produces conventions-compliant nodes and is effectively mandatory for getting verified. ([docs: using n8n-node](https://docs.n8n.io/integrations/creating-nodes/build/n8n-node/))

### 3. Marketplace — templates + community nodes
- **Two distinct registries**, do not conflate:
  - **Workflow templates** ([n8n.io/workflows](https://n8n.io/workflows/)): 9,000–10,000+ community workflows, categorized (AI agents, marketing, sales, DevOps). One-click import or download JSON → "Import from File". Submission via template library; featured + affiliate-program monetization. Third-party paid marketplaces exist (ManageN8N, Gumroad, $29–$299+). ([n8n.io/workflows](https://n8n.io/workflows/), [n8n community: marketplace](https://community.n8n.io/t/new-workflow-templates-marketplace/92871))
  - **Community nodes** (code, on **npm**, tagged `n8n-community-node-package`): installed **in-app via GUI** (Settings → Community Nodes → enter npm package name) or manually.
- **Verified vs unverified split**:
  - **Unverified** = any npm package; **full machine access, can do anything including malicious actions**; self-host only by default, opt-in, with explicit risk warnings; a **blocklist** exists; report to security@n8n.io. ([docs: risks](https://docs.n8n.io/integrations/community-nodes/risks/))
  - **Verified** = manually vetted for quality + security, appear in the editor (incl. n8n Cloud). **Hard constraint: verified nodes may NOT use any runtime dependencies.** Must be built from `n8n-node` scaffolding, pass automated checks, follow UX guidelines, ship a README. From **May 1 2026**, must be published via **GitHub Actions with a provenance statement**. n8n reserves the right to reject nodes that **compete with its paid/enterprise features.** ([docs: submit](https://docs.n8n.io/integrations/creating-nodes/deploy/submit-community-nodes/), [docs: verification guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/))

### 4. Expression language + editor
- Syntax: **`{{ ... }}`** inline in any field; the field has a **fixed-value ↔ expression toggle**. ([docs/expressions cheat-sheets](https://n8narena.com/guides/n8n-expression-cheatsheet/))
- Core variables: **`$json`** (current item's JSON, shorthand for `$input.item.json`), **`$input`**, **`$('NodeName')`** / `$node` (reach into another node's output by name), **`$items`** (matching items), plus `$now`, `$today` (Luxon DateTime), `$workflow`, `$execution`, `$vars`, `$prevNode`. **Item linking / `pairedItem`** tracks which input item produced which output across nodes.
- Built-in libs exposed in expressions: **Luxon** (dates), **JMESPath** via **`$jmespath()`** for JSON querying. Plus JS string/array/date "transformation" helper methods. ([docs: expression reference](https://docs.n8n.io/data/expression-reference/) via cheat-sheet, [docs: jmespath cookbook](https://docs.n8n.io/code/cookbook/jmespath/))
- **Expression editor**: inline editing with a **Variable selector** panel to browse available data, and a **live preview** showing the resolved value against current input — author sees the actual result, not just the expression.

### 5. Workflow JSON + canvas round-trip
- A workflow = JSON with: **`nodes[]`** (each: `id`, `name`, `type` e.g. `n8n-nodes-base.httpRequest`, `typeVersion`, **`position: [x,y]`**, `parameters`, optional `credentials` ref), and a **`connections`** object **keyed by source node *name*** → `main` → array-of-arrays of `{node, type, index}` targets. Plus `settings`, `pinData`, `versionId`. ([docs: export/import](https://docs.n8n.io/workflows/export-import/), [Latenode JSON guide](https://latenode.com/blog/low-code-no-code-platforms/n8n-setup-workflows-self-hosting-templates/n8n-import-workflow-json-complete-guide-file-format-examples-2025))
- **Canvas IS the JSON**: editor serializes node positions + wires into this structure; import reconstructs the canvas exactly (positions are persisted). **Credentials are referenced by id/name, never exported** — import requires manual credential reassignment.
- **Versioning pain**: `typeVersion` per node means JSON from one n8n version can break on another when node schemas change. ([Latenode guide](https://latenode.com/blog/low-code-no-code-platforms/n8n-setup-workflows-self-hosting-templates/n8n-import-workflow-json-complete-guide-file-format-examples-2025))

### 6. Licensing
- **Sustainable Use License** (their "fair-code" model), replacing the older Apache-2.0 + Commons Clause (which they admitted was ambiguous). Source-available, free to use/extend/self-host, but **commercial use restricted** (you can't sell n8n-as-a-service or rebrand it). **Not OSI open-source** — n8n explicitly does not call itself open source. Rationale: stop cloud providers capturing value with no return. ([n8n blog: announcing SUL](https://blog.n8n.io/announcing-new-sustainable-use-license/), [docs: SUL](https://docs.n8n.io/sustainable-use-license/), [LICENSE.md](https://github.com/n8n-io/n8n/blob/master/LICENSE.md))

---

## Patterns worth stealing for Blok

1. **Declarative-first node authoring with a `routing` escape-free path.** Blok already nails this with `defineNode()` + Zod, but n8n's **`routing` block** (resource/operation → HTTP request, zero handler code) is the thing to steal: a *thin declarative HTTP node variant* where authors never write `execute()` for plain REST wrappers. Most marketplace nodes are just API wrappers — make those config-only.
2. **Two registries, cleanly separated.** Templates (workflows, data) vs Nodes (code, npm). Blok's marketplace should mirror this split exactly — different trust models, different install paths.
3. **"No runtime dependencies" as the verified-tier gate.** This single rule kills most supply-chain risk and is mechanically checkable in CI. Cheap, high-leverage trust signal. Pair with **provenance/GitHub-Actions publishing** (n8n's May-2026 move).
4. **Connection-drag-opens-palette.** The defining speed interaction. Drag from a step's output → contextual, filtered node picker. Build this into Blok Studio's canvas; it's the single biggest "feels fast" win over a static palette.
5. **NDV with live input/output + single-node execute + pinned data.** Blok already records per-step traces — surface them as an editable input|params|output panel, let users **run one step** and **pin** its output for iteration. You're 80% there via the trace store.
6. **Expression editor with variable selector + live preview.** Blok's `$.state.<id>` / `js/...` system is conceptually n8n's `$json`/`$('Node')`. Steal the **live-preview resolver** (show the resolved value of `$.state.x` against the last run's data inline) and a **clickable variable picker** that inserts the path. This directly serves Vision item #7.
7. **Positions persisted in the workflow file.** If Blok keeps `.ts`/JSON as source of truth, canvas layout must round-trip (an `x,y` per step). n8n proves the canvas-is-the-file model works.
8. **CLI scaffolder that bakes in verification conventions** (`n8n-node` → Blok's `blokctl create node`). Make the scaffold the only blessed path so "publishable" and "scaffolded" converge.

---

## Pitfalls / criticisms to avoid

1. **`typeVersion` upgrade hell.** Per-node schema versioning means shared templates silently break across versions. Blok's `version` + normalizer is better-positioned; invest early in **node-version migration shims** so marketplace workflows don't rot. (This maps directly to your existing `WorkflowNormalizer` philosophy.)
2. **Connections keyed by node *name*, not id.** Renaming a node rewrites every connection reference; fragile and diff-noisy. **Blok should key connections by stable `id`, never display name.** (Blok already uses `id` as the identity — keep it; do not let the canvas introduce name-keyed wiring.)
3. **Unverified nodes = full machine access.** n8n's own docs admit community nodes "can do anything, including malicious actions." Don't ship a marketplace without a **sandboxing/trust story**. Blok's multi-runtime containers are actually an advantage here — untrusted nodes can run in a constrained runtime, not the host process.
4. **Two node-authoring styles cause confusion.** "Declarative vs programmatic, and which do I pick?" is a recurring beginner stumble. Blok's single `defineNode()` is cleaner — **resist adding a second style.** If you add a declarative-HTTP shortcut, make it a *thin option inside* `defineNode()`, not a parallel paradigm.
5. **License backlash + relicensing churn.** n8n changed license once already amid confusion, and "not really open source" is a persistent community gripe ([architecture-weekly](https://www.architecture-weekly.com/p/why-open-source-isnt-always-fair), [scalevise](https://scalevise.com/resources/n8n-automation-license-commercial-use/)). If Blok wants a marketplace + community contributions, **pick the license once, deliberately, and document the rationale up front** — relicensing later poisons trust.
6. **"We reject nodes competing with our paid features."** This chills the ecosystem and breeds resentment. If Blok builds a marketplace, decide *now* whether the commercial model conflicts with community contributions, or you'll face the same accusation.
7. **Credentials don't travel with templates → import friction.** Every imported n8n template needs manual credential remapping. Plan Blok's template-import UX to **detect required credentials/env and prompt**, rather than silently producing a broken workflow.
8. **JSON-name-keyed connections + node-name expressions (`$('NodeName')`) couple data references to display labels.** Renaming breaks expressions too. Blok's `$.state.<id>` (id-based) is the correct choice — **do not adopt name-based references** even though they read nicer.

---

## Specific lessons for the Blok vision

- **Vision #1/#2 (Studio canvas, build new visually):** the round-trip is solvable — persist `position` per step in the existing TS/JSON workflow and the canvas becomes a pure view over the file. Build the **drag-output-→-contextual-palette** interaction and the **NDV (input|params|output + run-one-step + pin)**; Blok's trace store already supplies the data these panels need.
- **Vision #3 (marketplace):** copy the **two-registry split** (templates as JSON on a site; nodes as npm packages with a `blok-nodes-`-style keyword) and the **verified tier gated on "no runtime deps + provenance + CI checks."** That's the minimum viable trust model and it's mechanically enforceable.
- **Vision #4 (standalone versioned nodes across runtimes):** n8n is single-runtime (Node). Blok's multi-runtime is a **differentiator for sandboxing untrusted marketplace nodes** — lean into it as the security story n8n lacks. But you'll need a node-manifest/`package.json`-equivalent **per runtime** declaring inputs/outputs/version so the registry can index them uniformly.
- **Vision #5 (modular triggers):** n8n bundles triggers as just-another-node-type. Your `blokctl observability add` model is *more* modular than n8n; triggers as installable packages (`blokctl trigger add http`) is consistent and beyond what n8n offers — a genuine edge.
- **Vision #6 (AI-native):** n8n has no first-class AI-assembles-the-backend path; templates are human-curated. Blok's CLI + MCP + Skills can let an agent **install nodes and compose workflows programmatically** — n8n can't, because its source of truth is the canvas, not a clean text format. This is your moat.
- **Vision #7 (expressions ergonomics):** steal **live-preview + variable-picker**, and the **fixed/expression toggle**. Blok's `$.` proxy already beats raw `{{ }}` for typo-safety in TS; surface the same picker in Studio for JSON authors.
- **Vision #8 (is `.ts` the right format?):** n8n's answer is "JSON, canvas-generated." n8n's JSON has two specific flaws to *not* copy: **name-keyed connections** and **per-node `typeVersion` drift**. Blok's `.ts`/JSON with **id-keyed references** and a **normalizer** is structurally superior for both AI authoring and round-tripping. The lesson: keep id-based identity, add `position`, and you get canvas + code + AI all over one source of truth — which n8n cannot claim.

---

## Sources (URLs)
- n8n editor / canvas: https://docs.n8n.io/courses/level-one/chapter-1/ · https://deepwiki.com/n8n-io/n8n/6.2-workflow-canvas-and-node-management · https://n8n.spot/n8n-ui-ux-deep-dive-how-thoughtful-design-streamlines-visual-automation/
- Node building styles: https://docs.n8n.io/integrations/creating-nodes/plan/choose-node-method/ · https://docs.n8n.io/integrations/creating-nodes/build/reference/node-base-files/programmatic-style-execute-method/ · https://docs.n8n.io/integrations/creating-nodes/build/n8n-node/ · https://github.com/n8n-io/n8n-nodes-starter · https://medium.com/@sankalpkhawade/building-custom-nodes-in-n8n-a-complete-developers-guide-0ddafe1558ca
- Community/verified nodes: https://docs.n8n.io/integrations/community-nodes/risks/ · https://docs.n8n.io/integrations/creating-nodes/deploy/submit-community-nodes/ · https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/ · https://docs.n8n.io/integrations/community-nodes/installation/verified-install/ · https://blog.n8n.io/community-nodes-available-on-n8n-cloud/
- Templates/marketplace: https://n8n.io/workflows/ · https://community.n8n.io/t/new-workflow-templates-marketplace/92871 · https://www.managen8n.com/features/marketplace
- Expressions: https://n8narena.com/guides/n8n-expression-cheatsheet/ · https://docs.n8n.io/code/cookbook/jmespath/ · https://docs.n8n.io/data/expression-reference/ (now redirects)
- Workflow JSON / round-trip: https://docs.n8n.io/workflows/export-import/ · https://latenode.com/blog/low-code-no-code-platforms/n8n-setup-workflows-self-hosting-templates/n8n-import-workflow-json-complete-guide-file-format-examples-2025
- License: https://blog.n8n.io/announcing-new-sustainable-use-license/ · https://docs.n8n.io/sustainable-use-license/ · https://github.com/n8n-io/n8n/blob/master/LICENSE.md · https://www.architecture-weekly.com/p/why-open-source-isnt-always-fair · https://scalevise.com/resources/n8n-automation-license-commercial-use/

---

**Uncertainty flags:**
- Several official n8n doc URLs (`/data/expressions/`, `/data/expression-reference/`, `/integrations/community-nodes/installation/`, `/build/declarative-style-node/`) **now 404 or redirect** — n8n recently restructured its docs. Expression-variable details (`$json`, `$('Node')`, `pairedItem`, Luxon/JMESPath) are corroborated by the cheat-sheet + jmespath cookbook + search snippets and match my prior knowledge, but I could not re-fetch the canonical reference page verbatim.
- **Editor micro-interactions** (drag-output-opens-palette, NDV three-column layout, pin-data, run-one-step) come from search snippets + my knowledge of n8n, *not* a clean fetched quote — the UX deep-dive article I fetched only confirmed high-level principles. These are accurate to current n8n but treat the specific interaction names as my characterization.
- The **May 1 2026 provenance/GitHub-Actions verification requirement** comes from a search snippet of n8n's submit-nodes doc; I could not fetch the page directly to confirm exact wording.