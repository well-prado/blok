I have everything needed. Writing the brief.

---

## How they do it (concrete)

**DX — tasks are exported TypeScript functions, not graphs.** A task is `task({ id, run, retry, queue, machine, ...hooks })` from `@trigger.dev/sdk/v3`. Each task is `export`ed with a unique string `id`; `run` is the async body. The file lives in your repo next to app code, so you get IDE autocomplete, type-checking, git diffs, PRs, and any npm package as an "integration." Config knobs sit declaratively on the task: `retry: { maxAttempts, minTimeoutInMs, maxTimeoutInMs, factor }`, queues, machine specs, lifecycle hooks, schema validation. (This is almost exactly Blok's v2 step retry shape — convergent design.)

**Triggering is explicit and typed:** `tasks.trigger<typeof convertVideo>("convert-video", payload)` returns a handle immediately (fire-and-forget); `triggerAndWait()` blocks on a subtask and returns its result (orchestration); plus `batch` variants. Note: triggering is a *function call*, not a DAG edge — the control flow is plain TS (loops, conditionals, try/catch), not a declared graph. This is the deepest philosophical difference from both n8n and Blok.

**Dev mode (`npx trigger.dev@latest dev`):** task code runs *locally on your machine* while scheduling stays on the Trigger.dev server. Same esbuild build pipeline as prod, hot-rebuild on save, real debuggers/breakpoints, per-task isolated processes, auto-cancel on stop. The "same build locally and in cloud" guarantee is a big trust lever.

**Durable execution via checkpoint-resume (CRIU).** At every `await triggerAndWait(...)` or `wait.for({ seconds: 30 })`, the runtime snapshots process state with CRIU, frees the machine, and restores exactly later. No determinism constraints, no execution timeout, no workflow-replay model (unlike Temporal). Combined with idempotency keys, a failed run resumes from the failure point and reuses cached completed-subtask results. n8n has none of this — "fails completely, retry from the beginning."

**Observability is OpenTelemetry-native.** Every run page is a real-time **trace view**: spans for the task, every subtask, and every wait point, auto-correlated parent↔child. `console.log/error` flow straight into the run log. The redesigned **run inspector** has: a top status header matching the runs list, an event **timeline**, and three tabs — Overview (payload/output/errors), Detail (tags + usage/cost metrics), Context (the `ctx` second arg). Filtering by status/name/environment/tags. Alerts to email/Slack/webhooks on failure. A SQL-style query language + plain-English→query AI assistant for custom dashboards.

**Replay** is a first-class button: re-run any historical run with a *modified payload and/or different environment*, directly from the dashboard. Works for JSON and SuperJSON payloads (SuperJSON preserves Date/Map/Set/BigInt).

**Versioning & deploy.** `deploy` bundles with esbuild → ESM → Docker image. Each deploy mints an **atomic version** = immutable snapshot of *all* tasks in the project; in-flight runs keep running their old version, new triggers get the new one. Version number auto-increments per environment. Environments: DEV, PREVIEW, STAGING, PROD. **Preview branches** = isolated env per git branch; connect a GitHub repo, push to a tracked branch, auto-deploy — no CI scripting. Vercel integration gates the app deploy on the task build, pins `TRIGGER_VERSION`, so app and tasks ship in lockstep.

## Patterns worth stealing for Blok

1. **Replay-with-edited-payload as a one-click Studio action.** This is the single highest-leverage feature. Blok already records full run traces with per-step inputs/outputs; "replay this run with a tweaked body into a chosen environment" is a small addition on top of existing infra and is the killer debugging loop. SuperJSON-style typed payload preservation matters if Blok replays.
2. **Run page = trace view by default, with a timeline + tabbed inspector.** Blok's run detail should lead with the span/timeline visualization (Overview: input/output/error · Detail: tags/metadata/cost · Context: ctx), not a flat step list. Blok's nested `depth` field already maps to spans.
3. **Atomic, immutable deploy versions that don't disturb in-flight runs.** Blok's workflow definitions should be versioned as a project-wide atomic snapshot, so a redeploy never corrupts running executions. Pin the version a triggered run uses.
4. **Preview-branch environments wired to git push.** Maps cleanly onto the modular-triggers + registry vision: branch → isolated Blok env, zero CI glue.
5. **OTel-everything + SQL/NL query over runs.** Blok already has OTel counters and metadata filters (F1/F2 with operators). The natural next step is a query language over runs and an NL→query assistant — directly serves the AI-native goal.
6. **"Same build dev and prod" guarantee** + local execution with remote scheduling. Blok's `blokctl dev` should make the dev/prod-parity promise explicit.
7. **Honest comparison page as marketing.** Their `/vs/n8n` page *admits* where n8n wins (speed-to-first-workflow, integration count, native webhooks). Credible and effective.

## Pitfalls / criticisms to avoid

- **Code-first walls off non-developers.** Their own page concedes n8n owns ops-staff/non-dev builders. Pure code-first is a deliberately narrow market — Blok's "visualize AND edit on canvas" ambition is precisely the gap Trigger.dev refuses to fill. Don't copy the code-only stance; Blok's edge is being *both*.
- **No native webhook triggers** (listed as "planned"). For a workflow platform that's a surprising hole — Blok already has rich modular HTTP/Worker triggers; keep that lead.
- **Integration breadth gap.** n8n's ~hundreds of prebuilt nodes is its moat. Trigger.dev's answer ("any npm package") only works for coders. Blok's registry/marketplace (npm-for-Blok) is the right counter — but it must reach n8n-class breadth to matter, across all runtimes.
- **Community/adoption gap is real** (~14k vs ~180k GitHub stars). Code-first alone hasn't won the volume war. Visual + code + AI-native is the differentiated bet.
- **Control-flow-as-code has no canvas.** Because flow is plain TS function calls, there is *nothing to render as a graph* — you cannot meaningfully visualize a Trigger.dev task as a node diagram. This is the core tension for Blok ↓.

## Specific lessons for the Blok vision

- **The code-vs-visual tension resolves through Blok's declarative step DAG, which Trigger.dev structurally cannot have.** Trigger.dev chose imperative TS function bodies → maximal coder power, zero visualizability. Blok's workflows are a *declarative list of steps with `$.state` data edges* — that is inherently a graph, so Blok can render AND round-trip edit it on a canvas. **This is Blok's structural moat over Trigger.dev: keep the workflow definition declarative-DAG-shaped, never let it drift toward opaque imperative bodies, because that property is what makes the visual-canvas vision (#1, #2) possible at all.** Validate this is preserved as the `.ts` format question (#8) is evaluated — a format that round-trips losslessly to/from a visual graph is the real requirement, more than TS-vs-JSON.
- **Steal replay + trace-first run inspector for Studio now** — it's the fastest path to "n8n/Trigger.dev-quality Studio" (#1) and mostly sits on existing Blok trace infra.
- **Atomic versioned deploys + preview branches** feed both the registry/marketplace (#3) and modular triggers (#5): a Blok project snapshot is a versioned, shareable, installable artifact.
- **NL→query over runs and MCP-installable nodes/workflows** are the AI-native lever (#6); Trigger.dev's NL-query assistant validates the direction but stops at querying — Blok can go further to *assembling* workflows.
- Trigger.dev's `triggerAndWait` / `wait.for` / checkpoint-resume durability maps onto Blok's existing sub-workflow `wait:true/false`, delay/ttl/debounce, and crash auto-flip — Blok is already competitive on durability semantics; the gap is *presentation* (Studio) and *distribution* (registry), not the engine.

**Uncertainty flags:** The CRIU/checkpoint detail and "esbuild→ESM→Docker" build pipeline came from a secondary summary of the how-it-works page, not verbatim docs — treat the exact mechanism (CRIU specifically) as likely-but-not-100%-confirmed. GitHub star counts (~14k vs ~180k) are from third-party comparison blogs as of 2026 and approximate. The SQL-query-language + NL-assistant for custom dashboards appears on the `/vs/n8n` page but I did not fetch its dedicated docs page, so exact capabilities/limits are unverified. Staging-deploy plan gating (Hobby/Pro) is from search snippet, not the pricing page directly.

## Sources

- https://trigger.dev/docs/how-it-works
- https://trigger.dev/docs/deployment/overview
- https://trigger.dev/docs/logging
- https://trigger.dev/product/observability-and-monitoring
- https://trigger.dev/changelog/run-page-inspector
- https://trigger.dev/changelog/triggerdotdev-v3-dashboard-preview
- https://trigger.dev/vs/n8n
- https://trigger.dev/docs/migration-n8n
- https://github.com/triggerdotdev/trigger.dev
- https://www.mindstudio.ai/blog/what-is-trigger-dev-agentic-workflow-platform
- https://suhailroushan.com/blog/n8n-vs-trigger-dev