# Blok Framework — Bug & Design-Flaw SPECs

> **Status:** Awaiting your review and approval. **Nothing has been changed in the codebase** — these are proposals only.
> **Produced:** 2026-06-21 via a deep multi-agent research pass (49 agents): 7 parallel subsystem readers mapped Blok to its core, each bug got a first-hand source-confirmed root-cause + fix design, then 6 lenses hunted for *additional* design flaws which were **adversarially verified** before inclusion (29 candidates → 26 confirmed → written up as 25 sections; 3 were rejected as misreads/intended-behavior).

## How to read this

Each problem lives in its own file so you can review and approve them independently. Every bug spec follows the same template — **TL;DR → Symptom → Reproduction → Root cause (with a file:line evidence table) → Why it's a design flaw → Proposed fix → Alternatives → Files to change → Tests → Edge cases & back-compat → Effort & risk → Open questions.**

| File | What it covers |
|---|---|
| [`01-ts-middleware-registration.md`](01-ts-middleware-registration.md) | **Bug 01** — TypeScript middleware workflows are never registered with `isMiddleware` (every request 500s on the *recommended* authoring path) |
| [`02-worker-kafka-scaffold.md`](02-worker-kafka-scaffold.md) | **Bug 02** — Scaffolded worker hardcodes a Kafka adapter and crashes out of the box |
| [`03-worker-dotted-names.md`](03-worker-dotted-names.md) | **Bug 03** — Worker workflow names containing a dot throw `File type not supported` |
| [`04-additional-design-flaws.md`](04-additional-design-flaws.md) | **25 additional design flaws** discovered during the research pass, severity-ordered, each with evidence + a recommended fix |
| [`05-cross-runtime-live-test.md`](05-cross-runtime-live-test.md) | **Cross-runtime examples** — first live end-to-end test (Python3 over gRPC). Fixed a misleading `inputs` mapping in all 7 examples; documented a `contentType`-in-body leak as a follow-up |
| [`06-paga-validation-fixes.md`](06-paga-validation-fixes.md) | **Paga.eu validation pass (2026-06-23)** — 8 framework defects **fixed** (webhook custom-verifier replay, `api-call` Retry-After, broken reference deploy, multi-replica backend wiring, audit-log honesty, wildcard CORS, unauthenticated RPC mount, codegen JSON skip) + 3 SPEC-only (per-step `rateLimit`, SSE backplane, pluggable audit backend). Verified 01/02/03 already fixed. |
| [`appendix-architecture-notes.md`](appendix-architecture-notes.md) | Reference: the source-cited subsystem maps the research produced (trigger lifecycle, workflow loading, registry/middleware, DSL, CLI scaffold, worker adapters, execution/persistence) |

---

## The three known bugs (from your TASK write-ups)

| # | Bug | Severity | Blast radius | Fix surface | Est. |
|---|---|---|---|---|---|
| 01 | TS middleware never flagged `isMiddleware` (+ `workflow()` requires a trigger even for middleware, leaking a public route) | **High** | Every request 500s once `BLOK_GLOBAL_MIDDLEWARE`/`setGlobalMiddleware` points at a TS middleware | `workflow-helper` + `triggers/http` + `core/runner` (diagnostic) | ~0.5–1 day |
| 02 | Worker scaffold hardcodes `KafkaAdapter`; crashes with no broker; `this.adapter` silently overrides documented `provider`/env | **High** | Every freshly-scaffolded worker fails first run unless Kafka is up | `packages/cli` (scaffold) + worker template | ~0.5 day |
| 03 | Worker resolves config via the file-extension resolver, so dotted `domain.action` names throw `File type not supported` | **High** | Every job fails for any worker workflow following the *recommended* naming convention | `triggers/worker` (+ `core/runner/LocalStorage` defense-in-depth) | ~0.5 day |

All three were **confirmed first-hand against current source** during this pass (evidence tables in each file). A recurring meta-pattern: each bug breaks the path the framework's own docs tell authors to prefer (TypeScript workflows, the `provider`/`BLOK_WORKER_ADAPTER` config surface, dotted `domain.action` names).

---

## The 25 additional design flaws ([full detail →](04-additional-design-flaws.md))

**Severity mix:** 🔴 2 High · 🟠 13 Medium · 🟡 10 Low.

Three dominant themes emerged (this is the part you asked me to surface — flaws in how the framework is *designed*, not just isolated bugs):

1. **Trigger asymmetry (the big one).** Operational guarantees — middleware, cancellation, timeouts, crash/orphan recovery, registry population, env-var seeding — were built into the HTTP (and partly Worker) path and never generalized to `TriggerBase`. They silently do-or-don't apply depending on which transport hosts the process. This produces the two **High**-severity findings:
   - **F1 — PubSub & gRPC triggers never run the middleware chain.** An auth-gate middleware that 401s on HTTP lets the same request through unauthenticated over gRPC/PubSub. No error, no warning.
   - **F2 — The worker shares one mutable `Configuration` across concurrent jobs.** With the documented `concurrency > 1`, two jobs race the shared workflow definition — a run can execute one job's steps against another's node config.
2. **Validated-but-inert configuration.** Several documented, schema-checked fields are accepted at authoring time but ignored or rejected at runtime: `trigger.queue` (a whole dead trigger kind), `trigger.http.headers` ("validated at trigger entry" — but never checked), `trigger.http.accept` (always hardcoded to `application/json`), worker `concurrency` on the Kafka adapter, multi-trigger workflows (only the first trigger key is read).
3. **Silent miscompiles.** Non-`.strict()` step schemas drop misspelled fields, `z.union` (not `discriminatedUnion`) step validation emits misleading errors, and warn-mode mapper resolution (the default) passes literal expressions through — so author mistakes surface far from their cause.

> These are **proposals to consider**, not a mandate. Some (e.g. F1, F2, F6) point at the same root design decision — *bolt operational concerns onto each trigger's `listen()`* — and a single refactor (lift them onto `TriggerBase`) would close several at once. The appendix calls out where findings share a fix.

---

## Suggested sequencing (for when/if you approve)

1. **Quick wins, contained blast radius:** Bug 02 (scaffold), Bug 03 (worker dotted names) — both ~0.5 day, CLI/worker-local, no framework-wide change.
2. **Bug 01** — slightly broader (3 packages) but well-scoped; unblocks the documented TS middleware feature.
3. **High-severity design flaws F1 + F2** — these are correctness/security issues independent of the 3 bugs and worth prioritizing.
4. **The trigger-asymmetry cluster (F1, F5, F6, F14, + Bug 01's worker/cron variant)** — best addressed together via a shared `TriggerBase.installOperationalHandlers()` / `registerWorkflowsFromNodeMap()` refactor rather than piecemeal.
5. **Validated-but-inert + silent-miscompile findings** — lower urgency; batch as a "config honesty" cleanup (either make the field work, or remove/loudly-reject it).

---

## Approval

Pick any subset — they're independent. When you've reviewed, tell me which to implement (e.g. "do 02 and 03", "implement all three bugs", "fix F1 and F2 too") and I'll proceed with code + tests. I have not touched any source yet.
