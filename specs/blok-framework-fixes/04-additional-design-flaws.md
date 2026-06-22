# Additional design flaws (discovered during deep research)

This appendix documents 25 confirmed design flaws found during a deep read of the Blok framework source, each verified against current code with concrete `file:line` evidence. A dominant theme emerges: **trigger asymmetry**. The framework's operational guarantees — middleware, cancellation, timeouts, crash recovery, registry population, env-var config — were largely built into the HTTP (and to a lesser extent Worker) trigger path and never generalized, so they silently do-or-don't apply depending on which transport hosts the process. A second theme is **validated-but-inert configuration**: several documented, schema-checked config fields (`trigger.queue`, `trigger.http.headers`, `trigger.http.accept`, dotted workflow names) are accepted at authoring time but ignored or rejected at runtime. A third is **silent miscompiles**: non-strict step schemas and warn-mode mapper resolution turn author mistakes into symptoms that surface far from their cause.

## Severity table

| F# | Title | Severity | Area |
|----|-------|----------|------|
| F1 | PubSub/gRPC triggers never apply the middleware chain | High | middleware parity |
| F2 | Worker shares one mutable Configuration across concurrent jobs | High | config parity under concurrency |
| F3 | Worker retries a cancelled run instead of stopping it | Medium | cancellation parity |
| F4 | Worker job timeout doesn't abort the run (double execution) | Medium | timeout parity |
| F5 | Cron/pubsub/etc. install no crash/orphan/shutdown/janitor handlers | Medium | lifecycle parity |
| F6 | Worker/cron-only deployments have an empty WorkflowRegistry | Medium | registry population |
| F7 | Same-name/different-route workflows silently deduped in registry | Medium | registry dedup asymmetry |
| F8 | RPC mount runs any registered workflow + wrong-trigger middleware | Medium | RPC / trigger-kind asymmetry |
| F9 | Regular/control-flow step schemas silently strip unknown fields | Medium | DSL validation strictness |
| F10 | `trigger.queue` is fully validated but consumed by no runtime | Medium | dead trigger kind |
| F11 | WorkerTrigger only inspects the first trigger key | Medium | multi-trigger discovery |
| F12 | Sub-workflow "not found" error gives wrong-cause guidance | Medium | sub-workflow resolution |
| F13 | Mapper warn-mode (default) passes literal expressions through | Medium | mapper resolution |
| F14 | `BLOK_GLOBAL_MIDDLEWARE` env only seeded by HttpTrigger | Medium | global-middleware env |
| F15 | `trigger.http.headers` documented as validated but never checked | Medium | request validation |
| F16 | `workflow()` factory never enforces the envelope schema | Low | DSL envelope validation |
| F17 | JSON workflow with `middleware:true` + http trigger loses the flag | Low | middleware registration order |
| F18 | Scaffold recommends dotted names the worker resolver rejects | Low | scaffold docs vs runtime |
| F19 | Generated worker docs use v1 DSL (internally inconsistent) | Low | scaffold docs freshness |
| F20 | Queue scaffold writes conflicting ports + phantom health URL | Low | scaffold port/env consistency |
| F21 | `--examples` writes infra env for unselected triggers | Low | scaffold .env pollution |
| F22 | `V2StepSchema` is a `z.union`, emits misleading multi-arm errors | Low | step discrimination |
| F23 | Missing-middleware error hint pins author to directory scan | Low | middleware diagnostics |
| F24 | Worker `config.timeout` never flips run status to `timedOut` | Low | worker timeout taxonomy |
| F25 | Worker `concurrency` field silently ignored by the Kafka adapter | Low | worker adapter parity |

---

### F1 — PubSub and gRPC triggers never apply the middleware chain
**Severity:** High · **Area:** middleware parity

**What:** Every other trigger calls `await this.applyMiddlewareChain(ctx, this.nodeMap)` immediately before `this.run(ctx)`. The PubSub and gRPC triggers go straight from `createContext` to `this.run(ctx)` and never call `applyMiddlewareChain` anywhere in their dispatch path (zero references in either package). A workflow triggered via PubSub or gRPC executes with **no** middleware applied — not process-global, not workflow-level (`workflow.middleware: [...]`), not trigger-level.

**Why it's a design flaw:** Middleware application is a per-transport responsibility (it runs outside `run()`), so when a trigger forgets to call `applyMiddlewareChain` the omission is invisible — no error, no warning, just security/observability middleware quietly not running. The `applyMiddlewareChain` docstring itself states "Pre-v0.6 the merge code lived inline in HttpTrigger.run and worker + cron triggers silently skipped middleware. Centralising it on TriggerBase gives all three trigger families uniform semantics." That centralization migrated worker+cron but left PubSub and gRPC in the exact pre-v0.6 silently-skipping state. This directly contradicts `CLAUDE.md` rule 14 and `WorkflowRegistry.ts:71-72`, both of which state process-global middleware applies to "EVERY workflow run in the process." An auth-gate middleware that 401s on HTTP would let the same request through unauthenticated on a gRPC entrypoint.

**Evidence:** `triggers/pubsub/src/PubSubTrigger.ts:312-342` (init→createContext→run, no middleware call); `triggers/grpc/src/GRpcTrigger.ts:136-141` (same); contrast `HttpTrigger.ts:1272`, `WorkerTrigger.ts:595`, `CronTrigger.ts:389`. Docstring at `core/runner/src/TriggerBase.ts:174-176`.

**Recommended fix:** Add `await this.applyMiddlewareChain(ctx, this.nodeMap);` immediately before `await this.run(ctx)` in both dispatch paths, after `ctx.request` is populated (so middleware sees the real body/headers). Throw-propagation already works via each trigger's outer catch (PubSub ack/nack, gRPC error encode at `GRpcTrigger.ts:180`). As defense-in-depth against future regressions, move the `applyMiddlewareChain` invocation into the top of `TriggerBase.run()` so no transport can omit it, or add a boot-time assertion that every concrete subclass calls it.

---

### F2 — Worker shares one mutable Configuration across concurrent jobs
**Severity:** High · **Area:** context/config parity under concurrency

**What:** `WorkerTrigger.handleJob` calls `init()` on the single shared `this.configuration` instance, then `await this.run(ctx)` (which reads `this.configuration.steps` via `getRunner` and `.name/.trigger`), then reads `.name` again for metrics. With `concurrency > 1` (a documented, first-class worker knob honored by every adapter), two `handleJob` invocations interleave at the `await` boundaries, so job B's `init(workflow.path)` overwrites `this.configuration.steps/name/trigger` while job A is still executing against it. The same race occurs across two different worker workflows on different queues in one process.

**Why it's a design flaw:** The framework advertises per-queue `concurrency` as a first-class feature, yet keys all workflow state on a single shared `Configuration` object that `init()` mutates in place — concurrency is unsafe by construction. The most severe corruption is the `getRunner()`/`ctx.config` split: `getRunner()` reads `this.configuration.steps` live at run time (`:131`) while `createContext` captured `this.configuration.nodes` earlier (`:1544`) — a run can execute one job's step list against another job's node config, or run the wrong steps entirely. `CLAUDE.md` "Worker Workflows" documents `concurrency: 5` as supported, presuming safe parallel execution the shared mutable Configuration does not provide. (Note: HTTP has the same shared-object race but is only incidentally protected because request arrival isn't deliberately parallelized against the same trigger object the way worker concurrency is; its deep-clone only protects per-request mapper mutations, not the scalar fields.)

**Evidence:** `triggers/worker/src/WorkerTrigger.ts:553` (`init(workflow.path)`), `:602` (`run(ctx)`), `:619` (`this.configuration.name`); shared instance at `core/runner/src/TriggerBase.ts:111`; live read at `TriggerBase.ts:131`. Concurrency honored: `InMemoryAdapter.ts:205-206`, `BullMQAdapter.ts:139`, `NATSAdapter.ts:185`.

**Recommended fix:** Stop keying per-invocation state on a shared Configuration. Resolve a fresh local `const configuration = new Configuration(); await configuration.init(...)` per job and pass it explicitly into the run path (`run(ctx, configuration)` / `getRunner(configuration)`) so `getRunner` and `createContext` read the same local object. A cheaper interim: resolve each worker workflow once at `listen()`/`getWorkerWorkflows()` into a per-queue preloaded Configuration captured in the adapter closure (worker definitions are static after boot — this also removes the unnecessary per-job resolver round-trip). Add a regression test dispatching two distinct worker workflows on one trigger with concurrency>1.

---

### F3 — Worker retries a cancelled run instead of stopping it
**Severity:** Medium · **Area:** error-handling / cancellation parity

**What:** `POST /__blok/runs/:runId/cancel` cancels any `running` run regardless of trigger. For a worker job, `RunnerSteps` throws `RunCancelledError`, which `run()` deliberately re-throws untouched (status already flipped to `cancelled`). It reaches `handleJob`'s catch, which has `instanceof` branches for `DeferredDispatchSignal`, `QueueExpiredError`, and `ConcurrencyLimitError` — but **none for `RunCancelledError`** (which isn't even imported). So a cancelled run drops to the generic failure path and calls `job.fail(error, true)`, re-queueing the broker job. The deliberately-cancelled work runs again on redelivery (bounded by `maxRetries`, default 3, then DLQ).

**Why it's a design flaw:** Cancellation is a global, trigger-agnostic operator action, but the worker transport never learned to translate the cancellation signal into a terminal broker outcome — so asking to cancel a job causes it to *retry* (1..N additional full executions, re-firing non-idempotent side effects like emails/charges). `core/runner/CLAUDE.md` "Cooperative cancellation" states `RunCancelledError` "passes through ... unwrapped so TriggerBase.run's instanceof discrimination works in production" — but the worker transport never performs that discrimination, so the documented contract doesn't hold for worker runs.

**Evidence:** `triggers/worker/src/WorkerTrigger.ts:627-743` (catch with no `RunCancelledError` branch), retry at `:697-728`; re-throw at `core/runner/src/TriggerBase.ts:1212-1213`; cancel endpoint at `TraceRouter.ts:1333-1351`.

**Recommended fix:** Add a `RunCancelledError` branch to `handleJob`'s catch, before the generic `shouldRetry` block, that ACKs the broker without requeue (`await job.complete()`) since the run is already terminal. Import `RunCancelledError` from `@blokjs/runner`. Add a unit test asserting a thrown `RunCancelledError` yields `job.complete()`, not `job.fail`. Reconcile `core/runner/CLAUDE.md` which currently implies the cancel contract holds for all transports.

---

### F4 — Worker job timeout does not abort the run (double execution + orphaned record)
**Severity:** Medium · **Area:** error-handling / timeout parity

**What:** When `config.timeout > 0`, `executeWithTimeout` races `this.run(ctx)` against a `setTimeout` that rejects with a plain `Error("Job timed out...")`. On timeout it rejects the outer promise but does **not** abort `this.run(ctx)` — no signal fire, no cancellation. The original `run()` continues executing detached and still settles its own run record. Meanwhile the rejection reaches the generic catch → `job.fail(error, true)` → the broker redelivers and a **second** `run()` starts for the same job while the first is still in flight. The plain timeout `Error` is not a `StepTimeoutError`, so the run is never flipped to `timedOut`.

**Why it's a design flaw:** The worker is the only trigger with a trigger-level wall-clock timeout, and it implements it as a `Promise.race` that abandons rather than cancels the underlying work — producing concurrent duplicate executions of side-effecting workflows. The framework already ships cooperative cancellation (`ctx.signal`) and a `timedOut` run state for the per-step `maxDuration` path; the worker's own timeout ignores both, contradicting the documented timeout/cancellation model in `core/runner/CLAUDE.md`. (The orphaned record's `running` status is bounded to ~2min by `recoverOrphanedRuns`, which flips it to `crashed` — never `timedOut`.)

**Evidence:** `triggers/worker/src/WorkerTrigger.ts:753-769` (`executeWithTimeout`), dispatch at `:599-603`, generic retry at `:697-728`; `StepTimeoutError` constructed only at `RunnerSteps.ts:116`; `ctx.signal` controller stashed at `TriggerBase.ts:1558`.

**Recommended fix:** Wire the existing cancellation primitive in: when the timer fires, call `(ctx._PRIVATE_ as {abortController?: AbortController}).abortController?.abort()` before rejecting, so the detached `run()` unwinds with `RunCancelledError` at the next between-step check. Reject with a dedicated `WorkerTimeoutError` and special-case it in the catch to flip the run via `tracker.markRunTimedOut(...)` instead of a generic retry. Ensure the second `run()` cannot start until the first is actually aborted. Document that worker `timeout` now aborts cooperatively (long uninterruptible nodes should still poll `ctx.signal.aborted`).

---

### F5 — Cron (and pubsub/sse/ws/webhook/mcp/grpc) install no crash/orphan/shutdown/janitor handlers
**Severity:** Medium · **Area:** lifecycle / run-state integrity parity

**What:** Only `HttpTrigger` and `WorkerTrigger` call `installCrashHandlers`, `recoverOrphanedRuns`, `installShutdownHandlers`, and start the `Janitor`. Cron, pubsub, sse, websocket, webhook, mcp, and grpc install none. A process whose only (or primary) trigger is cron/pubsub/etc. never flips in-flight `running` runs to `crashed` on uncaught exceptions, never recovers orphaned runs on boot, never drains on SIGTERM, and never purges expired idempotency/concurrency/scheduled-dispatch rows. Separately, `CronTrigger.executeWorkflow` wraps `run()` in a catch-all with no `instanceof DeferredDispatchSignal`/`WaitDispatchRequest` branch — so a cron workflow with a `wait` step is logged as "Cron job failed" and increments `cron_errors` even though the run was correctly deferred.

**Why it's a design flaw:** These operational handlers are documented as framework-wide guarantees but are wired per-trigger in each `listen()`, so adding a trigger silently opts out. Run-state correctness and storage hygiene depend on which trigger hosts the process. `core/runner/CLAUDE.md` says crash auto-flip + orphan recovery are "Both wired into HTTP + Worker listen()" with no caveat that the other seven get none. (Because the handlers are process-global statics, a co-hosted HTTP/Worker trigger covers all triggers — so the parity gap only bites HTTP-and-Worker-less deployments. The cron signal mis-classification is unconditional but lower-impact.)

**Evidence:** `triggers/cron/src/CronTrigger.ts:139-204` (listen, no handlers); contrast `WorkerTrigger.ts:300-325`; cron catch-all at `CronTrigger.ts:421-439`; static handlers at `TriggerBase.ts:283/358/453`.

**Recommended fix:** Lift handler installation into a shared `protected installOperationalHandlers()` on `TriggerBase` (crash + orphan + janitor + shutdown, each already idempotent/kill-switched) and call it at the top of every trigger's `listen()`. Give `CronTrigger.executeWorkflow` the same signal discrimination Worker/HTTP have (treat `DeferredDispatchSignal`/`WaitDispatchRequest` as a successful deferral, not a `cron_errors` increment). Update `core/runner/CLAUDE.md` to state the handlers are installed per-trigger.

---

### F6 — Worker- and cron-only deployments have a permanently empty WorkflowRegistry
**Severity:** Medium · **Area:** registry population / trigger asymmetry

**What:** Every `WorkflowRegistry.register` call in framework source lives in `HttpTrigger`. `WorkerTrigger` and `CronTrigger` only stash the workflow map onto `this.nodeMap` and never feed the registry. Yet both call the inherited `applyMiddlewareChain`, which resolves trigger-level and process-global middleware names through `WorkflowRegistry.getMiddleware` (throws on miss). On a worker-only or cron-only process (the standalone worker scaffold never instantiates an `HttpTrigger`), the registry is empty, so any worker/cron workflow declaring trigger-level middleware, any process-global middleware, and any `subworkflow:` step fail at runtime. The registry's own header comment claims "Triggers (HTTP, future worker/cron, etc.) feed the registry at boot."

**Why it's a design flaw:** Registry population was bolted onto HttpTrigger's file-scan path rather than the shared `TriggerBase` boot sequence, creating an authoring-path asymmetry: middleware, sub-workflows, and global middleware — documented as trigger-agnostic — silently work only when an HTTP trigger is co-resident. A pure background-job deployment is the most natural place to want audit/tenant middleware and sub-workflow composition. (Calibrated medium because the break is conditional — `applyMiddlewareChain` short-circuits when no middleware names are present, so plain workflows run fine; and cron-only deployments are hand-wired since cron has no scaffold template. The worker-only case is the concretely-reachable one.)

**Evidence:** Register calls only at `HttpTrigger.ts:348/370/442/454`; `CronTrigger.ts:121-123` (`this.nodeMap.workflows = this.workflows`, no register); throw at `TriggerBase.ts:238-240`; sub-workflow lookup at `SubworkflowNode.ts:172-178`; registry comment at `WorkflowRegistry.ts:5`. Doc claims at `docs/d/reference/middleware.mdx:205-215`.

**Recommended fix:** Add `protected registerWorkflowsFromNodeMap()` on `TriggerBase` that iterates `this.nodeMap.workflows` and calls `WorkflowRegistry.register({ name, source, workflow, isMiddleware: wf.middleware === true })` for each; invoke it from `WorkerTrigger.listen()` and `CronTrigger.listen()`, and refactor `HttpTrigger` to use the same helper. Reading the `middleware: true` flag also fixes the worker/cron variant of the TS-middleware-registration bug. Update the registry header comment and docs. If deferred, at minimum emit a clear boot warning when a worker/cron process detects middleware names or subworkflow steps but performed no registration.

---

### F7 — Two workflows sharing a name but different routes are silently deduped
**Severity:** Medium · **Area:** registry dedup vs collision detection asymmetry

**What:** `WorkflowRegistry.register` is designed to throw on a name collision from a different source. But the route-table registration loop pre-empts that check with its own `registered` Set: the second entry with the same workflow name is `continue`d *before* `register()` is ever called. The route table can legitimately contain multiple distinct files whose `name:` collides on different paths. The dedupe silently keeps whichever entry sorts first by specificity; the registry's collision guard never fires. Both files still get live HTTP routes, but only one workflow object is registered for sub-workflow lookup and RPC — determined by specificity-sort order, not author intent.

**Why it's a design flaw:** The framework has an explicit, loud uniqueness invariant in `WorkflowRegistry.register`, but the primary caller routes around it with a silent pre-dedupe, so the invariant is unenforced exactly where real collisions occur. A name collision the registry was built to reject becomes an order-dependent silent shadow for sub-workflow/RPC callers. `WorkflowRegistry.ts:194-198` documents same-name-different-source as a load-time error; the route-table loop means that throw never occurs for http-routed workflows. (HTTP request routing itself is unaffected — each path runs its own object via `preloadedWorkflow`; only name-keyed resolution mis-binds.)

**Evidence:** Name-dedupe at `HttpTrigger.ts:344-347` (`if (registered.has(wfName)) continue;`) bypasses the throw at `WorkflowRegistry.ts:194-198`; specificity sort at `WorkflowRouter.ts:250-254`; name-keyed callers at `SubworkflowNode.ts:172` and `HttpTrigger.ts:700`.

**Recommended fix:** In the route-table loop, track `Map<name, source>` instead of `Set<name>`; when a name is already registered from a *different* source, emit a loud diagnostic via the existing `RoutingDiagnostics`/logger channel (surfaced at `GET /__blok/routing`) — e.g. `workflow name collision — "<name>" is claimed by <A> and <B>; only <A> is reachable as a sub-workflow / via RPC`. Keep same-source re-registration idempotent for HMR. Do not let `register()`'s hard throw fire (it would crash boot); a surfaced warning plus deterministic winner selection is the boot-tolerant fix.

---

### F8 — RPC mount runs any registered workflow by name + resolves middleware against the wrong trigger
**Severity:** Medium · **Area:** RPC mount / trigger-kind asymmetry

**What:** `POST /__blok/rpc/:name` looks a workflow up by name and runs it as long as it isn't flagged `isMiddleware` — with **no** check that the workflow has an `http` trigger. Because `scanAndRegisterMiddleware` registers non-http JSON workflows for sub-workflow lookup, a worker/cron-only workflow is reachable and executable over HTTP via the RPC mount, with no auth/trigger-surface gate (and the RPC mount has no `authorize` hook). Worse, `runWorkflowExecution` then calls `applyMiddlewareChain`, and `getTriggerType()` on an `HttpTrigger` always returns `"http"` — so a worker-triggered workflow invoked via RPC has its `trigger.worker.middleware` chain silently ignored, running with the wrong (or absent) middleware.

**Why it's a design flaw:** The RPC entrypoint treats the registry as a flat name→workflow map and ignores the per-trigger surface and per-trigger middleware semantics the rest of the framework enforces. A workflow's trigger block defines both its reachability and its middleware chain; the RPC mount bypasses the reachability filter and resolves middleware against a hardcoded `http` kind, so the same workflow gets different (and weaker) middleware depending on entrypoint — an asymmetry that can drop auth. `docs/d/reference/middleware.mdx:205-215` documents trigger-level middleware as bound to the trigger kind. (Bounded to medium: `/__blok/*` is the internal surface deployments are expected to network-isolate, and it bites only when a worker/cron-only workflow authored in scanned JSON relies on `trigger.worker.middleware` for auth.)

**Evidence:** RPC handler at `HttpTrigger.ts:698-724` (only guard `entry.isMiddleware === true` at `:701`); middleware resolution at `HttpTrigger.ts:1272` reading `getTriggerType()='http'` (`TriggerBase.ts:161-162`, `:189-191`); non-http registration at `HttpTrigger.ts:449-459`.

**Recommended fix:** Gate the RPC mount on an http-callable surface: reject (404) workflows without a `trigger.http` block, matching the route-table's `extractHttpTrigger` filter (or add an explicit `trigger.http.rpc: true` opt-in). Add an `authorize` hook to the `/__blok/rpc` mount (thread `traceAuthFn` or a dedicated `rpcAuthFn`), mirroring the trace router. If only http-triggered workflows ever run via RPC, `trigger.http.middleware` becomes the correct chain and the middleware asymmetry disappears. Update docs/SPEC to state RPC runs only http-triggered workflows.

---

### F9 — Regular/control-flow step schemas silently strip unknown fields
**Severity:** Medium · **Area:** DSL validation — step schema strictness asymmetry

**What:** `V2RegularStepSchema` and every control-flow schema (branch/forEach/loop/switch/tryCatch/subworkflow) are plain `z.object` with no `.strict()`. Parsing a step with a misplaced trigger field (`concurrencyKey`) and a typo (`retr` for `retry`) succeeds and accepts both without error. The wait step is the lone exception: it added `.strict()` plus five explicit `.never()` rejections precisely because authors carry over fields like `idempotencyKey`/`retry`/`maxDuration` from regular steps. That same reasoning applies to every step type, but only wait got the treatment.

**Why it's a design flaw:** A misspelled `retry`/`idempotencyKey`/`maxDuration`/`as`, or a trigger-level field on a step, compiles cleanly and runs with the feature silently disabled — no retry, no caching, no timeout, no rename, zero diagnostics. This is exactly the silent-miscompile class the project fights elsewhere (`BLOK_MAPPER_MODE=strict`, the wait-step `.never()` rejections). The wait-step source comment explicitly justifies its rejections — "the helpful message saves them a debugging session" — yet every other step type is left exposed. (The unknown keys aren't actually stripped from `_config` — the factory stores the original objects, so the fields survive into the runner and are then ignored; the author-visible outcome is identical.)

**Evidence:** `core/workflow-helper/src/types/StepOpts.ts:188-306` (`V2RegularStepSchema`, no `.strict()`) vs `:551-625` (`V2WaitStepSchema`, `.strict()` + `.never()`, justification comment at `:594-597`); normalizer reads only canonical names at `WorkflowNormalizer.ts:339-438`.

**Recommended fix:** Add `.strict()` to `V2RegularStepSchema` and each control-flow schema so unknown top-level keys produce an "Unrecognized key(s)" error. For high-value confusion, mirror the wait-step `.never()` pattern to reject trigger-only fields (`concurrencyKey`, `delay`, `ttl`, `debounce`) with a message pointing to the trigger config. Apply the same check in the runner-side `WorkflowNormalizer`/`WorkflowV2Schema` so JSON workflows that bypass the TS helper get the same diagnostic (warn by default, optionally throw, per the `BLOK_MAPPER_MODE` philosophy). Allow known legacy passthrough fields before flagging.

---

### F10 — `trigger.queue` is fully validated by the DSL but consumed by no runtime
**Severity:** Medium · **Area:** Trigger schema — queue vs worker

**What:** `queue` is a first-class trigger kind: it's in `TriggersSchema`, has a full `QueueTriggerOptsSchema`, and is wired into `TRIGGER_SCHEMAS`, so `workflow({ trigger: { queue: {...} } })` validates and constructs cleanly. But no `queue` trigger implementation exists (`triggers/` has only cron/grpc/http/mcp/pubsub/sse/webhook/websocket/worker). The `WorkerTrigger` discovers workflows by `triggerType === 'worker'` only, so a `trigger.queue` workflow is never picked up and never runs. The two schemas even diverge (`QueueTriggerOptsSchema` uses `topic`/`maxRetries`; `WorkerTriggerOptsSchema` uses `queue`/`retries`), so they aren't interchangeable.

**Why it's a design flaw:** The DSL advertises and validates a trigger kind that has no runtime — authors write a config the framework accepts and then silently never executes. The trap is reinforced by tooling: `AGENTS.md:34` lists a non-existent `queue/` directory, and the LSP server + vscode extension actively validate `trigger.queue`, coaching authors to fill in provider/topic for a kind nothing runs. (Note: the CLI `queue` flag scaffolds the *worker* template using `trigger.worker`, so the scaffold itself is fine — the dead config is reached by hand-authoring or following the exported `QueueTriggerOpts` type and LSP guidance.)

**Evidence:** `core/workflow-helper/src/types/TriggerOpts.ts:434-445` (`QueueTriggerOptsSchema`), registered at `:858`, in `TriggersSchema` at `:819`, validated by `validateTriggerConfig` at `:901-913`; worker discovery at `triggers/worker/src/WorkerTrigger.ts:520`; LSP at `packages/lsp-server/src/diagnostics.ts:198-218`.

**Recommended fix:** Remove `queue` from the runtime trigger surface: drop it from `TriggersSchema`, remove the `TRIGGER_SCHEMAS` entry and exported `QueueTriggerOpts` type, fix `AGENTS.md:34`, and remove the `triggerType === "queue"` branches in the LSP/vscode providers. If `queue` must stay for back-compat, have `WorkflowNormalizer` alias `trigger.queue` onto `trigger.worker` (mapping `topic→queue`, `maxRetries→retries`) so it actually runs — or, at minimum, throw a load-time error ("trigger kind 'queue' has no runtime; use 'worker'") so it fails loud. Removal is preferable to a silent alias because the schemas diverge.

---

### F11 — WorkerTrigger only inspects the FIRST trigger key
**Severity:** Medium · **Area:** Trigger discovery — multi-trigger workflows

**What:** The v2 factory validates and stores **every** key in `opts.trigger`, so `workflow({ trigger: { http: {...}, worker: { queue: 'jobs' } } })` builds with two valid triggers. But `WorkerTrigger.getWorkerWorkflows` reads only the first key: `const triggerType = Object.keys(workflowConfig.trigger)[0]` then `if (triggerType === 'worker' ...)`. If `http` (or any key) is declared before `worker`, the worker trigger is never discovered and the workflow never consumes from its queue — with no error or warning. Discovery silently depends on JS object key insertion order.

**Why it's a design flaw:** The docs explicitly promise multi-trigger workflows ("expose your workflows via multiple triggers like HTTP or gRPC—with no extra code"), and the DSL fully supports declaring multiple triggers. The runtime then quietly honors only the first-declared one, making correctness depend on declaration order — a property no author would expect to matter. WorkerTrigger is the lone outlier: `extractHttpTrigger`, SSE, and Webhook all discover by direct key access regardless of order.

**Evidence:** `triggers/worker/src/WorkerTrigger.ts:518` (`Object.keys(trigger)[0]`), gate at `:520`; multi-trigger validation at `workflowV2.ts:202-215`; sibling key-access at `WorkflowRouter.ts:258-266`, `SSETrigger.ts:460-461`, `WebhookTrigger.ts:428-429`. Doc claim at `docs/d/introduction/overview.mdx:58`.

**Recommended fix:** Replace the positional read with direct key access, matching every sibling trigger:
```ts
if (workflowConfig?.trigger?.worker) {
  workflows.push({ path, config: workflowConfig });
}
```
This discovers the worker trigger regardless of key order or how many other triggers the workflow declares. Downstream code already reads `trigger?.worker` by key, so no other change is needed. Add a regression test loading a workflow with `trigger: { http: {...}, worker: { queue: "jobs" } }` (http first) and asserting `getWorkerWorkflows()` returns it.

---

### F12 — Sub-workflow "not found" error gives wrong-cause guidance
**Severity:** Medium · **Area:** registration / sub-workflow resolution

**What:** When a `subworkflow:` step resolves a name the registry lacks, the error says: "Workflows are registered automatically by the HTTP trigger at boot — make sure the child workflow file is in the scanned directory and has `name: \"<name>\"`." Two parts mislead: (1) only JSON workflows under `WORKFLOWS_PATH/json` are disk-scanned — the framework's *recommended* TS workflows come from the static `Workflows.ts` map and are never disk-scanned, so a TS-authored child 404s while conceptually "in the scanned directory"; (2) "registered automatically by the HTTP trigger" is a dead end for a pure-worker deployment, where no HTTP trigger runs and the registry is empty (see F6).

**Why it's a design flaw:** The message hard-codes one registration path (HTTP JSON disk scan) as if it were the only one, when the framework documents and recommends a different path (TS via `Workflows.ts`) and supports trigger types that don't feed the registry. It points the author at a directory check that will pass and an HTTP trigger that may be absent — a textbook wrong-cause/dead-end error for the recommended authoring style. Contradicts `core/runner/CLAUDE.md` which documents sub-workflow lookup as "decoupled from any particular trigger." (Diagnostic flaw only — resolution works correctly once the workflow is registered; the `name: "<name>"` guidance is accurate and load-bearing.)

**Evidence:** `core/runner/src/SubworkflowNode.ts:176-178` (message); TS workflows enter only via `Workflows.ts` map at `HttpTrigger.ts:294-297`; doc at `core/runner/CLAUDE.md:221-225`.

**Recommended fix:** Rewrite the message to be registration-path-agnostic and enumerate the real paths: "(a) JSON under `WORKFLOWS_PATH/json/` is auto-scanned by the HTTP trigger; (b) TypeScript workflows must be added to your `Workflows.ts` map; (c) worker/cron-only workflows aren't picked up by the HTTP route scan — register them explicitly via `WorkflowRegistry.getInstance().register({ name, source, workflow })` at boot. Verify the workflow's `name` matches `<name>` exactly." Ideally pair with the F6 fix (feed the registry from all triggers), which makes option (c) unnecessary.

---

### F13 — Mapper warn-mode (the default) passes literal expressions through
**Severity:** Medium · **Area:** mapper / input resolution

**What:** In the default `warn` mode, when a `js/...` or `${...}` step input fails to resolve (typo, undefined access), the mapper logs a `[blok][mapper] Failed to resolve ...` warning and then **returns the literal expression string** to the node. The run continues; the node receives e.g. the raw string `"js/ctx.state.user.id"` and typically fails later with a node-specific error (Zod validation, a 500 from a bad downstream URL) at a step that is *not* where the real problem is. The author sees the node's error as the headline failure; the actual cause (a bad ctx path in a different step's inputs) is decoupled from the surfaced symptom.

**Why it's a design flaw:** The default behavior turns a precise, well-located mapper error into a silent miscompile whose symptom appears at a different step under a different (node-authored) error message — the canonical misleading-error pattern. The framework acknowledges this in code comments ("silent miscompiles ... have historically been a major source of subtle bugs") and `core/runner/CLAUDE.md` recommends `BLOK_MAPPER_MODE=strict` for production — yet ships `warn` (pass-through) as the default, contradicting its own recommendation. (The failure isn't fully silent — a structured warning with workflow/step/expression/hint goes to console and Studio — but it's buried and decoupled from the node's headline error. The warn default is a deliberate v1 back-compat choice with a one-env-var escape hatch.)

**Evidence:** `core/shared/src/utils/Mapper.ts:84-89` (`readMode()` defaults `warn`), pass-through return at `:371`, warn branch at `:385-386`; node re-throw only on `MapperResolutionError` at `NodeBase.ts:204-223`. Doc at `core/runner/CLAUDE.md:885-888`.

**Recommended fix:** Make the safe behavior the production default. Either (A) flip `readMode()`'s fallback to `strict` so unresolvable expressions fail fast with precisely-located `MapperResolutionError`s; or (B) keep `warn` as the library default but have the CLI scaffold write `BLOK_MAPPER_MODE=strict` into the generated production `.env` (or default to strict when `NODE_ENV==="production"` unless overridden). As a low-risk interim (C), in warn mode record which inputs were passed through as literals and, when the consuming node throws, append "input `<key>` was an unresolved expression `js/...`: `<hint>`" to the surfaced error so symptom and cause re-couple.

---

### F14 — `BLOK_GLOBAL_MIDDLEWARE` env var is only seeded by HttpTrigger
**Severity:** Medium · **Area:** Process-global middleware / env-var precedence

**What:** Process-global middleware is documented as applying to "EVERY workflow run in the process" with an "Env-var fallback: `BLOK_GLOBAL_MIDDLEWARE`." The env-var-to-registry seeding lives **only** in `HttpTrigger.listen()`. `WorkerTrigger` never reads `BLOK_GLOBAL_MIDDLEWARE`, yet `WorkerTrigger.handleJob` still calls `applyMiddlewareChain`, which reads `WorkflowRegistry.getGlobalMiddleware()`. In a worker-only deployment (no HttpTrigger in the process), the registry's global chain is never populated from env, so `BLOK_GLOBAL_MIDDLEWARE` is silently dropped and the worker applies an empty global chain.

**Why it's a design flaw:** A documented process-wide env-var configuration silently takes effect or not depending on which trigger type boots, with no error or warning. An operator deploying a pure background-worker service sets `BLOK_GLOBAL_MIDDLEWARE` for audit/request-id correlation and gets nothing — honored by HTTP, silently ignored by worker — contradicting `CLAUDE.md` rule 14. (Bounded to medium: the programmatic `setGlobalMiddleware([...])` API works on any trigger, so only the env-var surface is broken; and co-hosted HTTP+worker processes mask the gap.)

**Evidence:** Env seeding only at `HttpTrigger.ts:633-642`; consumer at `WorkerTrigger.ts:595` → `TriggerBase.ts:196-197`; no `GLOBAL_MIDDLEWARE` reference anywhere in `WorkerTrigger`.

**Recommended fix:** Extract the seeding block into a shared `protected seedGlobalMiddlewareFromEnv()` on `TriggerBase` (guarded by the existing `getGlobalMiddleware().length === 0` idempotency check, preserving programmatic-takes-precedence semantics) and call it from `WorkerTrigger.listen()` and the other sibling triggers' `listen()`, replacing the inline HTTP block with the same call. As a minimum-fix alternative, place the seeding once in `TriggerBase.run()` behind a process-level "already seeded" flag so no transport can forget it.

---

### F15 — `trigger.http.headers` documented as validated but never checked
**Severity:** Medium · **Area:** HTTP trigger / request validation

**What:** The HTTP trigger schema declares a `headers` field described as "Required headers for incoming requests (validated at trigger entry)." The request path validates only the HTTP method and path (catch-all route), then builds `ctx.request` copying all incoming headers verbatim — but **never reads** `this.configuration.trigger.http.headers` to enforce that the documented required headers are present. A grep for header-validation logic turns up nothing. An author who declares required headers expecting the trigger to reject requests missing them gets no enforcement.

**Why it's a design flaw:** A config field whose description explicitly promises trigger-entry validation is a complete no-op. Unlike a silently-absent feature, this one actively claims to be a request-gating mechanism, so an author may rely on it as an auth/version-header precondition that is never checked — a security-relevant false sense of enforcement. (Explicit routes skip even the method/path checks and rely on Hono, so the unenforced-headers gap applies to both route classes. The OpenAPI generator reads `trigger.http` but only method/accept/path, so the field has zero readers anywhere.)

**Evidence:** Schema at `core/workflow-helper/src/types/TriggerOpts.ts:354-357`; request path validates method/path only at `HttpTrigger.ts:1229-1233`, copies headers verbatim at `:1248`; the field is never consulted in the request path.

**Recommended fix:** Either (A) implement the promised validation — after building `ctx.request`, read `this.configuration.trigger.http.headers`, check each declared key (case-insensitive) for presence (and exact match if a non-empty string value is declared), and throw a structured error mapped to 400/412 on a missing required header, applying it on both explicit and catch-all paths; or (B) if header gating is out of scope, change the description to say the field is for documentation/OpenAPI only and not enforced, so authors don't rely on non-existent enforcement. Given the security framing, (A) is preferable; tighten the value type from `z.any()` to `z.string()` if exact-match is added.

---

### F16 — `workflow()` factory never enforces the envelope schema
**Severity:** Low · **Area:** DSL validation — v2 factory vs WorkflowV2Schema

**What:** The v2 `workflow()` factory validates only per-step shapes and per-trigger config. It never runs `WorkflowV2Schema` and never checks `opts.name`/`opts.version` beyond a `typeof opts === 'object'` guard. So `workflow({ name: 'x', version: '1', ... })` constructs successfully despite the schema declaring `name.min(3)` and `version.min(5)`. Worse, `WorkflowV2Schema` is never enforced anywhere at load/normalize time either — its only non-test consumer is `scripts/build-schema.ts` (JSON-Schema generation for editors). Every envelope-level rule the schema documents is cosmetic for both TS and JSON workflows.

**Why it's a design flaw:** The framework ships a v2 envelope schema with documented constraints, exports it, documents it, and JSON-Schema-publishes it for editor tooling — yet no code path enforces it. The v1 path is asymmetric and stricter (`Workflow()` calls `WorkflowOptsSchema.parse(config)`), so the recommended v2 path is the *less*-validated one. (Calibrated low: the only unenforced rules are cosmetic — name length, version format — and execution-safe; the consequential rules, trigger-required and valid trigger kind+config, *are* enforced imperatively in the factory.)

**Evidence:** Factory body at `core/workflow-helper/src/components/workflowV2.ts:182-234` (steps at `:192`, triggers at `:207-214`, no envelope check); schema at `WorkflowOpts.ts:64-91`; v1 enforcement at `Workflow.ts:5`.

**Recommended fix:** Make the v2 factory the single envelope enforcement point, mirroring v1: after compiling steps, validate the scalar envelope fields (`name.min(3)`, `version.min(5)`) directly (avoiding double trigger validation) and throw a clear `workflow("<name>") failed validation: <zodMessage>`. Alternatively, enforce `WorkflowV2Schema` once at the runner's load boundary (`Configuration.init` after `normalizeWorkflow`) so both TS-helper and JSON/YAML paths are validated uniformly. Reconcile the docs/`.describe()` strings with whatever is actually enforced.

---

### F17 — JSON workflow with `middleware: true` AND an http trigger loses the isMiddleware flag
**Severity:** Low · **Area:** middleware registration / registration order

**What:** `buildFileBasedRoutes` registers in two passes against one shared `registered` Set. Pass 1 walks the route table and registers every http-routed workflow **without** `isMiddleware`, adding its name to `registered`. Pass 2 is the only pass that sets `isMiddleware: true`, but it skips any name already in `registered`. So a JSON workflow declaring both `middleware: true` AND an `http` trigger enters the route table in pass 1, gets registered as non-middleware, and is then skipped by pass 2 — permanently `isMiddleware: false`. The recovery pass cannot repair it (it bails on the existing same-source entry). At dispatch, `getMiddleware` returns undefined and `runMiddlewareChain` 500s if the name is referenced — and the workflow is simultaneously exposed as a public HTTP route.

**Why it's a design flaw:** `isMiddleware` is a marker the registration code must opt a workflow into, but the only pass that sets it runs after and is gated by the pass that registers routed workflows, with a shared dedupe Set that conflates "already routed" with "already correctly classified." Route presence wins the race and silently strips the middleware capability. Contradicts `WorkflowRegistry.ts:56-63`, which documents `isMiddleware` as set when the workflow "has `middleware: true` set at the workflow root." (Low because the trigger condition is narrow and self-inflicted — the canonical convention is that middleware workflows are trigger-less, and the v2 `workflow()` helper drops the `middleware` field entirely, so this requires hand-authored, self-contradicting JSON; the 500 only manifests if the demoted name is actually referenced.)

**Evidence:** Pass 1 route-table register at `HttpTrigger.ts:344-353` (no `isMiddleware`); Pass 2 guard at `:368`; recovery same-source bail at `:435`; `extractHttpTrigger` ignores `middleware` at `WorkflowRouter.ts:258-266`.

**Recommended fix:** In the Pass-1 route-table loop, set the flag from the workflow object: `isMiddleware: (r.workflow as { middleware?: unknown })?.middleware === true` — this single change (the same one-liner as the known TS-middleware bug) fixes both cases. Defense-in-depth: in `buildRouteTable`/`extractHttpTrigger`, skip workflows whose root `middleware === true` so a middleware workflow is never exposed as a public route even with a trigger block; and in `WorkflowNormalizer` (near the existing mutual-exclusion check), warn or strip the trigger when `middleware: true` is combined with a trigger.

---

### F18 — Scaffold recommends dotted `domain.action` names the worker resolver rejects
**Severity:** Low · **Area:** CLI scaffold — generated docs vs runtime resolution

**What:** The scaffold writes a CLAUDE.md/AGENTS.md into every generated project instructing the user/LLM to "Prefer a dotted `domain.action` convention" with exemplars `countries.list`, `users.create`, `orders.refund`. But any workflow resolved through the resolver path — notably the worker trigger, which calls `configuration.init(workflow.path, ...)` → `LocalStorage.get` — treats the first dot as a file-extension delimiter: `orders.refund` yields tail `refund`, not in the supported file-type set, throwing "File type not supported" at load.

**Why it's a design flaw:** The scaffold generates authoritative project documentation that steers users into a naming convention the framework's own worker path cannot resolve. Independent of the underlying `LocalStorage` parser behavior, this is a self-inflicted doc-vs-runtime contradiction baked into generated guidance (also corroborated by the on-disk `TASK-worker-trigger-fixes.md` Problem 2). (Important precision: the dotted convention applies to the workflow `name`, and the worker resolver parses the `Workflows.ts` **map key**, not `name` — so the bug fires only when the map key is dotted, not when only `name` is dotted. The candidate's "guarantees a first-run failure" framing is therefore overstated.)

**Evidence:** Generated docs at `packages/cli/src/commands/create/utils/Examples.ts:808-815` (and CLAUDE.md template), written at `project.ts:1024-1025`; resolver dot-parsing at `core/runner/src/LocalStorage.ts:20-31`; worker passes `workflow.path` (map key) at `WorkerTrigger.ts:553`.

**Recommended fix:** Fix the runtime, not just the docs: make `LocalStorage.get` tolerant of non-file-extension dots — only strip a trailing segment as a file type when it's actually in `this.fileTypes`, otherwise leave the identifier intact and fall through to the in-memory locator. Even better, resolve worker workflows from the in-memory `this.nodeMap.workflows` the way the HTTP trigger does (the worker already holds every workflow and needlessly round-trips through the file resolver). Secondarily, add a one-line caveat in the generated docs clarifying the convention applies to `name` and that `Workflows.ts` map keys should stay dot-free until the resolver fix lands. Fold into the existing `TASK-worker-trigger-fixes.md` Problem 2.

---

### F19 — Generated worker docs use legacy v1 DSL (internally inconsistent)
**Severity:** Low · **Area:** CLI scaffold — generated docs freshness

**What:** The CLAUDE.md/AGENTS.md the scaffold writes documents the Worker trigger with the legacy v1 builder DSL — `Workflow({...}).addTrigger("worker", {...}).addStep({ name, node, type, ... })` — even though the same generated doc declares v2 `workflow({...})` / `id`+`use` canonical and the actual worker template file it ships is authored in v2.

**Why it's a design flaw:** The scaffold ships authoritative AI-context docs that are internally inconsistent: v2 declared canonical, v2 template code shipped, yet the worker examples hand-written in deprecated v1. An LLM or developer following the generated docs may author on the deprecated surface. (Important: the v1 DSL is still exported and normalized at load — the v1 example *works*, it is deprecated, not broken. Two of the candidate's sub-claims — "beanstalk is not a valid provider" and "{ provider, topic } is the wrong shape" — are **misreads**: those lines describe the separate `queue` trigger, where `beanstalk` and `{ provider, topic }` are correct per `QueueProviderSchema` / `QueueTriggerOptsSchema`. There is no load failure.)

**Evidence:** v1 worker examples at `packages/cli/src/commands/create/utils/Examples.ts:873-882` and `:1058-1063`; v2 declared canonical at `:92/:707-708/:1013`; v1 `Workflow` builder still exported at `core/workflow-helper/src/index.ts:140`; shipped v2 template `triggers/worker/template/src/workflows/jobs/process-job.ts`.

**Recommended fix:** Rewrite the two worker examples in the generated docs to v2 to match the rest of the doc and the shipped template (`trigger: { worker: { queue: "background-jobs" } }`, `id`/`use` steps). Optionally relabel the providers line to distinguish the `queue` trigger's enum from the `worker` trigger's providers (`in-memory, nats, bullmq, kafka, rabbitmq, sqs, redis, pg-boss`) so a reader doesn't apply the queue list to a `worker` trigger. No change is needed to the `{ provider, topic }` queue-row — it is correct.

---

### F20 — Queue scaffold writes conflicting ports + prints a phantom health URL
**Severity:** Low · **Area:** CLI scaffold — port/env consistency for worker/queue

**What:** For `--triggers queue`, the base `.env.local` is seeded from the worker template's `.env.example` (hardcodes `PORT=4008`), while `createTriggerConfig("queue")` assigns port 4005 and appends `TRIGGER_QUEUE_PORT=4005`. The resulting `.env.local` carries both `PORT=4008` and `TRIGGER_QUEUE_PORT=4005`, and the `queue` vs `worker` aliases map to different ports (4005 vs 4008) for the identical scaffolded worker. Compounding this, the scaffold and dev server print `http://localhost:<port>/health-check` as the worker/queue endpoint, but `WorkerTrigger.listen()` is a broker consumer that never calls `serve()` or binds any HTTP port — so the URL points at nothing (connection-refused).

**Why it's a design flaw:** The scaffold emits internally contradictory configuration and advertises a health endpoint the worker process structurally cannot serve. (Calibrated low: cosmetic — affects console output and an inert config file, not runtime. Worth noting the PORT values are fully inert: the worker reads neither `PORT` nor `TRIGGER_*_PORT` — only `REDIS_PORT` — so there is no real "which port wins" question, just dead values. The substantive user-facing facet is the phantom health URL.)

**Evidence:** Template `triggers/worker/template/.env.example:3` (`PORT=4008`); port assignment at `packages/cli/src/services/runtime-setup.ts:446` (queue→4005) vs `:449` (worker→4008); env append at `project.ts:941-944`; phantom URL at `project.ts:1068` and `dev/index.ts:196`; worker binds no port at `WorkerTrigger.ts:236-364`.

**Recommended fix:** In the print layer, special-case worker/queue (and pubsub, also a broker consumer) to print a non-HTTP line like `Worker Trigger: consumes queue '<queue>' via <provider> (no HTTP endpoint)` instead of a `/health-check` URL. Eliminate the dead PORT noise: drop `PORT` from the worker template `.env.example` and skip emitting `TRIGGER_QUEUE_PORT`/`TRIGGER_WORKER_PORT` for broker-consumer triggers, since the worker reads none of them.

---

### F21 — `--examples` writes infra env for triggers/demos the user didn't select
**Severity:** Low · **Area:** CLI scaffold — .env.local pollution

**What:** When `--examples` is set, the scaffold appends a fixed env block containing `REDIS_URL`, `STRIPE/GITHUB/LINEAR_WEBHOOK_SECRET`, and `BLOK_WORKER_ADAPTER=in-memory` + `NATS_SERVERS`. The block is gated only on `examples`, never on whether the corresponding triggers were chosen: a default HTTP-only `--examples` project gets webhook-provider secrets (no webhook trigger) and a worker adapter + NATS var (no worker trigger). The block's own inline comments scope these to specific trigger combinations, yet the code writes them unconditionally.

**Why it's a design flaw:** The scaffold's own comments declare these vars belong to specific trigger combos, but the implementation ignores `selectedTriggers`. This is the "env vars written implying infra the user didn't choose" footgun — and the codebase already has the correct gating pattern in `getProviderEnvVars`, which the `--examples` block simply doesn't follow. (Low: values are inert placeholders/localhost defaults — no boot failure, no secret leak. Note `REDIS_URL` is *correctly* relevant for an HTTP `--examples` project because the chat-memory demo is HTTP-triggered and genuinely needs Redis; the truly orphaned vars are the webhook secrets and the worker adapter/NATS var.)

**Evidence:** Unconditional block at `packages/cli/src/commands/create/project.ts:960-991` (REDIS at `:970`, webhook secrets at `:977-979`, worker adapter/NATS at `:986-987`); scoping comments at `:972`/`:981`; correct trigger-gated pattern at `:2173-2179`.

**Recommended fix:** Split the block into trigger-scoped segments. Always write the OpenRouter + REDIS_URL chat segment under `if (examples)` (the chat demos are HTTP and always present). Wrap the webhook secrets in `if (examples && selectedTriggers.includes("webhook"))` and the worker segment in `if (examples && (selectedTriggers.includes("worker") || selectedTriggers.includes("queue")))`, matching the comments and the existing `getProviderEnvVars` pattern.

---

### F22 — `V2StepSchema` is a `z.union` — malformed control-flow steps emit misleading multi-arm errors
**Severity:** Low · **Area:** DSL validation — step discrimination

**What:** `V2StepSchema` is a `z.union([...])` with `V2RegularStepSchema` as the last (catch-all) member, discriminated only by key-presence type guards rather than a Zod discriminator. A branch step missing its `when` (`{ id: 'route', branch: { then: [] } }`) does not produce a clean "branch.when is required" error — Zod tries every union member and reports an `invalid_union` aggregating both the branch error AND the regular-step `use` Required error. The factory surfaces `parsed.error.message` verbatim, so an author who clearly wrote a branch is told, among other noise, that `use` is required — a field unrelated to branches.

**Why it's a design flaw:** Zod offers `z.discriminatedUnion` for exactly this case; a plain union throws away discriminator information at error time, producing a confusing multi-branch error that points at the wrong step type — especially harmful for LLM-generated workflows, an explicit design goal. (Calibrated low: the recommended authoring helpers — `branch()`, `forEach()`, `switchOn()`, `loop()`, `tryCatch()` — each throw a clean, targeted, single-line error *before* `V2StepSchema` runs, so the noisy path is hit only by hand-written raw object literals. JSON workflows go through `WorkflowNormalizer` and never hit this union.)

**Evidence:** `core/workflow-helper/src/types/StepOpts.ts:866-877` (`z.union`), consumed at `workflowV2.ts:191-197`; type guards at `StepOpts.ts:892-973`; helper-level clean errors at `branch.ts:55-59`.

**Recommended fix:** (A) Replace the plain union with a small custom `z.ZodType` wrapper that inspects key presence (reusing the existing `isBranchStep`/`isWaitStep`/etc. guards), delegates to exactly one member schema, and returns that single schema's error verbatim. Or (B), cheaper: in `workflowV2.ts:191-197`, detect step kind by key presence before parsing and parse against the specific member schema so the surfaced message is single-membered. Given the narrow blast radius, (B) is the pragmatic minimal change.

---

### F23 — Missing-middleware error hint pins author to a scanned directory
**Severity:** Low · **Area:** middleware diagnostics

**What:** When a middleware name in the chain isn't found, the error reads: "... Make sure the middleware workflow has `\"middleware\": true` set at the workflow root and is in a scanned `WORKFLOWS_PATH` directory." This pins the author to one mechanism (directory scan) and never mentions the most common actual causes that have nothing to do with directory scanning: a typo in a `BLOK_GLOBAL_MIDDLEWARE` name, a middleware whose `middleware: true` flag is correctly set but whose *name* differs from the chain entry, or any programmatically-registered middleware. The `Available middleware: (none registered)` text reinforces a false "my scan isn't finding files" conclusion when the real cause may be a name mismatch.

**Why it's a design flaw:** The error couples its remediation advice to one registration implementation (JSON directory scan) when the registry is fed from multiple sources (`setGlobalMiddleware([...])`, `BLOK_GLOBAL_MIDDLEWARE` env — both typo-prone and directory-independent), and omits the most common cause for an already-flagged middleware: a name mismatch between the chain entry and the registered workflow name. It points the author at the filesystem instead of at the names. The sibling `SubworkflowNode` not-found error demonstrates the correct pattern (it tells the author the registered workflow must have `name: "<name>"`). (Low: cosmetic/observability — the framework correctly fails on an unresolvable name; only the guidance is incomplete, and the `Available middleware: <names>` listing does let a careful operator diff for a mismatch.)

**Evidence:** `core/runner/src/TriggerBase.ts:238-239` (message); env path at `HttpTrigger.ts:633-642`; programmatic path at `WorkflowRegistry.ts:167-170`; better sibling message at `SubworkflowNode.ts:177`.

**Recommended fix:** Broaden the hint to cover all registration paths and the name-match requirement: "Check that (a) the chain entry name `<mwName>` exactly matches a registered workflow's `name` (typos in `BLOK_GLOBAL_MIDDLEWARE`/`setGlobalMiddleware()`/`trigger.<kind>.middleware` are the most common cause), and (b) that workflow has `\"middleware\": true` and was registered (via a scanned `WORKFLOWS_PATH` directory or programmatically). Registered middleware: `<knownStr>`." Optionally add cheap boot-time validation in `HttpTrigger.listen()` that resolves each middleware name against the registry once and warns on any unresolved name, so typos surface at boot instead of on the first request.

---

### F24 — Worker `config.timeout` never flips run status to `timedOut`
**Severity:** Low · **Area:** worker / execution

**What:** A worker trigger's `timeout` config wraps the run in a `Promise.race` that rejects with `new Error("Job timed out after <ms>ms")`. This plain Error is indistinguishable to the catch block from any other failure, so it flows through the ordinary retry/DLQ path. By contrast, a per-step `maxDuration` timeout throws a `StepTimeoutError` that `RunnerSteps` detects and flips the run to the distinct `timedOut` status via `markRunTimedOut`. So two timeout features that look equivalent to an author produce different run statuses and observability — an operator filtering SLA dashboards on `status = "timedOut"` will see worker-level timeouts misclassified.

**Why it's a design flaw:** The framework introduced a dedicated `timedOut` run status (per `CLAUDE.md` §12) precisely so SLA dashboards can separate timeouts from logic failures, but the worker's own timeout predates/bypasses it and emits an untyped Error that lands in the wrong bucket. The documented status taxonomy silently lies for worker timeouts. (Closely related to F4 — the same `Promise.race` mechanism. Because it never aborts the in-flight `run()`, the *run record's* terminal status is actually decided by the abandoned background run: "completed" if the slow work eventually succeeds, or "failed" if it throws — never `timedOut`. So the misclassification is even worse than the candidate's "becomes failed" framing.)

**Evidence:** `triggers/worker/src/WorkerTrigger.ts:753-769` (`executeWithTimeout`, reject at `:756`), generic routing at `:697-743`; per-step path at `RunnerSteps.ts:705-723`; `markRunTimedOut`/`timedOut` status at `RunTracker.ts:535-552`/`:52`.

**Recommended fix:** Make the worker timeout participate in the same taxonomy: reject with a typed error (reuse `StepTimeoutError` or a new `JobTimeoutError`) and, in `handleJob`'s catch, branch before the generic retry to call `tracker.markRunTimedOut(ctx._traceRunId, {...})` so the run flips to `timedOut`. Combine with the F4 fix (abort `ctx.signal` on timeout) to also close the "timed-out job shows as completed/failed out of band" race. Alternatively, steer authors toward per-step `maxDuration` (which already produces `timedOut`) and deprecate/document the trigger-level `config.timeout`.

---

### F25 — Worker `concurrency` field silently ignored by the Kafka adapter
**Severity:** Low · **Area:** Worker adapters / documented config ignored

**What:** The worker trigger's `concurrency` field is documented as "Number of concurrent consumers (parallelism cap)." Seven of the eight broker adapters honor it (InMemory, RabbitMQ via prefetch, SQS, BullMQ, NATS via Semaphore, RedisStreams, PgBoss). `KafkaAdapter.process()` never references `config.concurrency` — it creates one consumer and calls `consumer.run({ eachMessage })` with no `partitionsConsumedConcurrently` and no semaphore, so messages are processed serially per partition regardless of the configured value. A workflow author who sets `concurrency: 10` on a Kafka-backed worker gets validated, accepted config with zero runtime effect — and `WorkerTrigger.ts:342` even logs `concurrency=N` at startup, reinforcing the illusion it took effect.

**Why it's a design flaw:** A documented, schema-validated, startup-logged tuning knob is a silent no-op on one specific adapter while working on every other one. The asymmetry is invisible: the value passes Zod, is echoed in the boot log, and appears to take effect, but the Kafka consumer never consumes it. The `KafkaAdapter` docstring carefully enumerates Kafka's *other* semantic differences (per-partition ordering, no broker-side retries) but conspicuously omits that `concurrency` is unsupported, and the public docs list Kafka as a supported adapter with no concurrency caveat — so the omission is an oversight, not a documented limitation. (Low: a throughput-tuning footgun, not a correctness/safety bug; workaround via multiple consumer-group members.)

**Evidence:** `triggers/worker/src/adapters/KafkaAdapter.ts:140-198` (`process()` never reads `config.concurrency`; `eachMessage` at `:150-152` with no `partitionsConsumedConcurrently`); schema at `core/workflow-helper/src/types/TriggerOpts.ts:550-556`; sibling adapters honor it (e.g. `NATSAdapter.ts:185`, `BullMQAdapter.ts:139`, `RabbitMQAdapter.ts:121`); startup log at `WorkerTrigger.ts:341-343`.

**Recommended fix:** Pass concurrency to KafkaJS's native option: `consumer.run({ ..., partitionsConsumedConcurrently: Math.max(1, config.concurrency ?? 1), eachMessage })`. Pair with a docstring/docs note that for Kafka, `concurrency` maps to `partitionsConsumedConcurrently` and is bounded by partition count. For uniform behavior with NATS/SQS/Redis, alternatively wrap `eachMessage` in the same `Semaphore(config.concurrency)` primitive `NATSAdapter` uses. Minimum acceptable fix if implementation is deferred: document the Kafka exception in the schema description and worker docs so the knob is not silently misleading.