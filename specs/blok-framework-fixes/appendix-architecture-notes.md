# Appendix — Blok architecture notes (deep-research subsystem maps)

> Generated during the deep-research pass that produced these SPECs. Source-cited maps of every subsystem touched by the bugs/flaws. Reference material, not a change proposal.

### Subsystem map: trigger-lifecycle

I have everything I need. All evidence is confirmed against source. Here is the technical map.

---

# Trigger Lifecycle — Technical Map

`TriggerBase` (`core/runner/src/TriggerBase.ts`) is the shared engine; `HttpTrigger` (`triggers/http/src/runner/HttpTrigger.ts`) and `WorkerTrigger` (`triggers/worker/src/WorkerTrigger.ts`) are the two concrete transports. Both extend `TriggerBase`, both funnel into the same `TriggerBase.run(ctx)` (`TriggerBase.ts:599`), but they build the `Configuration` and the `ctx` very differently. This map traces both paths and calls out every divergence.

## 1. Core shared engine: `TriggerBase`

### 1.1 Construction (`TriggerBase.ts:109-122`)
Every trigger instance gets a single `this.configuration = new Configuration()` (`:111`), a `HealthCheck`, a `TriggerMetricsCollector`, and a `PrometheusMetricsBridge`. The single `Configuration` instance is **reused and mutated per request** via `configuration.init(...)` — it is not per-run. This matters: `this.configuration.name`, `.version`, `.trigger`, `.steps`, `.nodes`, `.appliedMiddleware` all reflect *the most recently `init`-ed workflow*. Under concurrent requests on the same trigger object the configuration is racy by design; correctness depends on `init` + `createContext` + `run` happening before the next `init` interleaves. (HTTP partly dodges this by passing `preloadedWorkflow` and deep-cloning — see §6.)

### 1.2 `createContext` (`TriggerBase.ts:1523-1597`)
Builds the `Context`:
- `id` = supplied id or `uuid()` (`:1524`).
- `request = { body: {} }` placeholder (`:1525`) — both transports **overwrite `ctx.request` entirely** after createContext (HTTP at `HttpTrigger.ts:1245`, Worker at `WorkerTrigger.ts:559`).
- `response = { data: "", contentType: "", success: true, error: null }` (`:1526`).
- `state` = single shared object; `vars` is the **same reference** (legacy alias) (`:1529, :1554`).
- `config: this.configuration.nodes` (`:1544`) — the resolved node map; the blueprint mapper reads step inputs from here.
- `signal: abortController.signal` for cooperative cancellation; the controller is stashed on `ctx._PRIVATE_.abortController` (`:1538, :1558`).
- Read-only getters `ctx.req → ctx.request` and `ctx.prev → ctx.response` (`:1564-1575`).
- `ctx.publish(name, value)` writes to state + emits a Studio event (`:1580`).
- `ctx.env` from `getEnvForCtx()` allowlist (`:1592`).

### 1.3 `run(ctx)` — the universal pipeline (`TriggerBase.ts:599-1256`)
This is the single method both transports call. Order of operations:

1. **In-flight accounting** — `inFlightRequests++` (`:600`), decremented in `finally` (`:1254`).
2. **Trace start / re-entry branch** (`:614-783`):
   - If `_blokDispatchReentry === true` (deferred-timer re-entry), it **reuses** `ctx._traceRunId`, re-registers the AbortController (`:633-637`), rehydrates `ctx.state` from the persisted `stateSnapshot` (`:660-678`), and rehydrates per-primitive iteration cursors (`:692-728`). No new run record.
   - Otherwise `tracker.startRun({...})` (`:752`) creates the run record. Reads `X-Blok-Replay-Of` (`:738-744`), sub-workflow lineage headers `x-blok-parent-run-id` / `x-blok-parent-node-run-id` (`:750-751`), and `x-blok-subworkflow-depth` (`:767`). Wraps `ctx.logger` in `TracingLogger` (`:782`). **All of this lineage threading is HTTP-header-driven — workers carry no such headers** (divergence D7).
3. **Scheduling gates** (`:799-805`) → `maybeDeferRun` (debounce → delay; `:1269-1465`). May throw `DeferredDispatchSignal`. Skipped on re-entry, when tracker inactive, or `BLOK_SCHEDULING_DISABLED=1`.
4. **Concurrency gate** (`:815-975`) → resolves `concurrencyKey`, calls `tracker.acquireConcurrencySlot(...)` (`:822`). On deny: either queue path (`markRunQueued` + `DeferredRunScheduler.schedule` + throw `DeferredDispatchSignal{status:"queued"}`, `:836-947`) or throw `ConcurrencyLimitError` after `markRunThrottled` (`:949-966`). On grant: stashes `acquiredLock`, released in `finally` (`:1227-1239`).
5. **Workflow execution** (`:1022-1023`): `const runner = this.getRunner(); const context = await runner.run(ctx);`. `getRunner()` (`:130`) returns `new Runner(this.configuration.steps)`.
6. **Metrics** recorded around the run (`:977-1103`).
7. **Complete** (`:1106-1133`): `tracker.completeRun(traceRunId, context.response?.data)`, plus optional sample-body recording.
8. **Return** `{ ctx: context, metrics: average }` — a `TriggerResponse` (`:1135`).
9. **Catch** (`:1139-1218`): `WaitDispatchRequest` → translate to delayed dispatch + throw `DeferredDispatchSignal` (`:1152-1186`). Otherwise `tracker.failRun(...)` **unless** the error is `ConcurrencyLimitError` / `QueueExpiredError` / `DeferredDispatchSignal` / `RunCancelledError` / `WaitDispatchRequest` (those already set terminal status). Re-throws (`:1218`).
10. **Finally** (`:1219-1255`): release concurrency slot, unregister AbortController, record metrics, decrement in-flight.

> **Surprising:** `run` *re-throws* every error including the deferred/throttle signals. The **transport layer's catch** (HTTP `runWorkflowExecution`, Worker `handleJob`) is responsible for translating those signals into a response/ACK. So `run` is transport-agnostic and never produces a 202/429/410 itself.

### 1.4 Middleware chain (`applyMiddlewareChain` `:187-201`, `runMiddlewareChain` `:228-262`)
**Critically, `applyMiddlewareChain` is NOT called inside `run`.** Each transport calls it *before* `run` on the same ctx (HTTP `:1272`, `:1053`; Worker `:595`). It merges three sources outer→inner: process-global (`WorkflowRegistry.getGlobalMiddleware()`) → workflow-level (`configuration.appliedMiddleware`) → trigger-level (`configuration.trigger[<triggerType>].middleware`). `getTriggerType()` (`:161`) strips `"Trigger"` and lowercases the class name, so `HttpTrigger → "http"`, `WorkerTrigger → "worker"`. `runMiddlewareChain` looks each name up via `registry.getMiddleware(mwName)` (`:231`), which returns undefined unless `isMiddleware === true` (`WorkflowRegistry.ts:222`), and **throws a 500-producing error if missing** (`:238-240`). Each middleware runs via `new Runner(...).run(ctx, { deep: true })` with the parent `ctx.config` swapped to the middleware's resolved nodes and restored in `finally` (`:243-261`).

> **Known bug (TASK-ts-middleware-registration.md):** TS middleware workflows registered via `Workflows.ts` never get `isMiddleware: true` (only the JSON scan sets it — `HttpTrigger.ts:363-377`), so `getMiddleware` returns undefined → every request 500s. This is a registration-path gap, not a `run`-path gap.

### 1.5 Process-level handlers (static, idempotent)
`installCrashHandlers` (`:283-322`), `installShutdownHandlers` (`:358-432`), `recoverOrphanedRuns` (`:453-475`). All wired into both transports' `listen()`. Kill-switches: `BLOK_CRASH_AUTOFLIP_DISABLED`, `BLOK_GRACEFUL_SHUTDOWN_DISABLED`, `BLOK_ORPHAN_THRESHOLD_MS`.

### 1.6 Deferred dispatch (`dispatchDeferred` `:1479-1510`)
Timer callback: TTL check → `tracker.transitionRunToRunning` → set `_blokDispatchReentry=true` → `await this.run(ctx)` → swallow errors → reset flag. `extractDispatchPayload` (`:151`) returns `null` by default (in-memory only); **HTTP overrides it, Worker does not** (divergence D6).

---

## 2. HTTP path: socket → response

### 2.1 Boot (`HttpTrigger` constructor + `listen`)
- Constructor (`HttpTrigger.ts:193-200`): builds/accepts a `Hono` app, calls `loadNodes()` (`:202`, into `this.nodeMap.nodes`) and `loadWorkflows()` (`:210`, `this.nodeMap.workflows = workflows` — the manual `Workflows.ts` map).
- `listen()` (`:600-956`):
  1. `buildFileBasedRoutes()` (`:266-383`) — scans `WORKFLOWS_PATH/json/`, merges manual TS workflows from `Workflows.ts`, builds a route table via `buildRouteTable`, and feeds `WorkflowRegistry` (clear-then-register, `:341-353`). Middleware-only JSON workflows registered with `isMiddleware:true` (`:363-377`). **Returns explicit route entries with `preloadedWorkflow` objects.**
  2. `scanAndRegisterMiddleware()` (`:406-472`) — registers middleware + sub-workflow lookups even when file-based routing is off.
  3. Env-fallback global middleware from `BLOK_GLOBAL_MIDDLEWARE` (`:634-642`).
  4. Mounts: `/health-check`, `/metrics`, the **RPC mount `POST /__blok/rpc/:name`** (`:698-724`), `/__blok/nodes`, the `/__blok` trace router (`:741-749`), then **explicit file-based routes** (`registerExplicitRoutes`, `:763`), then the **catch-all** `app.all("/:workflow{.+}/*")` + `app.all("/:workflow{.+}")` (`:804-805`).
  5. `serve({ fetch: this.app.fetch, port })` (`:807`) — Hono on `@hono/node-server`. The ready callback installs crash/shutdown/janitor handlers, concurrency + debounce backends, and `recoverDispatches()` (`:843-951`).

### 2.2 Request handling (three entry handlers, all converging on `runWorkflowExecution`)
- **Explicit route** (`registerExplicitRoutes` `:485-524`): handler parses body via `parseBody` (`:547-598`), calls `runWorkflowExecution` with `explicitRoute:true` + `preloadedWorkflow: route.workflow`.
- **RPC mount** (`:698-724`): looks up by name in `WorkflowRegistry`, rejects middleware (`:701`), branches to `runWorkflowStream` for `text/event-stream` (`:710-712`), else `runWorkflowExecution` with `rpcInput` (scalar fields mirrored into query/params, `:1259-1267`).
- **Catch-all** (`workflowHandler` `:767-802`): extracts workflow name from path, computes `subPath`, handles the `x-blok-execute-node` remote-node-execution header (`:786-791`), calls `runWorkflowExecution` with `explicitRoute` unset.

### 2.3 `runWorkflowExecution` (`:1083-1482`) — the HTTP funnel
1. Opens an OTel span (`:1131`).
2. **Configuration init** (`:1198-1202`): if `preloadedWorkflow` provided → `configuration.init(name, nodeMap, preloadedWorkflow)` (deep-clones + normalizes, **no disk read**). Else → `configuration.init(name, nodeMap)` (resolver path → `LocalStorage`).
3. `createContext(undefined, workflowName, id)` (`:1203`).
4. **Param resolution** (`:1209-1223`): explicit routes use Hono's `c.req.param()`; catch-all uses `handleDynamicRoute` against `configuration.trigger.http.path`.
5. **Method/path validation** only for catch-all (`:1229-1234`) — explicit routes trust Hono's routing.
6. **Builds `ctx.request`** from the Hono request (`:1245-1254`): `body`, `rawBody`, `headers` (from `c.req.raw.headers`), `params`, `query`, `method`, `path`, `url`.
7. `applyMiddlewareChain(ctx, nodeMap)` (`:1272`).
8. `await this.run(ctx)` (`:1274`) → unwrap `response.ctx`.
9. **Response emission** (`:1281-1303`): default content-type fill, then `emitWorkflowResponse(c, ctx.response)` (`responseEmitter.ts:22`) — honors `@blokjs/respond` envelopes, raw binary, string, or JSON.
10. **Catch block translates signals** (`:1304-1474`):
    - `DeferredDispatchSignal` → **202 Accepted** + `Location: /__blok/runs/:id` (`:1320-1342`).
    - `PayloadTooLargeError` → **413** (`:1349-1361`).
    - `QueueExpiredError` → **410 Gone** (`:1369-1385`).
    - `ConcurrencyLimitError` → **429** + `Retry-After` (`:1391-1411`).
    - `GlobalError` → its `code` (default 500) with JSON body (`:1413-1461`).
    - Else → **500** (`:1463-1474`).

### 2.4 HTTP durable-dispatch specifics
HTTP **overrides `extractDispatchPayload`** (`:1516-1555`) to serialize a request subset (method/path/headers/body/params/query), stripping sensitive headers (`DISPATCH_HEADER_DENYLIST` `:1487-1494`), redacting body/params/query (`traceRedactSensitive`), and capping at 1MB. `recoverDispatches()` (`:1573-1667`) + `restoreDispatch()` (`:1676-1705`) rebuild a Context from a persisted row on boot and re-enter `dispatchDeferred`.

---

## 3. Worker path: broker delivery → completion

### 3.1 Boot (`WorkerTrigger.listen` `:236-364`)
**No constructor** (removed in v0.6.3, `:206-213`) — `loadNodes()` + `loadWorkflows()` run at the *start of `listen()`* (`:244-245`) because subclass class-fields (`nodes`, `workflows`, `adapter`) initialize after `super()`. Then: concurrency backend (`await backend.connect()` — **synchronous/awaited**, vs HTTP's fire-and-forget `.then()`, divergence D5), debounce backend, crash/janitor/shutdown handlers (`:300-325`). Then `getWorkerWorkflows()` (`:328`, `:511-530`) which reads `workflow._config` off each `nodeMap.workflows` entry and filters to `trigger.worker`. For each workflow: `resolveAdapterForWorkflow(config)` (`:340`), `activeQueues.add(config.queue)`, and `adapter.process(config, job => this.handleJob(job, workflow, config))` (`:347-349`).

### 3.2 Adapter resolution (`resolveAdapterForWorkflow` `:469-495`)
Order: (1) subclass `this.adapter` wins (back-compat) (`:471-480`); (2) per-workflow `provider` via lazy-imported factory (`:484-485`); (3) `BLOK_WORKER_ADAPTER`; (4) `in-memory` fallback. Adapters pooled per provider in `adapterPool` (`:486-493`). **Divergence D8:** HTTP has no adapter concept — it serves all workflows on one Hono app/port. Worker fans workflows out across broker connections keyed by queue+provider.

> **Known bug (TASK-worker-trigger-fixes.md P1):** the scaffold hardcodes `protected adapter = new KafkaAdapter(...)`, which wins at `:471` over `provider`/env, so a fresh worker crashes on boot with no Kafka and the documented `provider` config silently no-ops.

### 3.3 Job handling (`handleJob` `:535-748`)
1. OTel span `worker:${queue}` (`:548`).
2. **Configuration init** (`:553`): `await this.configuration.init(workflow.path, this.nodeMap)` — **passes `workflow.path` (the map key), NOT a preloaded object.** So worker ALWAYS goes through the resolver → `LocalStorage.get` path, even though the workflow is already in memory. (Divergence D2 — and the root of worker bug P2.)
3. `createContext(undefined, workflow.path, jobId)` (`:556`).
4. **Builds `ctx.request`** from the job (`:559-569`): `body: job.data`, `headers: job.headers`, `query: {}`, `params: { queue, jobId, attempt, priority }`. **No `method`, `path`, `url`, or `rawBody`** (divergence D3). Also sets `ctx.vars._worker_job` metadata (`:572-582`).
5. `applyMiddlewareChain(ctx, nodeMap)` (`:595`).
6. **Execution** (`:598-603`): `config.timeout` → `executeWithTimeout(ctx, timeout)` (`:753-769`, a `Promise.race` against a `setTimeout`); else `this.run(ctx)` directly. (Divergence D4 — HTTP has no per-run wall-clock timeout wrapper; it relies on per-step `maxDuration`.)
7. On success: span attrs, metrics, `await job.complete()` (`:626`).
8. **Catch block translates signals → broker semantics** (`:627-743`):
    - `DeferredDispatchSignal` → `job.complete()` (**ACK, no requeue** — scheduler owns dispatch) (`:634-647`).
    - `QueueExpiredError` → `job.complete()` (ACK, run already expired) (`:654-666`).
    - `ConcurrencyLimitError` → `job.fail(error, true)` (**NACK + redelivery**, doesn't count against retry budget) (`:675-695`).
    - Otherwise normal failure: `shouldRetry = job.attempts < job.maxRetries` (`:697`) → `job.fail(error, true)` with exponential backoff (`:705-728`), else `job.fail(error, false)` → DLQ (`:729-743`).

---

## 4. Divergences: HTTP vs Worker (the heart of the request)

| # | Concern | HTTP | Worker |
|---|---|---|---|
| **D1** | Configuration source | Passes `preloadedWorkflow` object → `init` deep-clones + normalizes, **no disk read** at request time (`HttpTrigger.ts:1199`, `Configuration.ts:168-181`) | Passes `workflow.path` string → resolver → `LocalStorage.get` (`WorkerTrigger.ts:553`, `Configuration.ts:182-185`) |
| **D2** | Workflow lookup | By name via route table + `WorkflowRegistry`; dotted names work | Via file-extension parser `LocalStorage.get` (`LocalStorage.ts:20-31`). **Bug:** a dotted name like `publish.site` → tail `site` treated as file extension → `File type not supported: site` |
| **D3** | `ctx.request` shape | Full HTTP req: `body, rawBody, headers, params, query, method, path, url` (`:1245-1254`) | Job-derived: `body, headers, query:{}, params:{queue,jobId,attempt,priority}` — **no method/path/url/rawBody** (`:559-569`). `buildTraceTriggerSummary` (`TriggerBase.ts:1515`) falls back to `"worker"` because `req.path`/`req.method` are absent |
| **D4** | Run timeout | None at trigger level (per-step `maxDuration` only) | `executeWithTimeout` wraps `run` in a `Promise.race` if `config.timeout > 0` (`:599-600, :753-769`) |
| **D5** | Concurrency-backend connect | Fire-and-forget `.then()/.catch()` inside `serve()` ready callback — server serves traffic before backend connects (`HttpTrigger.ts:882-901`) | `await backend.connect()` blocks `listen()` before any job is consumed (`WorkerTrigger.ts:257`) |
| **D6** | `extractDispatchPayload` | Overridden — durable HTTP dispatch persisted to `scheduled_dispatches` with recovery (`HttpTrigger.ts:1516`, `recoverDispatches` `:1573`) | Not overridden → returns `null` (`TriggerBase.ts:151`). Deferred dispatch is in-memory only; broker owns delay durability |
| **D7** | Lineage / replay headers | `run` reads `x-blok-replay-of`, `x-blok-parent-run-id`, `x-blok-parent-node-run-id`, `x-blok-subworkflow-depth` (`TriggerBase.ts:738-771`) | No headers carry these — worker runs are top-level with no replay/sub-workflow lineage threading |
| **D8** | Connection model | One Hono app, one TCP port for all workflows | One adapter (broker connection) per provider, pooled; `adapter.process` per queue |
| **D9** | Signal → client mapping | `DeferredDispatchSignal`→202, `QueueExpired`→410, `ConcurrencyLimit`→429+Retry-After, `PayloadTooLarge`→413, `GlobalError`→its code (`:1304-1474`) | `DeferredDispatchSignal`→ACK, `QueueExpired`→ACK, `ConcurrencyLimit`→NACK+redelivery, others→retry/DLQ via `job.fail` (`:627-743`) |
| **D10** | Response | `emitWorkflowResponse` serializes `ctx.response` to an HTTP `Response` (`responseEmitter.ts`) | No response surface — only `job.complete()` / `job.fail()`. `ctx.response` is discarded |
| **D11** | Boot init timing | `loadNodes`/`loadWorkflows` in **constructor** (`:198-199`) | In **`listen()`** because class-fields run after `super()` (`:244-245`, comment `:206-213`) |
| **D12** | Middleware-missing impact | Throws inside `runMiddlewareChain` → caught in `runWorkflowExecution` → 500 | Throws → caught in `handleJob` → routed through retry/DLQ (same throw, different fate) |
| **D13** | `getTriggerType()` resolution | `"http"` → reads `trigger.http.middleware` and tags dispatch rows `triggerType:"http"` | `"worker"` → reads `trigger.worker.middleware` |

## 5. Convergences (shared invariants)
Both transports: call `createContext` → overwrite `ctx.request` → `applyMiddlewareChain(ctx, nodeMap)` → `this.run(ctx)`. Both reuse the *same single* `this.configuration` instance (mutated per request by `init`). Both go through the identical scheduling gate → concurrency gate → `Runner(configuration.steps).run(ctx)` core. Both wrap in an OTel span and rely on `run` re-throwing signals for transport-specific translation.

## 6. Footguns / asymmetries worth flagging for downstream agents
- **Shared `this.configuration` mutation:** `run` reads `this.configuration.name/.trigger/.steps` (`TriggerBase.ts:752, :800, :816, :1131`) which were set by the most recent `init`. HTTP's per-request `init(name, nodeMap, preloadedWorkflow)` deep-clones the *workflow definition* (`Configuration.ts:180`) but the `Configuration` *object itself* is shared — concurrent HTTP requests for *different* workflows can interleave `init` and read another workflow's `name`/`trigger` in `run`. The deep-clone protects step-input mapper mutations, not the Configuration scalar fields.
- **Middleware runs outside `run`:** any analysis of "what `run` does" must remember `applyMiddlewareChain` already mutated `ctx.state` before `run` is entered. A middleware `@blokjs/throw` surfaces in the transport's catch, not `run`'s.
- **Worker never uses the preloaded path:** `handleJob` passes `workflow.path` (`:553`) so it always hits `LocalStorage` — the dotted-name bug (P2) and any future file-resolution change affects only the worker.
- **`dispatchDeferred` swallows all errors** (`TriggerBase.ts:1502-1506`) — a failing re-entered run is invisible except via `tracker.failRun` already done inside the nested `run`.
- **Queue re-defer is HTTP-durable only:** because `extractDispatchPayload` returns null on worker, a worker `onLimit:"queue"` deferral does not survive a restart.

## Key files
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/TriggerBase.ts` — shared engine (`run` `:599`, `createContext` `:1523`, `applyMiddlewareChain` `:187`, `runMiddlewareChain` `:228`, `maybeDeferRun` `:1269`, `dispatchDeferred` `:1479`).
- `/Users/wellprado/Projects/Personal/blok/triggers/http/src/runner/HttpTrigger.ts` — HTTP transport (`listen` `:600`, `buildFileBasedRoutes` `:266`, `registerExplicitRoutes` `:485`, `runWorkflowExecution` `:1083`, RPC mount `:698`, catch-all `:767/:804`, `extractDispatchPayload` `:1516`, `recoverDispatches` `:1573`).
- `/Users/wellprado/Projects/Personal/blok/triggers/worker/src/WorkerTrigger.ts` — Worker transport (`listen` `:236`, `getWorkerWorkflows` `:511`, `resolveAdapterForWorkflow` `:469`, `handleJob` `:535`, `executeWithTimeout` `:753`).
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/Configuration.ts` — `init` `:161` (preloaded vs resolver branch `:168-185`); `getRunner` builds `Runner(steps)`.
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/LocalStorage.ts:20-31` — dotted-name file-extension parse (worker bug P2).
- `/Users/wellprado/Projects/Personal/blok/triggers/http/src/runner/responseEmitter.ts:22` — `emitWorkflowResponse`.
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/workflow/WorkflowRegistry.ts:220-222` — `getMiddleware` gate (TS-middleware bug).
- `/Users/wellprado/Projects/Personal/blok/core/workflow-helper/src/components/workflowV2.ts:203-204` — `workflow()` requires a trigger (middleware bug, Problem B).

---

### Subsystem map: workflow-loading-resolution

I now have the complete picture across both the boot-time scan path and the request-time resolution path, both branches of `Configuration.init`, the LocalStorage parsing, the registry/helper fallback, and the normalizer. Here is the detailed technical map.

---

# Subsystem Map: Workflow Loading & Resolution

## 1. One-paragraph mental model

A workflow **identifier** (a name or a file-ish string like `"users/list"`) becomes a runnable **config object** through one of two mutually-exclusive paths inside `Configuration.init` (`core/runner/src/Configuration.ts:161`):

- **Preloaded path** — the object was already parsed at boot (file-based router) and is handed in directly; the resolver/disk are skipped.
- **Resolver path** — the identifier is handed to `ConfigurationResolver` → `LocalStorage`, which turns it into a raw object by reading a file from disk (`json`/`yaml`/`xml`/`toml`) OR by falling back to an in-memory `WorkflowLocator` (the `Workflows.ts` TS map).

Both paths converge on `normalizeWorkflow` (v1→v2 canonicalization), and from there into `getSteps`/`getNodes` (node resolution). The asymmetry between the two paths — what mutates, what is cloned, and what each path can and cannot find — is the most important thing in this subsystem.

---

## 2. The two paths into `Configuration.init`

`Configuration.init(workflowNameInPath, opts?, preloaded?)` — `core/runner/src/Configuration.ts:161-202`.

```
init(name, opts, preloaded?)
  if preloaded !== undefined:                 // BOOT-SCAN / REGISTRY path
      fresh = JSON.parse(JSON.stringify(preloaded))   // :180 deep clone
      this.workflow = normalizeWorkflow(fresh, name)  // :181
  else:                                       // RESOLVER path
      resolver = new ConfigurationResolver(opts)        // :183
      this.workflow = await resolver.get("local", name) // :184  (normalizes internally)
  if (!this.workflow) throw `No workflow found with path '${name}'`   // :187
  this.steps   = await getSteps(this.workflow.steps)   // :190
  this.nodes   = await getNodes(this.workflow.nodes)   // :193
  this.version = this.workflow.version                 // :194
  this.name    = this.workflow.name                    // :195
  this.trigger = this.workflow.trigger                 // :196
  this.appliedMiddleware = wf.appliedMiddleware ?? []  // :200-201
```

### ASYMMETRY 1 — only the preloaded path deep-clones

`Configuration.ts:180` does `JSON.parse(JSON.stringify(preloaded))` **before** normalizing. The resolver path does NOT clone — but it doesn't need to, because `LocalStorage` produces a brand-new object from `JSON.parse`/`YAML.parse`/etc. on every call, or `JSON.parse(locator.toJson())` for the helper fallback (`LocalStorage.ts:38,43,64`). The clone on the preloaded path is load-bearing: the route table holds a single shared workflow object reused across every request, and the per-request blueprint mapper resolves `js/...` expressions **in place**. Without the clone, request 1's resolved values would bake into the shared object and leak into request 2 (documented at `Configuration.ts:170-178`).

### ASYMMETRY 2 — `init()` mutates a shared `Configuration` instance

`HttpTrigger` reuses one `this.configuration` instance and calls `init()` on it per request (`HttpTrigger.ts:1031,1199,1201`). `init()` overwrites `this.workflow/steps/nodes/trigger/name/version/appliedMiddleware` each time. This is fine single-threaded but means there is no per-request `Configuration` isolation — the deep-clone at `:180` is what actually provides request isolation on the preloaded path.

---

## 3. The RESOLVER path in detail

### 3a. `ConfigurationResolver` — the single pinch point

`core/runner/src/ConfigurationResolver.ts`:
- Constructor wires exactly ONE target: `{ local: new LocalStorage() }` (`:20-22`). There is no other storage target despite the `Targets` map abstraction — `target` is always `"local"`.
- `get(target, name)` (`:27-35`): `await this.targets[target].get(name, this.globalOptions.workflows)` then `normalizeWorkflow(raw, name)`. **The normalizer is applied here**, so the resolver path always returns canonical shape. `this.globalOptions.workflows` is the `WorkflowLocator` (the `Workflows.ts` map) passed through as the fallback source.

### 3b. `LocalStorage.get()` — identifier → raw object

`core/runner/src/LocalStorage.ts:13-70`. Signature: `get(name, workflowLocator, fileType?)`.

**Step A — resolve root + default file type** (`:14-16`):
- `rootPath = VITE_WORKFLOWS_PATH || WORKFLOWS_PATH`
- `workflowFileType = fileType || VITE_WORKFLOWS_FILE_TYPE || WORKFLOWS_FILE_TYPE`, defaulting to `"json"`.

**Step B — the dot / file-extension parser** (`:18-31`) — *the place TASK-worker-trigger-fixes Problem 2 fires*:
```ts
let name_fixed = name;
if (name_fixed.indexOf(".") !== -1) {          // :20  ANY dot triggers this
    const parts = name.split(".");
    workflowFileType = parts[parts.length-1].toLowerCase();  // :24  tail = "extension"
    if (!this.fileTypes.includes(workflowFileType))          // :26  fileTypes = json/yaml/xml/toml (:11)
        throw new Error(`File type not supported: ${workflowFileType}`);  // :27  ← throws
    name_fixed = parts.slice(0, -1).join(".");   // :30  strip the "extension"
}
```
The heuristic: **any `.` in the identifier means `filename.extension`.** So `"users/list.json"` → type `json`, name `users/list`. But `"publish.site"` → tail `site` → not in `["json","yaml","xml","toml"]` → **throws `File type not supported: site`**. This is the dotted-`domain.action` name bug (TASK-worker-trigger-fixes.md:92-106). The supported-types array is hard-coded at `LocalStorage.ts:11`.

**Step C — disk lookup** (`:33-59`):
- Builds `workflowPathJson = ${rootPath}/${workflowFileType}/${name_fixed}.${workflowFileType}`. Note the file type is **also a directory segment** (e.g. `WORKFLOWS_PATH/json/users/list.json`).
- If the file exists: parse per type — `JSON.parse` (`:38`), `YAML.parse` (`:43`), `XMLParser` with `steps` forced to array (`:48`), or `smol-toml parse` (`:55`).

**Step D — the registry/helper fallback** (`:61-67`) — *only reached when no file exists*:
```ts
if (workflowLocator !== undefined) {
    const helperExists = workflowLocator[name] !== undefined;   // :62  keyed by ORIGINAL name
    if (helperExists) {
        const json = JSON.parse(workflowLocator[name].toJson());  // :64
        return json as Config;
    }
}
throw new Error(`Workflow not found: ${name}`);   // :69
```
The fallback is the bridge to **TS workflows**: `workflowLocator` is `globalOptions.workflows`, i.e. the `Workflows.ts` map (`{ "countries-helper": <builder>, ... }` — see `triggers/http/src/Workflows.ts`). Each value is a `HelperResponse` (v1 builder) or `WorkflowV2Builder` (v2 `workflow({...})` factory) — both expose `.toJson()` (contract documented in `types/GlobalOptions.ts:9-16`). The fallback serializes the builder to JSON and parses it back into a plain object.

### ASYMMETRY 3 — the fallback uses `name`, the disk lookup uses `name_fixed`

Disk lookup uses `name_fixed` (the dot-stripped name, Step B), but the helper fallback at `:62/:64` keys on the **original** `name`. So a TS workflow registered under a dotted key in `Workflows.ts` (e.g. `"publish.site"`) can never reach the fallback — the dotted name throws at Step B (`:27`) before the disk lookup, never reaching `:62`. This is exactly why the worker path's dotted names break (TASK-worker-trigger-fixes.md:85-89).

### ASYMMETRY 4 — file type is inferred from the *identifier*, never the filesystem

If a workflow only exists as `users/list.yaml` but is requested as `"users/list"` with `WORKFLOWS_FILE_TYPE` unset (default `"json"`), the lookup builds `…/json/users/list.json`, misses, and falls through to the locator/throw. There is no "try each known extension" probing — the requested type (or default `json`) is authoritative.

---

## 4. The PRELOADED / boot-scan path (TS-vs-JSON loading)

This is the path the HTTP trigger actually uses in production. It diverges sharply by source format.

### 4a. `scanWorkflows` — disk discovery

`triggers/http/src/runner/scanWorkflows.ts`:
- `scanWorkflows(roots, options)` (`:70-82`) walks each `ScanRoot.dir` recursively (`walk`, `:120-165`), tolerating per-file load errors via `onLoadError` (never throws on one bad file — `:161-163`).
- Skip rules (`:138, :146`): names starting with `_` or `.`; extensions not in the allowed set (`.json` for JSON roots, `.ts`/`.js` for TS roots — `:178-181`).
- **Loading by kind** (`loadOne`, `:167-176`):
  - `kind === "json"`: `readFile` + `JSON.parse` (`:168-170`).
  - `kind === "ts"`: `await import(file)`, take `mod.default`; returns `null` (skipped) if no default export (`:172-176`).
- `deriveUrlFromFilePath` (`:94-116`) turns a relative file path into a URL: strips extension, drops `index`, converts `[id]` → `:id`. `[...slug]` catch-all is explicitly NOT implemented (`:110-112`).
- `extractWorkflowName` (`:192-201`) best-effort reads `wf.name` or `wf._config.name`.

### ASYMMETRY 5 — only JSON is disk-scanned; TS workflows are NOT scanned from disk

The HTTP trigger's `buildFileBasedRoutes` (`HttpTrigger.ts:266-383`) only scans the **JSON** root:
```ts
const scannedJson = await scanWorkflows([{ dir: path.join(workflowsRoot, "json"), kind: "json", ... }], ...)  // :279-292
```
TS workflows do NOT come from `scanWorkflows`. They come from the **statically-imported `Workflows.ts` map**:
```ts
const manual = Object.keys(workflows ?? {}).map((key) => ({ key, workflow: workflows[key] }));  // :294-297
```
`workflows` is the default import from `../Workflows` (`HttpTrigger.ts:37`), also stashed onto `this.nodeMap.workflows` by `loadWorkflows()` (`:210-212`). So **JSON = file-scanned; TS = compile-time-imported map.** `scanWorkflows` is *capable* of TS scanning (it accepts `kind: "ts"` roots), but `buildFileBasedRoutes` never passes a TS root — TS authoring goes exclusively through `Workflows.ts`.

### 4b. `buildRouteTable` — identifier becomes a route

`triggers/http/src/runner/WorkflowRouter.ts:111-216` merges `scanned` (JSON) + `manual` (TS) into a `RouteEntry[]`:
- For each workflow, `extractHttpTrigger` (`:258-271`) reads `trigger.http` (also tolerates `_config.trigger` for builder envelopes). Non-HTTP workflows are skipped (`:134, :171`) — they don't become routes.
- Path resolution: explicit `trigger.http.path` wins; else in legacy mode (`BLOK_ROUTING_LEGACY=1`) fall back to file-derived URL (JSON) or catch-all (TS) with a deprecation warning; else **throw `MissingExplicitPathError`** (`:147-152, :187-190`). So in non-legacy mode an explicit `path` is mandatory.
- `workflowKey = sw.name ?? deriveKeyFromPath(source)` (JSON, `:154`) or `mr.key` (TS, `:197`).
- Collision detection (`detectCollision`, `:283-327`): exact `(method, path)` duplicates, and `ANY`-shadows-specific. Tolerant mode (callback) drops the loser; strict mode throws `RouteCollisionError` (`handleCollision`, `:334-345`). The HTTP trigger runs tolerant (`HttpTrigger.ts:308-322`) so one bad pair doesn't nuke the whole table.
- Final `sortBySpecificity` (`:250-254`, scored by `scorePathSpecificity` `:232-248`) ensures literal routes register before `:param` catch-alls (Hono matches in registration order).

### 4c. Registry registration — the two-loop split (the middleware bug)

After building the table, `buildFileBasedRoutes` populates `WorkflowRegistry` in **two loops** (`HttpTrigger.ts:341-380`):

**Loop 1 — route-table loop** (`:344-353`): registers EVERY workflow in the table (JSON + manual TS), deduped by name, **without `isMiddleware`**:
```ts
registry.register({ name: wfName, source: r.source, workflow: r.workflow });  // :348-352  no isMiddleware
```

**Loop 2 — middleware-detection loop** (`:363-377`): sets `isMiddleware: true`, but iterates **`scannedJson` only**:
```ts
for (const sw of scannedJson) {            // :363  JSON ONLY — TS map not iterated
    if (wfObj.middleware !== true) continue;
    registry.register({ ..., isMiddleware: true });   // :370-375
}
```

### ASYMMETRY 6 — middleware detection is JSON-only (documented bug)

A `middleware: true` workflow authored in **TS** (in `Workflows.ts`) is caught by Loop 1 (registered, `isMiddleware` falsy) and **missed by Loop 2** (which only walks `scannedJson`). The catch-all `scanAndRegisterMiddleware` (`:406-472`) has the same JSON-only limitation (`for (const sw of scanned)` at `:426`, where `scanned` is again the JSON scan). Downstream, `WorkflowRegistry.getMiddleware(name)` returns `undefined` unless `isMiddleware === true` (`WorkflowRegistry.ts:220-224`), so `runMiddlewareChain` throws and every request 500s. This is the precise root cause documented in **TASK-ts-middleware-registration.md:43-63**. Evidence lines match: `HttpTrigger.ts:344-353` (Loop 1), `:363-377` (Loop 2), `:427` (catch-all), `WorkflowRegistry.ts:222` (gate).

The normalizer DOES handle the `middleware` field correctly — `WorkflowNormalizer.ts:201` sets `middleware: true` as a marker, and `:327` re-emits it. The bug is purely that the HTTP trigger's registration loops don't *read* that marker off TS workflows. (The route-table registration at `:348` carries `r.workflow` which still has `middleware` at its root — the fix proposed in the task is to set `isMiddleware: (r.workflow as any)?.middleware === true` there.)

### 4d. Catch-all dispatch (legacy path)

When file-based routing is off, or a request doesn't match any explicit route, the catch-all `workflowHandler` (`HttpTrigger.ts:767-805`) runs:
- Extracts the workflow name from the URL: `c.req.param("workflow")` (`:769`), computes `subPath = fullPath.slice(1 + name.length)` (`:778`).
- Calls `runWorkflowExecution` **without** `preloadedWorkflow` (`:793-801`) → forces `Configuration.init` down the **resolver path** (`:1201`), where `LocalStorage` resolves the URL name against disk-or-`Workflows.ts`-locator.

So: **explicit routes → preloaded path; catch-all → resolver path.** This is the trigger-level mirror of the `init()` branch.

---

## 5. The request-time branch in `runWorkflowExecution`

`HttpTrigger.ts:1083-1202`. The decision (`:1198-1202`):
```ts
if (preloadedWorkflow !== undefined)
    await this.configuration.init(workflowNameInPath, this.nodeMap, preloadedWorkflow);  // preloaded path
else
    await this.configuration.init(workflowNameInPath, this.nodeMap);                      // resolver path
```
- Explicit routes pass `preloadedWorkflow: route.workflow` (`registerExplicitRoutes`, `:497`) → preloaded path.
- Catch-all passes no preloaded → resolver path.
- A third RPC mount (`/__blok/rpc/:name`) at `:1031` also passes `preloadedWorkflow` (registry-sourced).

There's also a remote-node-execution sub-path (`:1134-1193`) that *synthesizes* a workflow at request time from a header payload, stuffs it into `this.nodeMap.workflows[id]` (`:1190`), and points `workflowNameInPath` at that synthetic key (`:1191`) — so the subsequent resolver path finds it via the locator fallback. This is the one place the locator map is written at runtime rather than boot.

---

## 6. `normalizeWorkflow` — the convergence point

`core/runner/src/workflow/WorkflowNormalizer.ts:162-333`. Both paths funnel here. Key behaviors:

- **Builder unwrap** (`:171-177`): `workflow()` returns `{_blokV2: true, _config: {...}}`; legacy `Workflow()` returns `{_config: {...}}`. Both unwrapped to the inner config. This is what lets the `Workflows.ts` `.toJson()` output (resolver path) AND the raw scanned object (preloaded path) share one normalizer. Note `extractHttpTrigger`/`extractWorkflowName` in the router also peek at `_config` (`WorkflowRouter.ts:262`, `scanWorkflows.ts:197`) because routing happens *before* normalization.
- **`set_var` rejection** (`assertNoSetVar`, `:1130-1173`): walks top-level + every nested sub-pipeline (branch/forEach/loop/switch/tryCatch) and throws a migration error at load time if `set_var` is present (`:1137`). Runs at `:183-185`.
- **v1→v2 field mapping**: `id`||`name`, `use`||`node`, inline `inputs` vs `nodes[name].inputs` (`normalizeRegularStep`, `:339-438`). Type inferred from node ref when absent (`inferStepType`, `:1081-1090`).
- **Primitive expansion**: branch (`:440`), subworkflow (`:540`), wait (`:646`), forEach (`:714`), loop (`:808`), switch (`:949`), tryCatch (`:1017`) each expand into an internal step + a `nodes[id]` config, with inner-step configs bubbled into the flat `internalNodes` map via `Object.assign` (`:240, 271, 280, 289, 298`).
- **Middleware overload** (`:194-212`): `middleware: true` → marker (`:201`); `middleware: string[]` → `appliedMiddleware` chain (`:203-206`); both set → throw (`:207-212`).
- **Trigger normalization** (`normalizeTrigger`, `:1063-1079`): `method: "*"` → `"ANY"` with a once-per-file warning (`:1069-1071, :1092-1099`).
- Output shape (`InternalWorkflow`, `:114-151`) is the v1-compatible internal shape `getSteps`/`getNodes` consume — `steps: [{name, node, type, ...}]` + flat `nodes: {[name]: {inputs|conditions|steps|...}}`.

### ASYMMETRY 7 — normalization happens at different layers per path

On the resolver path, normalization lives **inside** `ConfigurationResolver.get` (`ConfigurationResolver.ts:34`). On the preloaded path, it lives **inside** `Configuration.init` (`Configuration.ts:181`). Same `normalizeWorkflow` function, two call sites. The comment at `ConfigurationResolver.ts:6-13` calls the resolver "the single pinch point... so the normalizer applies once" — but that's only true for the resolver path; the preloaded path re-implements the normalize call independently. Anyone adding logic to the resolver (caching, validation) must remember the preloaded path bypasses it entirely.

---

## 7. Node resolution (`getSteps` / `getNodes` / `nodeResolver`)

After `init` has the normalized workflow:
- `getSteps` (`Configuration.ts:204-257`): per top-level step, calls `nodeResolver(step)` then copies v2 knobs (`as`/`spread`/`ephemeral` `:228-230`; `idempotencyKey`/`retry`/`subworkflow`/`wait`/`maxDuration` `:234-252`) onto the resolved node.
- `getNodes` (`:259-371`): materializes per-`id` node configs. Flow primitives (`isFlowWithProperties` `:274`, `isConditions` `:290`, `tryCatch` `:311`, `switch` `:329`) recurse via `getFlow` (`:373-421`) to resolve inner steps into `NodeBase[]`. `getFlow` copies the same v2 knobs onto nested steps (`:400-413`).
- `nodeResolver` (`:423-430`) dispatches on `node.type` through `nodeTypes()` (`:432-490`): `module` → `moduleResolver` (looks up `opts.nodes.getNode` `:626-649`); `local` → `localResolver` (dynamic import with NODES_PATH path-escape guard `:769-779`); `runtime.*` → `runtimeResolver` (`:492-562`); `subworkflow`/`wait`/`forEach`/`loop`/`switch`/`tryCatch` → their lazy-imported stub nodes. Unknown type → throws `Node type X not found` (`:429`).

---

## 8. Summary table — identifier → config object, by path

| Stage | Resolver path (catch-all / non-preloaded) | Preloaded path (explicit routes / RPC / sub-workflow) |
|---|---|---|
| Entry | `init(name, opts)` no 3rd arg (`Configuration.ts:182-184`) | `init(name, opts, preloaded)` (`:168-181`) |
| Source of raw object | `LocalStorage.get` — disk file OR `Workflows.ts` locator fallback (`LocalStorage.ts:33-67`) | Object already in memory (route table / `WorkflowRegistry` / scan) |
| Clone? | No (each parse is fresh) | **Yes** — `JSON.parse(JSON.stringify(preloaded))` (`:180`) |
| Normalize call site | inside `ConfigurationResolver.get` (`ConfigurationResolver.ts:34`) | inside `init` (`Configuration.ts:181`) |
| TS workflows reachable? | Yes, via locator fallback keyed on original `name` (`LocalStorage.ts:62`) | Yes, via `manual` registrations in route table (`HttpTrigger.ts:294`) |
| Dotted-name (`a.b`) safe? | **No** — throws at `LocalStorage.ts:27` unless tail is a real file type | Yes — name is just a map/registry key, never parsed for extension |
| Middleware `isMiddleware` set? | n/a (resolver doesn't touch registry) | TS: **No (bug)**; JSON: Yes (`HttpTrigger.ts:374`) |

---

## 9. Concrete bug cross-references (verified against source)

- **Dotted worker/workflow names throw** — `LocalStorage.ts:20-31`; the registry-by-name path (HTTP) doesn't hit this because it uses the preloaded object, not `LocalStorage`. Matches TASK-worker-trigger-fixes.md:91-106.
- **TS middleware never flagged** — Loop 1 `HttpTrigger.ts:348-352` (no `isMiddleware`), Loop 2 `:363-377` (JSON-only), catch-all `:426` (JSON-only), gate `WorkflowRegistry.ts:222`. Matches TASK-ts-middleware-registration.md:43-63.

## 10. Notable gotchas for downstream design agents

1. **`ConfigurationResolver` is not actually the only loading pinch point** — the preloaded path bypasses it (§6 Asymmetry 7). Any cross-cutting concern (caching, validation, metrics on load) must be added to BOTH `ConfigurationResolver.get` and `Configuration.init`'s preloaded branch.
2. **`LocalStorage.fileTypes` is hard-coded** (`LocalStorage.ts:11`) and the dot heuristic (`:20`) is greedy — it cannot distinguish a dotted *name* from a `name.ext`. Any fix must check the locator/registry BEFORE throwing, or only treat a trailing dot-segment as an extension when it matches a known type (TASK suggests the latter at lines 119-135).
3. **TS and JSON take entirely different discovery routes** (§4 Asymmetry 5): JSON is filesystem-scanned under `WORKFLOWS_PATH/json/`; TS comes only from the statically-imported `Workflows.ts` map. There is no disk scan of `.ts` workflows in `buildFileBasedRoutes`, even though `scanWorkflows` supports `kind: "ts"`.
4. **The route table feeds the registry, but the registry is also fed separately** by `scanAndRegisterMiddleware` (`HttpTrigger.ts:406-472`) and `WorkflowRegistry.setGlobalMiddleware`/env (`:633-642`). `clear()` wipes workflows but deliberately preserves the global-middleware chain and authorize hook (`WorkflowRegistry.ts:244-246`).

### Relevant files
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/Configuration.ts` (init branch :161-202; resolvers :423-779)
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/ConfigurationResolver.ts`
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/LocalStorage.ts` (dot parsing :20-31; fallback :61-69)
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/ResolverBase.ts`
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/workflow/WorkflowNormalizer.ts`
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/workflow/WorkflowRegistry.ts`
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/types/GlobalOptions.ts` (WorkflowLocator)
- `/Users/wellprado/Projects/Personal/blok/triggers/http/src/runner/scanWorkflows.ts`
- `/Users/wellprado/Projects/Personal/blok/triggers/http/src/runner/WorkflowRouter.ts`
- `/Users/wellprado/Projects/Personal/blok/triggers/http/src/runner/HttpTrigger.ts` (buildFileBasedRoutes :266-383; two registration loops :344-377; catch-all :767-805; init branch :1198-1202)
- `/Users/wellprado/Projects/Personal/blok/triggers/http/src/Workflows.ts` (the TS map)

---

### Subsystem map: registry-and-middleware

I now have a complete and verified picture of the registry-and-middleware subsystem. Let me compile the technical map.

---

# Technical Map: registry-and-middleware Subsystem

## 1. Overview

The subsystem has two cooperating pieces:

- **`WorkflowRegistry`** (`core/runner/src/workflow/WorkflowRegistry.ts`) — a process-wide singleton mapping `name → RegisteredWorkflow`. It serves THREE distinct consumers: (a) the `subworkflow:` step primitive (`get`/`authorize`), (b) the middleware dispatcher (`getMiddleware`), and (c) the process-global middleware chain (`get/setGlobalMiddleware`). It is also read by Studio's trace router and by every sibling trigger (SSE/WS/webhook/mcp) to discover their workflows.
- **The middleware dispatcher** on `TriggerBase` (`core/runner/src/TriggerBase.ts`) — `applyMiddlewareChain` (merges the three tiers) and `runMiddlewareChain` (resolves + executes each named middleware as a nested `Runner` run on the SAME ctx).

Population of the registry is owned almost entirely by **`HttpTrigger`** (`triggers/http/src/runner/HttpTrigger.ts`). Sibling triggers do NOT populate it themselves — they only read it.

---

## 2. Key types (WorkflowRegistry.ts)

| Symbol | Location | Notes |
|---|---|---|
| `RegisteredWorkflow` | `WorkflowRegistry.ts:45-64` | `{ name, source, workflow: unknown, isMiddleware?: boolean }`. `workflow` is the RAW pre-normalization object. `isMiddleware` is the only marker distinguishing a middleware entry. |
| `WorkflowAuthorizeFn` | `:43` | `(parentName, childName, ctx) => boolean \| Promise<boolean>` — sub-workflow authorization hook. |
| `WorkflowRegistry` class | `:66-247` | Singleton via `getInstance()` (`:94`), reset via `resetInstance()` (`:102`). |

### Registry instance state
- `workflows: Map<string, RegisteredWorkflow>` (`:68`) — keyed on `name`.
- `authorizeFn` (`:69`) — sub-workflow gate, default null (allow-all).
- `globalMiddleware: readonly string[]` (`:92`) — process-global chain, frozen snapshot.

### Registry methods
| Method | Location | Behavior |
|---|---|---|
| `register(entry)` | `:189-200` | Throws on empty name (`:190-192`); throws on `(name)` collision when `source` differs (`:194-198`); **same `(name, source)` is idempotent last-wins** via `Map.set`. Does NOT validate `isMiddleware`. |
| `registerAll(entries)` | `:203-207` | Loops `register`; stops on first collision. |
| `get(name)` | `:210-212` | Returns entry or undefined — returns middleware entries too (no `isMiddleware` filter). |
| `getMiddleware(name)` | `:220-224` | **ASYMMETRIC**: returns undefined unless `entry.isMiddleware === true` (`:222`). A workflow registered without the flag is invisible here even though `get()` finds it. |
| `setGlobalMiddleware(names)` | `:167-170` | Filters non-string/empty, `Object.freeze`s. Last-call-wins; `[]` clears. |
| `getGlobalMiddleware()` | `:179-181` | Returns the frozen snapshot. |
| `setAuthorizeFn` / `authorize` | `:124-126` / `:133-136` | `authorize` returns `true` when no hook installed (default-allow). |
| `has` / `list` | `:227-229` / `:232-234` | |
| `clear()` | `:244-246` | Drops `workflows` map only. **Does NOT reset `authorizeFn` or `globalMiddleware`** (`:240-242` doc) — operator state survives HMR re-scans. |

---

## 3. Every `registry.register(...)` call path + whether it sets `isMiddleware`

There are exactly **four** `WorkflowRegistry.register` call sites in framework source, all in `HttpTrigger.ts`, plus **three** scaffold-generated call sites in `packages/cli/src/commands/create/project.ts`. **No sibling trigger calls `register` at all** (verified: SSE/WS/webhook/mcp grep returns NONE — their registry hits are all read-only `get`/`list`).

| # | Call site | Source of workflows | Sets `isMiddleware`? | When |
|---|---|---|---|---|
| 1 | `HttpTrigger.ts:348-352` (route-table loop, ~344-353) | route `table` entries (JSON scan + **manual TS from `Workflows.ts`**) | **NO** | `buildFileBasedRoutes`, file-based routing ON |
| 2 | `HttpTrigger.ts:370-375` (middleware-detection loop, ~363-377) | `scannedJson` ONLY (`for (const sw of scannedJson)`, `:363`) | **YES** (`:374`) | `buildFileBasedRoutes`, file-based routing ON |
| 3 | `HttpTrigger.ts:442-447` (`scanAndRegisterMiddleware`) | `scanned` = **JSON scan only** (`:408-421`) | **YES** (`:446`) | `listen()` always; catch-all/off path |
| 4 | `HttpTrigger.ts:454-458` (`scanAndRegisterMiddleware`) | same JSON scan, non-middleware branch | **NO** | sub-workflow lookup registration |
| S1 | `project.ts:1309-1313` (scaffold preCatchAllHook) | TS `sharedWorkflows` with sse/ws/webhook/mcp trigger | **NO** | multi-trigger scaffold boot |
| S2 | `project.ts:1735-1739` (scaffold SSEServer) | TS `workflows` with `trigger.sse` | **NO** | SSE-server scaffold boot |
| S3 | `project.ts:1849-1854` (scaffold WSServer) | TS `workflows` with `trigger.websocket` | **NO** | WS-server scaffold boot |

**The asymmetry (root cause of `TASK-ts-middleware-registration.md`):** Of the four framework sites, the only two that set `isMiddleware: true` (#2, #3) iterate **JSON scans only**. The two that handle TS workflows (#1 via the `manual` array, and the scaffold sites) **never set `isMiddleware`**. So a TS `middleware: true` workflow is registered (callable, routable) but `getMiddleware(name)` returns undefined → `runMiddlewareChain` throws → 500.

**Deeper layer the TASK write-up does not surface:** `TASK-ts-middleware-registration.md:80` assumes "the normalized `r.workflow` carries `middleware` at the root, same as JSON" and proposes reading `(r.workflow).middleware === true`. But for a TS workflow authored via `workflow({...})`, the `_config` object is built field-by-field at `workflowV2.ts:236-248` and **`middleware` is never copied onto it** (and `WorkflowOpts`/`WorkflowV2` don't even declare a `middleware` field — verified, grep returns NONE). So the proposed fix (A) would still read `undefined` for a `workflow()`-authored middleware. The flag survives only on raw object literals / JSON / legacy `Workflow().addTrigger(...)` shapes, not the recommended `workflow()` helper. Fix A is necessary but not sufficient for the `workflow()` path.

---

## 4. The two HttpTrigger registration loops in detail

### Route-table loop (`buildFileBasedRoutes`, `:341-356`)
```
registry.clear()                                    // :342 — wipes map, keeps global mw + authorizeFn
for (const r of table):                             // :344  table = buildRouteTable(scannedJson, manual)
  wfName = r.workflow.name ?? r.workflowKey         // :345
  if registered.has(wfName) continue                // :346  dedupe by NAME across method/path rows
  registry.register({ name, source: r.source,
                      workflow: r.workflow })        // :348  ← NO isMiddleware
```
The `table` comes from `buildRouteTable(scannedJson, manual, ...)` (`:308`), where `manual` is `Object.keys(workflows)` from `Workflows.ts` (`:294-297`). **This is the ONLY path TS workflows enter the registry through the HTTP trigger** — and it never flags middleware.

### Middleware-detection loop (`:362-377`)
```
for (const sw of scannedJson):                      // :363  ← JSON scan ONLY
  if sw.workflow.middleware !== true continue        // :365
  wfName = sw.workflow.name ?? sw.name              // :366
  if registered.has(wfName) continue                // :368
  registry.register({ ..., isMiddleware: true })     // :370-375
```
`scannedJson` is produced at `:279-292` scanning **only** `path.join(workflowsRoot, "json")` with `kind: "json"`. TS files under `WORKFLOWS_PATH` are never scanned here.

### `scanAndRegisterMiddleware` (`:406-472`) — the catch-all / file-routing-OFF fallback
- Scans `path.join(workflowsRoot, "json")`, `kind: "json"` only (`:408-421`).
- Two branches per scanned workflow:
  - `middleware === true` → register with `isMiddleware: true` (`:442-447`), but only if no existing non-middleware entry would be clobbered (`:441` guard: `if (existing && !existing.isMiddleware) continue`).
  - else → register WITHOUT the marker for sub-workflow lookup (`:454-458`), skipping if anything already registered (`:453`).
- Idempotency guard at `:434-435`: skips re-register when `existing.source === sw.source`.

**Net:** all three places that could flag a TS workflow as middleware iterate JSON scans. There is a latent, never-invoked `kind: "ts"` capability in `scanWorkflows` (`scanWorkflows.ts:38,57-60,167-178`) that unwraps `_config` (`:196`), but `HttpTrigger` never calls it.

---

## 5. The three middleware tiers + name resolution + execution

### Tier merge (`TriggerBase.applyMiddlewareChain`, `:187-201`)
Called from every trigger's dispatch path BEFORE `this.run(ctx)` (HttpTrigger: `:1272` and stream path `:1053`; SSE `:329`; webhook `:395`; etc.). Builds the ordered name list:

```
triggerType   = this.getTriggerType()                         // :188  "http" | "worker" | "sse" | ...
triggerLevel  = configuration.trigger[triggerType].middleware  // :189-194  (string[] filtered)
workflowLevel = configuration.appliedMiddleware                // :195
globalLevel   = WorkflowRegistry.getInstance().getGlobalMiddleware()  // :196
middlewareNames = [...globalLevel, ...workflowLevel, ...triggerLevel] // :197
```

**Resolution order outer→inner (`:178-180`, `:197`):**
1. **Process-global** — `WorkflowRegistry.globalMiddleware` (set via `setGlobalMiddleware([...])` or `BLOK_GLOBAL_MIDDLEWARE` env; v0.5.4).
2. **Workflow-level** — `configuration.appliedMiddleware`, populated at `Configuration.ts:200-201` from the normalized workflow's `appliedMiddleware` field (v0.5.2).
3. **Trigger-level** — `trigger.<kind>.middleware: [...]` (v0.5). `getTriggerType()` (`:161-163`) strips `"Trigger"` from the class name and lowercases, so `HttpTrigger`→`http`, `WorkerTrigger`→`worker`. This is why each trigger reads its own block.
4. (then the main workflow body runs in `this.run`.)

### The `middleware` field overload (WorkflowNormalizer.ts:194-210, 327-328)
`middleware` at the workflow root is overloaded into two different concepts:
- `middleware: true` (boolean) → `middleware: true` on the normalized workflow → drives the `isMiddleware` registration flag (this workflow IS a middleware).
- `middleware: ["a","b"]` (string array) → normalized to `appliedMiddleware` → tier 2 chain (this workflow APPLIES other middleware).
- Both at once throws at load (`WorkflowNormalizer.ts:207-210`) — mutually exclusive.

Note: the `workflow()` v2 helper declares NEITHER form in `WorkflowOpts`/`WorkflowV2` and strips both at `workflowV2.ts:236-248`, so v2-helper-authored workflows can express tiers 2 and "is-middleware" only via raw object shapes or JSON, not through the typed helper.

### Name resolution + execution (`TriggerBase.runMiddlewareChain`, `:228-262`)
For each `mwName` in the merged list:
```
entry = registry.getMiddleware(mwName)              // :231 — REQUIRES isMiddleware === true
if !entry:                                          // :232-241
    throw with list of registry.list().filter(isMiddleware).map(name)   // :233-240
mwConfig = new Configuration(); await mwConfig.init(mwName, nodeMap, entry.workflow)  // :243-244
parentConfig = ctx.config                           // :246
ctx.config = mwConfig.nodes                          // :247 — swap so blueprint mapper finds mw step inputs
ctx._blokMiddlewareName = mwName                     // :253 — Studio badge sentinel
try:
    new Runner(mwConfig.steps).run(ctx, { deep: true, stepName: `mw:${mwName}` })  // :255-256
finally:
    ctx.config = parentConfig; ctx._blokMiddlewareName = undefined  // :258-259
```

Key execution semantics:
- **Same ctx** — state mutations from earlier middleware (`ctx.state.identity` etc.) carry forward to later middleware AND the main workflow (`:181-185` doc).
- **`deep: true`** prevents the inner `runSteps` from inheriting the outer run's `lastCompletedStepIndex` cursor (wait/resume hazard, `:215-216`).
- **Short-circuit** — middleware throws (typically `@blokjs/throw` with a `code:`) propagate to the caller's outer catch; the main workflow does NOT run (`:184-185`, `:221-223`).
- **Failure on missing name** — the throw at `:238-240` is exactly the 500 reported in `TASK-ts-middleware-registration.md:33-37`. The error hint mentions only `"in a scanned WORKFLOWS_PATH directory"` and `"middleware": true` — it does NOT mention the TS `Workflows.ts` registration gap (TASK fix C).

---

## 6. TS (`Workflows.ts`) vs JSON differences

### (a) Route registration
- **JSON**: scanned from `WORKFLOWS_PATH/json/**` by `scanWorkflows` (`HttpTrigger.ts:279-292`), fed to `buildRouteTable` as the `scanned` arg. Route derived from explicit `trigger.http.path` or, under `BLOK_ROUTING_LEGACY`, the file-derived `defaultPath` (`WorkflowRouter.ts:132-167`).
- **TS**: comes ONLY from the `Workflows.ts` map → `manual` array (`HttpTrigger.ts:294-297`) → `buildRouteTable`'s `manual` loop (`WorkflowRouter.ts:169-205`). **TS requires an explicit `trigger.http.path`** — un-pathed manual entries throw `MissingExplicitPathError` (`:187-190`) unless legacy mode skips them to the catch-all (`:181-185`). TS files on disk under `WORKFLOWS_PATH` are NOT auto-scanned by the HTTP trigger (the `kind: "ts"` scan capability exists but is unused).
- Both unwrap `_config` via `extractHttpTrigger` (`WorkflowRouter.ts:258-271`) and `extractWorkflowName` (`scanWorkflows.ts:192-201`), tolerating both `.trigger` and `._config.trigger` shapes.

### (b) Middleware registration (the asymmetry)
- **JSON**: a `middleware: true` JSON workflow under `WORKFLOWS_PATH/json/` is registered with `isMiddleware: true` by loop #2 (`:363-377`) and/or `scanAndRegisterMiddleware` #3 (`:442-447`). **Works.**
- **TS**: a `middleware: true` TS workflow flows only through the `manual`/route-table loop #1 (`:348`), which never sets `isMiddleware`. It is registered as a regular workflow → `getMiddleware` returns undefined → `runMiddlewareChain` 500s. **Broken** (`TASK-ts-middleware-registration.md`). Compounded by (i) `workflow()` requiring a trigger even for middleware (`workflowV2.ts:203-205`), forcing a dummy `trigger.http.path` that then exposes the middleware as a real route via loop #1, and (ii) `workflow()` stripping the `middleware` field from `_config` (`workflowV2.ts:236-248`) so the flag is lost before the normalizer/registry ever sees it.

### (c) Sub-workflow lookup
- **Symmetric at the consumer.** `SubworkflowNode.run` (`SubworkflowNode.ts:170-179`) resolves the child name (static or polymorphic via `resolveSubworkflowName`), calls `registry.get(resolvedName)` (NOT `getMiddleware`), and errors if missing (`:173-178`). It then authorizes (`:189-194`) and materializes a child `Configuration` from `entry.workflow` (`:211-212`).
- **Asymmetric at the producer (registration coverage):**
  - JSON non-middleware workflows are registered for sub-workflow lookup by loop #1 (if http-routed and in the route table) AND by `scanAndRegisterMiddleware` branch #4 (`:454-458`, covers non-http JSON workflows and the file-routing-OFF case).
  - TS non-middleware workflows are registered for sub-workflow lookup ONLY if they have an HTTP trigger (so they land in the route table via #1). A TS workflow in `Workflows.ts` with, say, only a `worker` trigger and no http trigger will NOT be in the route table (`extractHttpTrigger` returns null at `WorkflowRouter.ts:171`) and is NOT picked up by `scanAndRegisterMiddleware` (JSON-only) → it is **invisible to `subworkflow:` lookup** unless something else registers it.
  - SSE/WS/webhook/mcp TS workflows are registered (without `isMiddleware`) only by the scaffold-generated `preCatchAllHook`/server classes (`project.ts:1291-1320, 1735-1739, 1849-1854`), because `HttpTrigger.buildFileBasedRoutes` calls `registry.clear()` and re-registers only HTTP-routed workflows (`project.ts:1281-1290` comment documents this gap explicitly).

---

## 7. Registry consumers beyond middleware/sub-workflow (for completeness)

- **Typed-client RPC mount** (`HttpTrigger.ts:698-724`): `POST /__blok/rpc/:name` uses `registry.get(name)` and **rejects middleware entries** (`:701` `if (!entry || entry.isMiddleware === true) → 404`) — middleware is not RPC-callable.
- **Trace router / Studio** (`TraceRouter.ts:142-152, 346, 363`): walks `registry.list()`; `isMiddleware` entries return `null` from the workflow-detail mapper (`:152`) so middleware doesn't appear as a public workflow in Studio.
- **Sibling-trigger discovery**: `getSSEWorkflows`/`getWebSocketWorkflows`/`getWebhookWorkflows`/`getServerGroups` all iterate `registry.list()` filtering by their own `trigger.<kind>` config (`SSETrigger.ts:455-465`, `WebSocketTrigger.ts:818-828`, `WebhookTrigger.ts:424-444`, `McpTrigger.ts:270-291`). They consume but never populate.
- **Dispatch recovery** (`HttpTrigger.ts:1619`): `registry.has(row.workflowName)` gates whether a persisted scheduled dispatch is re-registered on boot.

---

## 8. Surprising / asymmetric behavior summary

1. **`get` vs `getMiddleware` divergence** (`WorkflowRegistry.ts:210` vs `:220-224`): a name can be "found" by `get` but "not found" by `getMiddleware` — the basis of the TS-middleware 500.
2. **JSON-only middleware flagging**: all three `isMiddleware: true` registration sites iterate JSON scans (`:363`, `:408-421`); TS never gets the flag (TASK file).
3. **`workflow()` double failure for middleware**: requires a trigger (`workflowV2.ts:203-205`) AND drops the `middleware` field (`:236-248`) — so the recommended authoring path can't even express a middleware correctly.
4. **`clear()` preserves operator state** (`:244-246`): wipes workflows but keeps `globalMiddleware` + `authorizeFn` across HMR — intentional, but means a stale env-set global chain survives a re-scan.
5. **`BLOK_GLOBAL_MIDDLEWARE` env is a FALLBACK, not an override** (`HttpTrigger.ts:633-642`): the env var is read only when `getGlobalMiddleware().length === 0`, so a programmatic `setGlobalMiddleware([...])` at boot wins over CI-injected env.
6. **Sibling triggers are registry-read-only**: they rely entirely on `HttpTrigger` or scaffold boot code to populate the registry; `buildFileBasedRoutes`'s `registry.clear()` (`:342`) is the reason the scaffold needs a `preCatchAllHook` to re-inject non-HTTP TS workflows (`project.ts:1281-1290`).
7. **Same-ctx middleware execution** (`TriggerBase.ts:246-259`): middleware mutate the parent ctx in place (state carries forward); `ctx.config` is swapped per-middleware and restored in `finally`, with a `_blokMiddlewareName` sentinel for Studio badging.

---

## Relevant files (absolute paths)
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/workflow/WorkflowRegistry.ts`
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/TriggerBase.ts` (`applyMiddlewareChain` :187-201, `runMiddlewareChain` :228-262)
- `/Users/wellprado/Projects/Personal/blok/triggers/http/src/runner/HttpTrigger.ts` (loops :344-353, :363-377; `scanAndRegisterMiddleware` :406-472; global-mw env :633-646; RPC mount :698-724)
- `/Users/wellprado/Projects/Personal/blok/triggers/http/src/runner/WorkflowRouter.ts` (`buildRouteTable` manual/TS :169-205; `extractHttpTrigger` :258-271)
- `/Users/wellprado/Projects/Personal/blok/triggers/http/src/runner/scanWorkflows.ts` (JSON/TS kinds :38,57-60,167-178; `_config` unwrap :192-201)
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/SubworkflowNode.ts` (registry lookup :170-194)
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/Configuration.ts` (`appliedMiddleware` :200-201; `init`/normalize :161-202)
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/workflow/WorkflowNormalizer.ts` (`middleware` overload :194-210, :327-328)
- `/Users/wellprado/Projects/Personal/blok/core/workflow-helper/src/components/workflowV2.ts` (trigger-required :203-205; `_config` build that drops `middleware` :236-248)
- `/Users/wellprado/Projects/Personal/blok/core/runner/src/tracing/TraceRouter.ts` (middleware hidden from Studio :142-152)
- Sibling triggers (read-only consumers): `triggers/{sse,websocket,webhook,mcp}/src/*.ts`
- Scaffold registration: `/Users/wellprado/Projects/Personal/blok/packages/cli/src/commands/create/project.ts` (:1291-1320, :1730-1740, :1840-1855)

---

### Subsystem map: dsl-and-validation

I now have full coverage of the subsystem. Let me verify one asymmetry the docs hint at: whether `workflowV2.ts:203` truly blocks middleware-only construction despite `WorkflowV2Schema` permitting trigger-less. Both files confirm it. Here is the technical map.

---

# Technical Map: Workflow DSL + Validation (`@blokjs/helper` / `core/workflow-helper`)

## 0. Orientation

Two authoring DSLs coexist, both validated with Zod at *construction time* (in-process, before the runner ever sees the workflow):

| Generation | Entry point | Shape | Validation site |
|---|---|---|---|
| **v2 (canonical)** | `workflow({...})` factory + `branch/forEach/loop/switchOn/tryCatch` | single object literal | `workflowV2.ts` |
| **v1 (legacy)** | `Workflow(...).addTrigger(...).addStep(...)` chained builder | builder methods mutate `_config` | `Workflow.ts` / `Trigger.ts` / `StepNode.ts` |

Both are re-exported from `core/workflow-helper/src/index.ts` (v2 primitives at `:142-148`, v1 builder classes at `:128-139`). The two schemas (`WorkflowV2Schema`, `WorkflowOptsSchema`) are **separate** and the runner's `WorkflowNormalizer` reconciles v1 → v2 at load time (outside this subsystem). Everything below is **construction-time** behavior in the helper package.

---

## 1. The v2 `workflow()` factory — `components/workflowV2.ts`

`workflow<I,O,E>(opts): TypedWorkflow` (`workflowV2.ts:177-261`). Generic over optional Zod `input`/`output`/`events` schemas, which it threads onto a phantom `__blokTypes` witness (`:114-116`) for the typed `@blokjs/client` — never assigned at runtime (`:256-260`).

### Construction sequence (exact order matters)

1. **Object guard** — `:182-184` throws `"workflow() requires an options object."` if `opts` is falsy/non-object.
2. **Compile `$` proxies BEFORE schema validation** — `:188` `unwrapProxies(opts.steps)`. Critical ordering: the schema validates strings (`z.string().min(1)`), so proxies must collapse to `"js/ctx..."` strings first or they'd fail validation (`:186-187` comment).
3. **Per-step Zod validation** — `:191-198` loops every step through `V2StepSchema.safeParse`. On failure throws `workflow("<name>") step "<id>" failed validation: <zodMessage>` (`:196`). Step id is resolved from `id ?? name ?? "<step N>"` (`:194-195`) — note it tolerates a legacy `name` for the error label only.
4. **Trigger presence + per-kind validation** — `:202-215` (see §3).
5. **SSE events declaration check** — `:221-234` (see §6 — a genuinely surprising static check).
6. **Build `_config`** — `:236-248`, conditionally spreading `input`/`output`/`events` only when defined.
7. **Freeze + return** — `Object.freeze({_blokV2: true, _config, toJson})` (`:250-260`). `toJson()` strips `input`/`output`/`events` (Zod schemas aren't serializable) — `:256`.

### What it returns

`WorkflowV2Builder` (`WorkflowOpts.ts`-adjacent interface in `workflowV2.ts:94-104`): `{ _blokV2: true, _config: WorkflowV2, toJson() }`. The `_blokV2: true` tag is how the loader/scanner detects a v2 default export. `_config` mirrors the legacy v1 builder output for back-compat (`:90-92` comment).

---

## 2. What construction validates/rejects (v2)

### Step-level (`StepOpts.ts`, via `V2StepSchema`)

`V2StepSchema` (`StepOpts.ts:857-877`) is a **`z.union`** (NOT `discriminatedUnion`) of 8 step schemas tried in this order: `branch → subworkflow → wait → forEach → loop → switch → tryCatch → regular` (`:867-876`). Regular is last (the fallback). **Asymmetry/footgun:** because it's a plain union, a malformed branch step (e.g. typo'd `branch` key) can silently fall through and be validated as a *regular* step, producing a confusing error. Discrimination is by key *presence*, encoded in the type guards `isBranchStep`/`isWaitStep`/etc. (`:892-973`), not in the schema.

**Regular step** (`V2RegularStepSchema`, `:188-306`):
- Required: `id` (min 1, `:190-196`), `use` (min 1, `:197-206`).
- Optional: `type` (NodeTypeSchema), `inputs` (`z.record(z.unknown())`), `as`, `spread`, `ephemeral`, `runtime`, `active`, `stop`, `stream_logs`, `streamTo`/`stream`, `idempotencyKey`, `idempotencyKeyTTL` (int ≥0), `retry`, `maxDuration`.
- **Cross-field reject:** `.refine(step => !(step.as && step.spread))` → `"as and spread are mutually exclusive — pick one."` (`:303-306`).

**Retry config** (`RetryConfigSchema`, `:123-155`): `maxAttempts` int 1–20 (required), `minTimeoutInMs`/`maxTimeoutInMs`/`factor` optional, plus a `.refine` enforcing `minTimeoutInMs <= maxTimeoutInMs` (`:149-155`).

**Wait step** (`V2WaitStepSchema`, `:551-625`) — the *most* defensively-validated step, and asymmetric vs every other step:
- `.strict()` (`:621`) — rejects unknown keys.
- `wait` object is `.strict()` (`:568`) with `for`/`until`, plus `.refine` enforcing **XOR**: `(for !== undefined) !== (until !== undefined)` → `"wait.for and wait.until are mutually exclusive"` (`:622-625`).
- **Feature-specific `.never()` rejections** with custom error maps for `idempotencyKey` (`:580-586`), `retry` (`:587-593`), `maxDuration` (`:598-604`), `concurrencyKey` (`:605-612`), `spread` (`:613-619`). Each emits a *why*-message (e.g. `"idempotencyKey is not supported on wait steps — the wait itself is the checkpoint."`). No other step type does this — every other step silently ignores unknown keys (no `.strict()`).

**Sub-workflow step** (`V2SubworkflowStepSchema`, `:385-528`): required `id` + `subworkflow` (string, may be a literal name OR a `$.`/`js/` polymorphic expression — `:416-426`). Optionals include `wait`, `as`/`spread` (same XOR refine, `:524-527`), `idempotencyKey`, `retry`, `maxDuration`, `allowList` (array of names for polymorphic guard, `:496-506`), `dispatch: "in-process"|"http-self"` (`:507-522`). Uses `z.lazy` (recursion: sub-pipelines contain steps).

**branch / forEach / loop / switch / tryCatch** schemas (`:327-351`, `:645-679`, `:697-722`, `:746-778`, `:812-840`) are all `z.lazy` with `z.array(z.unknown())` sub-pipelines — **the inner steps are NOT recursively validated by the parent schema** (they're `unknown`). Inner-step validation happens only at the *factory* level (see §5) and again at runner-load time. forEach has the only inner regex constraint: `as` must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/` (`:656`).

### Workflow-envelope-level (v2)

The `workflow()` factory does **NOT** run `WorkflowV2Schema` on the whole envelope — it validates steps individually and the trigger separately. `WorkflowV2Schema` (`WorkflowOpts.ts:63-118`) exists and is exported (`index.ts:202-203`) but is consumed by the **runner/normalizer at load time**, not by the factory. Its envelope rules:
- `name` min 3 (`:64`), `version` min 5 with `"Format required x.x.x"` (`:65-68`).
- `steps` `.min(1)` required (`:92`).
- **`trigger` is `.optional()`** (`:73-75`) — explicitly "Optional ONLY when `middleware: true`" (`:78-80`).
- `middleware: z.literal(true).optional()` (`:82-91`).

---

## 3. Trigger validation — `TriggerOpts.ts` + factory

### Factory trigger flow (`workflowV2.ts:202-215`)

1. `triggerKeys = Object.keys(opts.trigger ?? {})` (`:202`).
2. **If empty → throw** `workflow("<name>") requires a trigger.` (`:203-205`). ← **the line ~203-205 noted in the task.**
3. For each kind: `TriggersSchema.safeParse(kind)` (`:208`) — unknown kind throws with the full allow-list message (`:210-212`): `Allowed: http, queue, pubsub, worker, cron, webhook, sse, websocket, mcp, grpc, manual.`
4. `validateTriggerConfig(kind, config)` (`:214`) runs the per-kind Zod schema.

### `validateTriggerConfig` (`TriggerOpts.ts:901-913`)

- Looks up `TRIGGER_SCHEMAS[name]` (`:902`).
- `schema === null` (only `grpc`, `manual` — `:866-867`) → returns `config ?? {}` (accepts anything incl. `undefined`, `:903-906`).
- `config === undefined` for a schema'd trigger → throws `Trigger "<name>" requires a configuration object. See <Name>TriggerOpts.` (`:907-911`).
- Else `schema.parse(config)` — returns parsed config **with defaults applied** (`:912`).

### `TriggersSchema` (`:814-827`)
11-member enum: `http, grpc, manual, cron, queue, pubsub, worker, webhook, sse, websocket, mcp`.

### `TRIGGER_SCHEMAS` dispatch table (`:856-868`)
`satisfies Record<TriggersEnum, ZodTypeAny | null>` — guarantees every enum member has an entry. `grpc`/`manual` → `null` (schemaless).

---

## 4. The worker trigger schema (asked specifically)

`WorkerTriggerOptsSchema` (`TriggerOpts.ts:544-594`), `provider` from `WorkerProviderSchema` (`:532-542`):

| Field | Type | Default | Notes |
|---|---|---|---|
| `queue` | `z.string()` (**required**) | — | queue/topic/stream name (`:546`) |
| `provider` | enum optional (`:547-549`) | `BLOK_WORKER_ADAPTER` env → `in-memory` | enum = `in-memory, nats, bullmq, kafka, rabbitmq, sqs, redis, pg-boss` (`:532-541`); all but `in-memory` need a peer dep |
| `concurrency` | `z.number()` | `1` | consumer count; **orthogonal to** `concurrencyKey` (`:550-556`) |
| `timeout` | number optional | — | job timeout ms (`:557`) |
| `retries` | number | `3` | (`:558`) |
| `priority` | number | `0` | (`:559`) |
| `consumerGroup` | string optional | — | required for Kafka (`:560-565`) |
| `ack` | boolean optional | — | (`:566-571`) |
| `deadLetterQueue` | string optional | — | (`:572-577`) |
| `fromBeginning` | boolean optional | — | Kafka offset (`:578-583`) |
| **+ `ConcurrencyOptsFields`** | spread | — | `:588` |
| **+ `SchedulingOptsFields`** | spread | — | `:589` |

Then `.superRefine` runs `concurrencyRefinement` + `makeSchedulingRefinement("worker")` (`:591-593`).

**Important asymmetry — two different "concurrency" concepts on the worker:** `concurrency` (a plain field, default 1, the consumer parallelism cap) vs `concurrencyKey`/`concurrencyLimit` (from `ConcurrencyOptsFields`, per-key fairness gating). They are orthogonal and both present on the worker schema — easy to confuse. The schema docstring at `:553-555` explicitly disambiguates.

**Cross-references to the worker bug write-up (`TASK-worker-trigger-fixes.md`):** this schema is the *config-time* surface the task calls "the documented `provider`/env config." The bugs there are *downstream* — (1) the CLI scaffold's hardcoded `this.adapter` overrides the resolved `provider` (`packages/cli/...project.ts:2027-2078`), and (2) `LocalStorage.get()` rejects dotted workflow names (`core/runner/src/LocalStorage.ts:20-31`). Neither lives in this DSL subsystem; the schema itself correctly allows `provider: "in-memory"` and dotted `name`. So the validation layer is **not** the source of those two bugs — it's the runtime resolution path.

---

## 5. The control-flow factories — `branch/forEach/loop/switchOn/tryCatch`

These are *thin imperative builders* (NOT Zod) that construct the discriminated step objects and call `unwrapProxies` on expression fields + sub-pipelines. They are the only place inner sub-pipeline proxies get compiled at definition time.

| Factory | File | Imperative throws (not Zod) | Proxy unwrap targets |
|---|---|---|---|
| `branch` | `branch.ts:47-82` | non-object opts (`:48`); non-string `id` (`:51`); `when` not a non-empty string after unwrap (`:54-59`, message explains `===` can't be intercepted); `then` not array (`:60`); `else` not array (`:63`) | `when` (`:54`), `then` (`:68`), `else` (`:69`) |
| `forEach` | `forEach.ts:56-100` | non-object; non-string id; missing `in` (`:63`); missing/non-string `as` (`:66`); `as` fails identifier regex (`:69`); `do` empty (`:72`); bad `mode` (`:75`); non-int/<1 `concurrency` (`:78-82`) | `in` (`:84`), `do` (`:85`) |
| `loop` | `loop.ts:55-90` | non-object; non-string id; `while` empty after unwrap (`:62-67`); `do` empty (`:68`); bad `maxIterations` (`:71-75`) | `while` (`:62`), `do` (`:77`) |
| `switchOn` | `switchOn.ts:72-119` | non-object; non-string id; missing `on` (`:79`); empty `cases` (`:82`); per-case `when`/`do` checks (`:85-96`); bad `default` (`:97-101`) | `on` (`:103`), each `case.when` + `case.do` (`:104-107`), `default` (`:113`) |
| `tryCatch` | `tryCatch.ts:66-98` | non-object; non-string id; empty `try` (`:73`); empty `catch` (`:76`); non-empty-array `finally` if set (`:79-83`) | `try` (`:85`), `catch` (`:86`), `finally` (`:92`) |

**Naming note:** `switchOn` (not `switch`) because `switch` is reserved; the produced object's discriminator key is `switch` (`switchOn.ts:51-54`, `:110`).

**Asymmetric validation depth:** these factories validate *only their own shape* imperatively, and `unwrapProxies` the inner steps — but they do **NOT** run `V2StepSchema` on the inner steps. Inner-step Zod validation happens only when the *outer* `workflow()` loop hits the control-flow step (and `V2BranchStepSchema` etc. treat sub-pipelines as `z.array(z.unknown())`). Net effect: **a malformed inner step inside a `branch.then` is not caught at construction by Zod** — only by the runner at load time. The factory-level `active`/`stop` are set positionally (`branch.ts:79-80` etc.), not via the schema.

---

## 6. The surprising static check: SSE events declaration (`workflowV2.ts:124-137, 221-234`)

`collectLiteralEmitEvents` (`:124-137`) deep-walks the *compiled* step tree looking for steps with `use === "@blokjs/sse-emit"` or `"@blokjs/sse-emit-typed"` and collects their **literal** `inputs.event` string — explicitly skipping `js/`- and `$.`-prefixed dynamic expressions (`:134`).

Then `:221-234`: if `opts.events` is declared, every collected literal emit event **must** be a declared key, else throw `workflow("<name>") emits SSE event "<ev>" which is not declared in events...` (`:227-231`). This is a rare example of *cross-step semantic validation at construction time* — most validation is per-step structural. It only fires when `events` is present (opt-in), and only catches literal event names (dynamic ones escape).

---

## 7. The `$` proxy — `proxy/$.ts`

`$` is `makeProxy("ctx")` (`:121`). Each property access builds a path string lazily:
- `makeProxy(prefix)` returns a `Proxy` over a *function* target (so `typeof === "function"` lets `unwrapProxies` distinguish it from plain objects — `:84-88`).
- `get` trap (`:91-112`): `Symbol.toPrimitive`/`toString`/`toJSON`/`valueOf` all return `js/${prefix}` (`:93-96`); `then` returns `undefined` so `Promise.resolve()` doesn't mistake it for a thenable (`:97-98`); symbols ignored (`:99-100`). Numeric keys → `prefix[N]` (`:104-105`); identifier keys → `prefix.k` (`:106-107`); other → `prefix[JSON.stringify(k)]` (`:108-109`).
- So `$.state.users[0]` → `"js/ctx.state.users[0]"`.

`DollarProxy` typed surface (`:62-81`): `req`/`request`, `prev`/`response`, `state`/`vars`, `env`, `step`, `workflow`, `error`, plus an index signature escape hatch. (`request`/`response`/`vars` are legacy aliases.)

`unwrapProxies(value)` (`:143-177`):
- Functions with the `JS_EXPR_TAG` symbol → `"js/<tag>"` (`:151-158`); other functions pass through.
- Arrays → mapped recursively (`:160-162`).
- **Plain objects only** (proto `null` or `Object.prototype`) → walked, returning a **NEW** object (`:165-173`). **Class instances pass through untouched** (`:164` comment) — a deliberate boundary so e.g. a Zod schema or Date isn't mangled. Pure, never mutates input (`:141`).

---

## 8. The v1 legacy builder — `Workflow` / `Trigger.addTrigger` / `StepNode`

### `Workflow(config)` (`Workflow.ts:4-12`)
- `WorkflowOptsSchema.parse(config)` (`:5`) — throws on invalid envelope. `WorkflowOptsSchema` (`WorkflowOpts.ts:16-33`): `name` min 3, `version` **min 5** (`"Format required x.x.x"`), `steps`/`nodes`/`trigger` all **optional** and permissive (`trigger` is `z.record(TriggersSchema, z.unknown())` — kind validated, config not).
- **Mutates input** — `config.steps = []; config.nodes = {}` (`:6-7`) wiping any passed-in steps. Returns a `Trigger` builder.

### `Trigger.addTrigger(name, config)` (`Trigger.ts:26-50`)
- Typed overloads per kind (`:27-35`).
- `TriggersSchema.parse(name)` first (`:39`) — clear error on a typo'd kind before schema dispatch.
- `validateTriggerConfig(name, config)` (`:44`) — **same function the v2 factory uses** (`:200-201` comment in workflowV2 confirms intentional mirroring), so v1 and v2 produce identical trigger errors.
- Sets `_config.trigger = { [name]: validated }` (`:45`) and returns a `StepNode`.

### `StepNode.addStep` / `addCondition` (`StepNode.ts`)
- `addStep` (`:19-39`): `StepOptsSchema.parse(config)` (`:20`). The **v1 step schema** (`StepOpts.ts:64-85`) is structurally different: requires `name` (min 3), `node` (min **5**), `type` (required `NodeTypeSchema`, unlike v2 where `type` is optional/inferred). Splits inputs into a separate `nodes{}` map (`:22-25`) and pushes a slimmed step (`:27-34`) — the v1 "two-source-of-truth" shape the normalizer later collapses.
- `addCondition` (`:41-72`): validates via `StepConditionSchema` (`StepOpts.ts:93-96`), runs the supplied `conditions()` thunk (AddIf/AddElse `.build()` outputs), and flattens condition steps into `nodes{}`.

### `AddIf`/`AddElse` (`AddIf.ts`, `AddElse.ts`)
Imperative builders for the legacy condition shape; `.build()` runs a local `ConditionSchema`/`ConditionElseSchema` (`AddIf.ts:30-39`, `AddElse.ts:24-27`). `AddIf` requires a non-empty `condition` string (`:32-37`); both validate `steps` as `z.array(StepOptsSchema).optional()`.

---

## 9. Answers to the specific questions

**Can a trigger-less workflow be constructed?**
- **v2 factory: NO.** `workflowV2.ts:202-205` hard-throws `requires a trigger` whenever `Object.keys(opts.trigger ?? {}).length === 0` — **unconditionally, regardless of `middleware`** (the factory's `WorkflowOpts` interface at `:39-85` does **not even declare a `middleware` field**). 
- **`WorkflowV2Schema`: YES.** `trigger` is `.optional()` (`WorkflowOpts.ts:73-75`) and documents trigger-less as valid for middleware (`:78-80`).
- **This is a documented asymmetry / live bug** (`TASK-ts-middleware-registration.md` "Problem B"): the *envelope schema* permits trigger-less middleware, but the *TS factory the docs recommend* refuses to construct one (`workflowV2.ts:85` per the task's line numbering; `:203-205` in current source). A TS middleware author must declare a dummy `trigger.http.path`, which then accidentally exposes it as a real route.

**How is `middleware: true` expressed and is it validated?**
- **Envelope schema only:** `WorkflowV2Schema.middleware = z.literal(true).optional()` (`WorkflowOpts.ts:82-91`) — so it's validated to be exactly `true` *if the envelope schema runs*. But the v2 `workflow()` factory's input interface (`WorkflowOpts`, `workflowV2.ts:39-85`) **omits `middleware` entirely** — the factory neither requires, validates, nor copies it into `_config` (`:236-248` builds `_config` with no `middleware` field). So `middleware: true` passed to `workflow()` is silently dropped from the typed config object. JSON workflows (validated by the runner against `WorkflowV2Schema`) do get it validated. **This is the root of the TS-middleware bug** — the helper-side construction path doesn't carry `middleware` through.
- There is also a **trigger-level** `middleware` (different concept): an ordered array of middleware-workflow *names* on `HttpTriggerOptsSchema.middleware` (`TriggerOpts.ts:366-378`), `WebhookTriggerOptsSchema.middleware` (`:727-730`), and `McpTriggerOptsSchema.middleware` (`:805`). That one IS validated (`z.array(z.string().min(1))`).

**Can a middleware workflow be constructed (v2)?** Only by giving it a dummy trigger — and even then the `middleware: true` flag is dropped by the factory (see above). So a *correctly-flagged* TS middleware workflow effectively **cannot** be constructed via `workflow()` today.

---

## 10. Notable asymmetries / footguns (for downstream design)

1. **`workflow()` ignores `middleware`** while `WorkflowV2Schema` validates it — the helper factory and the envelope schema disagree on the workflow's own field set (`workflowV2.ts:39-85, 236-248` vs `WorkflowOpts.ts:82-91`).
2. **Trigger-less rejected by factory, allowed by schema** (`workflowV2.ts:203-205` vs `WorkflowOpts.ts:73-80`).
3. **`V2StepSchema` is a plain `z.union`, not `discriminatedUnion`** (`StepOpts.ts:867`) — order-dependent, regular step is the catch-all; a malformed control-flow step can fall through to regular-step validation with a misleading error.
4. **Only `wait` steps are `.strict()`** with `.never()` rejections (`StepOpts.ts:551-625`); every other step type silently tolerates unknown keys.
5. **Inner sub-pipeline steps are `z.array(z.unknown())`** in branch/forEach/loop/switch/tryCatch schemas — construction-time Zod does NOT validate them; only the outer `workflow()` per-step loop and the runner do.
6. **Worker has two unrelated "concurrency" fields** — `concurrency` (consumer count, default 1) vs `concurrencyKey`/`concurrencyLimit` (per-key gate) — `TriggerOpts.ts:550-556` + spread `ConcurrencyOptsFields`.
7. **v1 vs v2 step identity diverge** — v1 requires `name`(≥3)+`node`(≥5)+required `type` and a separate `nodes{}` map (`StepOpts.ts:64-85`, `StepNode.ts:22-34`); v2 uses `id`+`use`(inputs inline, `type` inferred). Version min-length also differs in spirit (both `.min(5)` but v2 factory uses `WorkflowV2Schema` only at load time).
8. **`Workflow()` mutates its input** (`Workflow.ts:6-7` wipes `config.steps`/`config.nodes`).
9. **`grpc`/`manual` triggers accept literally anything** including `undefined` (`TriggerOpts.ts:903-906`).
10. **SSE event check only catches literal event names** (`workflowV2.ts:134`) — dynamic `$.`/`js/` event names bypass the declared-vocabulary guard.

---

### Key file:line index
- v2 factory + `requires a trigger`: `core/workflow-helper/src/components/workflowV2.ts:177-261` (trigger guard `:203-205`; SSE check `:221-234`).
- `$` proxy: `core/workflow-helper/src/proxy/$.ts:83-121` (proxy), `:143-177` (`unwrapProxies`).
- Step schemas: `core/workflow-helper/src/types/StepOpts.ts:188-306` (regular), `:551-625` (wait), `:385-528` (subworkflow), `:857-877` (union).
- Trigger schemas: `core/workflow-helper/src/types/TriggerOpts.ts` — HTTP `:333-406`, worker `:544-595`, `TriggersSchema` `:814-827`, `TRIGGER_SCHEMAS` `:856-868`, `validateTriggerConfig` `:901-913`, trigger-level `middleware` `:366-378`.
- Workflow envelopes: `core/workflow-helper/src/types/WorkflowOpts.ts` — v1 `:16-33`, v2 `:63-118`, `middleware` literal `:82-91`.
- v1 builder: `Workflow.ts:4-12`, `Trigger.ts:26-50`, `StepNode.ts:19-72`, `AddIf.ts`, `AddElse.ts`.
- Control-flow factories: `branch.ts:47-82`, `forEach.ts:56-100`, `loop.ts:55-90`, `switchOn.ts:72-119`, `tryCatch.ts:66-98`.
- Public exports: `core/workflow-helper/src/index.ts:127-262`.

---

### Subsystem map: cli-scaffold

I now have the complete picture. The HTTP runner is copied as **local source** (`triggers/http/src/runner` → project's `src/triggers/http/runner`, lines 488-490) — so the HTTP trigger does not depend on a built `@blokjs/trigger-http` package. By contrast, the worker server's `index.ts` and `WorkerServer.ts` **import** `@blokjs/trigger-worker` (template lines 1-3) — a package dependency that needs `dist/`. This confirms the build asymmetry.

I have all the evidence needed. Let me produce the technical map.

---

# CLI Project Scaffold — Technical Map (`cli-scaffold` subsystem)

## Scope & entry points

The project-scaffold flow lives entirely in `packages/cli/src/commands/create/project.ts` (one 2182-line module exporting `createProject`), driven by flag definitions in `packages/cli/src/index.ts`. The worker/HTTP **template source** lives outside `packages/cli`, under the monorepo's `triggers/<kind>/` directories — the scaffold copies from there at create time.

`createProject(opts, version, currentPath, localRepoPath)` is invoked from `index.ts:114-122` (the `create project` action) and `:124-135` (the `create project .` in-place variant). The 4th arg `localRepoPath` (= `opts.local`, the `-l, --local <path>` flag) toggles the local-repo path that drives the `file:` linking discussed below.

---

## 1. Create flags (`packages/cli/src/index.ts:103-122`)

The `project` command declares these options:

| Flag | Line | Default |
|---|---|---|
| `-n, --name <value>` | 105 | — (presence makes the run non-interactive: `isDefault`, `project.ts:56`) |
| `-l, --local <path>` | 106 | — (local repo path; enables `file:` linking) |
| `-t, --trigger <value>` | 107 | single trigger, back-compat |
| `-T, --triggers <value>` | 108 | help text: `http,sse,pubsub,queue` |
| `-r, --runtimes <value>` | 109 | `node` |
| `-m, --package-manager <value>` | 110 | `npm` |
| `--pubsub-provider <value>` | 111 | help: `gcp, aws, azure (default: gcp)` |
| `--queue-provider <value>` | 112 | help: **`kafka, rabbitmq, sqs, redis (default: kafka)`** |
| `--examples` | 113 | off |

### Key finding: there is NO `--worker-provider` flag
The **only** worker-related provider flag is `--queue-provider` (`index.ts:112`). The worker trigger is selected by including `worker` (or `queue`) in `--triggers`, and its broker adapter is chosen by `--queue-provider`. The flag's help text doesn't even mention `worker` or `nats` — but the code accepts both: `worker` is treated as an alias of `queue` throughout (`project.ts:428-451`, `1081`, `1090`, `2121`, `2177`), and `nats` is a valid `queueProvider` value in the adapter map (`project.ts:2056-2063`) and prompt list (`:192`) even though the flag help omits it.

### Default queueProvider value
`let queueProvider: string = opts.queueProvider || "kafka";` — `project.ts:71`. Re-derived identically after interactive prompts (`:218`) and `pubsubProvider` defaults to `gcp` (`:70`, `:217`). **The worker default broker is Kafka.**

---

## 2. Trigger template copy + provider injection (`project.ts:421-453`)

For `pubsub`/`queue`/`worker` triggers, the scaffold copies a `template/src` directory wholesale (`:428-433`):

- `worker` and `queue` both map to the **`worker`** template package dir: `const templatePkgDir = triggerKind === "queue" || triggerKind === "worker" ? "worker" : triggerKind;` (`:429`). Template root: `${repoSource}/triggers/worker/template/src` (`:430`).
- Template workflows are relocated to the shared `src/workflows/<kind>` (`:436-440`); the template's own `Nodes.ts`/`Workflows.ts` are deleted in favor of generated shared ones (`:444-445`, generated at `:510-516`).
- **Adapter injection:** `updateQueueProvider(triggerDestDir, queueProvider)` is called for `queue`/`worker` (`:450-451`), `updatePubSubProvider(...)` for `pubsub` (`:448-449`).

The HTTP trigger takes a different branch (`:484-497`): it **cherry-copies `runner/` as local source** (`triggers/http/src/runner` → project `src/triggers/http/runner`) plus `AppRoutes.ts` and `workflows`. There is **no `triggers/http/template/` directory** — confirmed by `find` (HTTP ships as importable source, not a package-import template).

---

## 3. How the generated `WorkerServer.ts` gets its adapter

### The on-disk template (`triggers/worker/template/src/runner/WorkerServer.ts`)
The shipped template hardcodes **NATS**, not Kafka:

```ts
// triggers/worker/template/src/runner/WorkerServer.ts:1, 27-34
import { NATSWorkerAdapter, WorkerTrigger } from "@blokjs/trigger-worker";
...
export default class WorkerServer extends WorkerTrigger {
  protected adapter = new NATSWorkerAdapter({
    servers: (process.env.NATS_SERVERS || "localhost:4222").split(","),
  });
  protected nodes: Record<...> = nodes;
  protected workflows: Record<...> = workflows;
}
```

### `updateQueueProvider` rewrites it via two regexes (`project.ts:2019-2082`)
`updateQueueProvider(triggerDestDir, provider)` reads the copied `runner/WorkerServer.ts` (`:2020-2023`), looks up `provider` in an `adapterConfigs` map (`:2025-2064`) covering `kafka`, `rabbitmq`, `sqs`, `redis` (→ `BullMQAdapter`, `:2045-2055`), and `nats` (→ `NATSWorkerAdapter`, `:2056-2063`), then:

1. **Import rewrite** (`:2070-2073`): replaces `import { X, Y } from "@blokjs/trigger-worker";` with `import { <Adapter>, WorkerTrigger } from "@blokjs/trigger-worker";`.
2. **Adapter rewrite** (`:2077-2080`): regex `/(export default class \w+ extends WorkerTrigger \{[\s\S]*?)\n\tprotected adapter = new \w+\(\{[\s\S]*?\}\);/` replaces the class-body `protected adapter = new <X>({...});` with the chosen `config.init`.

Since `queueProvider` defaults to `kafka`, a worker scaffold created with no `--queue-provider` flag produces a `WorkerServer.ts` whose `protected adapter = new KafkaAdapter({...})` (`:2028-2031`) — **exactly the first-run-crash footgun documented in `TASK-worker-trigger-fixes.md` Problem 1**. (The template's own NATS default would crash too without a broker; the only zero-dep boot is `in-memory`, which the scaffold never injects.) The matched `config` returns early if `provider` is unknown (`:2067`), leaving the template's NATS adapter in place.

### Why `this.adapter` defeats `provider`/`BLOK_WORKER_ADAPTER` (asymmetry)
`WorkerTrigger.resolveAdapterForWorkflow` (`triggers/worker/src/WorkerTrigger.ts:469-495`) documents the intended precedence as: (1) subclass `this.adapter`, (2) per-workflow `provider`, (3) `BLOK_WORKER_ADAPTER` env, (4) `in-memory` fallback (`:458-462`). The code checks `this.adapter` **first** and returns immediately if set (`:471-480`). So any hardcoded `protected adapter = ...` the scaffold emits **silently overrides** a user's `trigger.worker.provider` or `BLOK_WORKER_ADAPTER=in-memory` — the documented config surface appears broken. The factory-driven path (steps 2-4) only runs when `this.adapter` is falsy (`:482-494`).

### Dead workflow-provider patch (`project.ts:2084-2090`)
After rewriting the server, `updateQueueProvider` tries to sync an example workflow's `provider` field:
```ts
const workflowPath = `${triggerDestDir}/workflows/messages/on-message.ts`;  // :2085
... workflowContent.replace(/provider: "kafka"/, `provider: "${provider}"`); // :2088
```
This is a **no-op against the current template**: the template has no `workflows/messages/on-message.ts` (only `workflows/jobs/process-job.ts`, verified), the workflows directory was already moved to shared at `:436-440` before this runs (so `triggerDestDir/workflows` no longer exists), and `process-job.ts` carries **no `provider:` field** at all (verified — only `vitest.config.ts` has a `provider:` key). Stale code targeting a renamed/relocated template.

### Generated `index.ts` is preserved, not regenerated
`worker`/`queue`/`pubsub` are in `triggersWithRealTemplate` (`:525`), so the scaffold **skips** generating a placeholder entry (`:526-530`) and keeps the template's `src/index.ts`, which does `new WorkerServer()` then `await this.workerServer.listen()` (`triggers/worker/template/src/index.ts:3, 20, 25`).

---

## 4. `.env.local` writing — what is written, and under what conditions

`.env.local` is built up incrementally:

1. **Base (always):** `project.ts:667-674` — reads the template `.env.example`, substitutes `PROJECT_PATH` → absolute `dirPath`, writes `.env.local`. For a worker, the worker template's `.env.example` contributes `PORT=4008`, `WORKFLOWS_PATH`, `NODES_PATH`, and a **NATS block** (`NATS_SERVERS=localhost:4222`, `NATS_STREAM_NAME=blok-worker`) — see `triggers/worker/template/.env.example:1-13`.
2. **Runtime env (conditional):** if runtimes were set up, `generateRuntimeEnvVars(...)` is **appended** (`:930-934`).
3. **Trigger env (conditional):** if `triggerConfigs.length > 0`, `generateTriggerEnvVars(...)` appended (`:940-944`).
4. **Provider env (conditional):** `getProviderEnvVars(selectedTriggers, pubsubProvider, queueProvider)` appended if non-empty (`:946-950`).
5. **`--examples` block (conditional):** if `examples`, a chat/webhook/worker-fanout block is appended (`:960-991`).

### `getProviderEnvVars` (`project.ts:2131-2182`)
Returns env lines gated by trigger membership:
- Pub/Sub: appended only if `triggers.includes("pubsub")` AND the provider key exists (`:2173-2175`).
- Queue/Worker: appended if `(triggers.includes("queue") || triggers.includes("worker"))` AND `queueEnvVars[queueProvider]` exists (`:2177-2179`).

The `queueEnvVars` map (`:2149-2171`) writes a provider-specific block. **For the default `kafka`** it writes:
```
# Apache Kafka
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=blok-queue-trigger
KAFKA_GROUP_ID=blok-consumer-group   (:2150-2154)
```
Other providers: `rabbitmq` → `RABBITMQ_URL` (`:2155-2157`), `sqs` → `AWS_REGION`+`SQS_QUEUE_URL` (`:2158-2161`), `redis` → `REDIS_HOST/PORT/PASSWORD` (`:2162-2166`), `nats` → `NATS_SERVERS`+`NATS_STREAM_NAME` (`:2167-2170`).

### Asymmetry / footgun in env writing
- A default worker scaffold gets **two conflicting NATS/Kafka stories** in `.env.local`: the template `.env.example` already wrote a NATS block (step 1), then `getProviderEnvVars` appends a **Kafka** block (step 4, default provider) — while `updateQueueProvider` rewired the server to `KafkaAdapter`. The NATS env is now dead, and the Kafka env reinforces a broker the user likely doesn't have.
- **`BLOK_WORKER_ADAPTER=in-memory` is only ever written on the `--examples` path** (`project.ts:986`, inside the chat-env block at `:960-990`). The plain (non-examples) worker scaffold **never** writes `BLOK_WORKER_ADAPTER`, and even if it did, the hardcoded `this.adapter` would override it (§3). So the documented dev-friendly default is reachable only via `--examples`, and even then is masked by the subclass adapter.
- The `--examples` block (`:981-987`) explicitly comments the in-memory adapter's single-process limitation and lists `BLOK_WORKER_ADAPTER` overrides — guidance that contradicts the hardcoded-adapter reality of the generated `WorkerServer.ts`.

### Post-scaffold infra hints (console only, `project.ts:1080-1097`)
For `queueProvider === "redis"` (`:1081`) or `nats` (`:1090`), the scaffold prints Docker setup instructions. **There is no equivalent hint for `kafka`** — the default provider gets no "you need a broker" warning, so the first-run crash arrives with no setup guidance.

---

## 5. Provider dependencies (`getProviderDependencies`, `project.ts:2096-2126`)

Called at `:794-799` to add npm deps. Queue/worker deps (`:2109-2115`): `kafka` → `kafkajs ^2.2.4`, `rabbitmq` → `amqplib`, `sqs` → `@aws-sdk/client-sqs`, `redis` → `ioredis`+`bullmq`, `nats` → `nats ^2.28.0`. Gated by `(triggers.includes("queue") || triggers.includes("worker"))` (`:2121`). So a default worker scaffold pulls in `kafkajs` as a runtime dep — matching the injected `KafkaAdapter`.

---

## 6. What a `--local` scaffold still needs to build

The `--local <path>` flag sets `localRepoPath`, which switches `workspace:*` deps to local `file:` links via `workspacePackageMap` (`project.ts:693-713`, applied at `:734-758`) and adds `overrides`/`resolutions` for transitive workspace deps (`:760-770`). The worker package is mapped: `"@blokjs/trigger-worker": "triggers/worker"` (`:712`).

### The build asymmetry (confirms `TASK-worker-trigger-fixes.md` secondary observation)
- **HTTP needs no package build:** the HTTP trigger is copied as **local source** into the project (`:488-490`, `runner/` + `AppRoutes.ts`), and `@blokjs/trigger-http` is **not** in `workspacePackageMap` — the project never imports it as a package.
- **Worker DOES need a built package:** the generated `WorkerServer.ts` and `index.ts` `import ... from "@blokjs/trigger-worker"` (template `WorkerServer.ts:1`, `index.ts:3`). With `--local`, that resolves to `file:.../triggers/worker`, whose `package.json` has `"main": "dist/index.js"`, `"types": "dist/index.d.ts"`, and build script `rm -rf dist && bun run tsc` (verified). The link points at a **`dist/`** that must exist.
- **The root `build` script does NOT build any trigger package.** `package.json:49`:
  ```
  build = bun run --filter @blokjs/shared --filter @blokjs/helper build
        && bun run --filter @blokjs/runner build
        && bun run --filter blokctl --filter @blokjs/api-call --filter @blokjs/if-else
           --filter @blokjs/react --filter @blokjs/helpers --filter node-name --filter node-ui-name build
  ```
  No `@blokjs/trigger-worker` (nor trigger-pubsub/sse/etc.). So a fresh `--local` checkout that ran only `bun run build` has an **unbuilt** `triggers/worker/dist`, and the scaffolded worker fails to import the package until you run `bun run --filter @blokjs/trigger-worker build` manually. (A `dist/` happens to exist in this working tree from prior builds, but that's incidental, not guaranteed by the documented build.) The same gap applies to any other package-import trigger scaffolded with `--local` (pubsub, and the `file:`-linked trigger-cron/grpc/mcp/sse/webhook/websocket from the map at `:701-707`).

Independently, every scaffold runs `manager.INSTALL` (`:1029`) and hard-fails if `node_modules` is absent (`:1033-1035`), but **never compiles** the linked trigger packages — that's left to the user.

---

## Summary of surprising / asymmetric behaviors

1. **`--queue-provider` defaults to `kafka` and there is no `--worker-provider` flag** (`index.ts:71,112`). A bare `--triggers worker` produces a Kafka-wired server that crashes on boot without a broker.
2. **Template default ≠ injected default.** The shipped `WorkerServer.ts` template hardcodes **NATS** (`triggers/worker/template/.../WorkerServer.ts:28`), but `updateQueueProvider` rewrites it to **Kafka** for the default `queueProvider` (`project.ts:2028-2031, 2066-2080`). The bug write-up's "hardcoded Kafka" symptom is produced by the *injection*, not the template.
3. **`this.adapter` overrides the entire documented provider-resolution chain** (`WorkerTrigger.ts:471-480`), so the scaffold's hardcoded adapter silently defeats `trigger.worker.provider` and `BLOK_WORKER_ADAPTER`.
4. **`.env.local` ends up self-contradictory** for a default worker: template-written NATS block + provider-written Kafka block + a Kafka-wired server. `BLOK_WORKER_ADAPTER=in-memory` is written **only** under `--examples` (`project.ts:986`).
5. **No Kafka infra hint** despite Kafka being the default (`:1080-1097` only cover redis/nats).
6. **Dead workflow-provider patch** at `project.ts:2085-2090` targets a non-existent `workflows/messages/on-message.ts` with a non-existent `provider:` field.
7. **HTTP is copied as source (no build), worker imports a package (needs `dist/`)**, and the root `build` script (`package.json:49`) builds neither trigger package — so `--local` worker scaffolds need a manual `bun run --filter @blokjs/trigger-worker build`.

### Key file:line references
- Flags / defaults: `packages/cli/src/index.ts:103-122`; `project.ts:70-71, 217-218`
- Provider prompts: `project.ts:181-195`
- Template copy + provider call: `project.ts:421-453`
- `updateQueueProvider`: `project.ts:2019-2091` (Kafka init `:2028-2031`; regexes `:2070-2073, 2077-2080`; dead patch `:2085-2090`)
- `.env.local` base write: `project.ts:667-674`; appends `:930-950, 960-991`
- `getProviderEnvVars`: `project.ts:2131-2182` (Kafka block `:2150-2154`)
- `getProviderDependencies`: `project.ts:2096-2126`
- `--local` linking: `project.ts:693-713, 734-770`; root build: `package.json:49`
- Worker template: `triggers/worker/template/src/runner/WorkerServer.ts:1,27-34`; `.../src/index.ts:3,20,25`; `.../.env.example:1-13`; `.../src/workflows/jobs/process-job.ts`
- Adapter precedence: `triggers/worker/src/WorkerTrigger.ts:458-495`

---

### Subsystem map: worker-adapters

I now have a complete and verified picture of the worker-adapter subsystem. Here is the detailed technical map.

---

# Worker-Adapter Subsystem — Technical Map

## 1. Overview & file inventory

The worker-adapter system lets a `WorkerTrigger` subclass consume background jobs from any of 8 brokers behind a single `WorkerAdapter` interface. Adapter selection is **per-workflow** (v0.7 PR 5), with several fallback layers and one back-compat override.

| File | Role |
|---|---|
| `triggers/worker/src/WorkerTrigger.ts` | Abstract trigger; `WorkerAdapter`/`WorkerJob`/`WorkerQueueStats` interfaces; `resolveAdapterForWorkflow`, `handleJob`, lifecycle |
| `triggers/worker/src/adapters/factory.ts` | `resolveProvider`, `createWorkerAdapter`, `getOrCreateAdapter`, process-singleton pool |
| `triggers/worker/src/adapters/InMemoryAdapter.ts` | `provider="in-memory"` — in-process polling queue, no peer deps |
| `triggers/worker/src/adapters/NATSAdapter.ts` | `NATSWorkerAdapter`, `provider="nats"` — JetStream pull consumer |
| `triggers/worker/src/adapters/BullMQAdapter.ts` | `provider="bullmq"` — Redis-backed (`bullmq`+`ioredis`) |
| `triggers/worker/src/adapters/KafkaAdapter.ts` | `provider="kafka"` — `kafkajs` consumer group |
| `triggers/worker/src/adapters/RabbitMQAdapter.ts` | `provider="rabbitmq"` — `amqplib` direct queue |
| `triggers/worker/src/adapters/SQSAdapter.ts` | `provider="sqs"` — `@aws-sdk/client-sqs` long-poll |
| `triggers/worker/src/adapters/RedisStreamsAdapter.ts` | `provider="redis"` — `ioredis` consumer group on streams |
| `triggers/worker/src/adapters/PgBossAdapter.ts` | `provider="pg-boss"` — Postgres-backed `pg-boss` |
| `triggers/worker/src/index.ts` | Package exports |
| `core/workflow-helper/src/types/TriggerOpts.ts:522-595` | `WorkerProviderSchema` (8-value enum) + `WorkerTriggerOptsSchema` |

---

## 2. Core types

**`WorkerAdapter`** (`WorkerTrigger.ts:79-125`) — every adapter implements: `readonly provider: string`, `connect()`, `disconnect()`, `process(config, handler)`, `addJob(queue, data, opts)`, `stopProcessing(queue)`, `isConnected()`, `healthCheck()`, `getQueueStats(queue)`.

**`WorkerJob`** (`WorkerTrigger.ts:47-74`) — normalized job envelope. The two behavioral methods are `complete(): Promise<void>` and `fail(error, requeue?): Promise<void>`. Each adapter constructs these closures over its native message and maps them to broker-specific ACK/NACK.

**`WorkerTriggerOpts`** (`TriggerOpts.ts:544-595`) — the `trigger.worker` config: `queue` (required), `provider?` (the enum), `concurrency` (default 1), `timeout?` (ms), `retries` (default 3), `priority` (default 0), `consumerGroup?`, `ack?`, `deadLetterQueue?`, `fromBeginning?` (Kafka-only), plus spread-in `ConcurrencyOptsFields` and `SchedulingOptsFields` (`delay`/`ttl`/`debounce`).

**`WorkerProvider`** (`TriggerOpts.ts:532-542`) — `z.enum(["in-memory","nats","bullmq","kafka","rabbitmq","sqs","redis","pg-boss"])`. The Zod enum catches typos at workflow load; `factory.ts:isWorkerProvider` (line 43-54) re-validates env-var strings at runtime, and `createWorkerAdapter`'s `default` arm (factory.ts:79-83) has a `never`-typed exhaustiveness guard that throws `unknown provider "..."`.

---

## 3. Provider resolution — the EXACT precedence

There are **two layers**: `WorkerTrigger.resolveAdapterForWorkflow` (the outer decision) and `factory.resolveProvider` (the inner string resolution). The full precedence, highest → lowest:

### Layer A — `resolveAdapterForWorkflow(config)` (`WorkerTrigger.ts:469-495`)
```
1. this.adapter (subclass field)  ← ABSOLUTE WINNER — short-circuits everything below
   ↓ (only if this.adapter is undefined)
2. resolveProvider(config.provider) via the factory
```
- **`WorkerTrigger.ts:471-480`**: if `this.adapter` is truthy, it is connected (if not already), health-registered, pool-tracked under `this.adapter.provider`, and returned. **`config.provider` and `BLOK_WORKER_ADAPTER` are never consulted.** This is the documented footgun — see §7.
- **`WorkerTrigger.ts:484-493`**: otherwise lazy-imports the factory, calls `resolveProvider(config.provider)`, then pool-gets-or-creates.

### Layer B — `resolveProvider(provider?)` (`factory.ts:36-41`)
```
2a. config.provider  (the per-workflow trigger.worker.provider field)  ← if truthy, return it
2b. process.env.BLOK_WORKER_ADAPTER  ← if set AND isWorkerProvider() validates it
2c. "in-memory"  ← unconditional fallback
```
Invalid env values are silently ignored and fall through to `in-memory` (factory.test.ts:37-40 asserts this).

**Net precedence (canonical):**
> **`this.adapter` (subclass) ≫ `trigger.worker.provider` (per-workflow) ≫ `BLOK_WORKER_ADAPTER` (env) ≫ `"in-memory"` (default)**

The docstrings at `WorkerTrigger.ts:455-468` and `factory.ts:10-17` both state this order. Note the **asymmetry**: `this.adapter` is checked in `WorkerTrigger`, while the other three are decided in `factory.resolveProvider` — so a subclass adapter bypasses the factory and its pool-by-provider logic entirely (it still gets *manually* inserted into `adapterPool` at line 478, but keyed by `this.adapter.provider`, not derived from any config).

---

## 4. Lifecycle, pooling, and the two pools

There are **two distinct pools** — easy to confuse:

1. **`WorkerTrigger.adapterPool`** (instance field, `WorkerTrigger.ts:200`) — `Map<string, WorkerAdapter>` keyed by **provider name**, populated lazily in `resolveAdapterForWorkflow`. One connected adapter per provider, shared across all workflows in this trigger instance that resolve to the same provider (`WorkerTrigger.ts:486-493`). Drained in `stop()`.

2. **`factory.pool`** (module-global, `factory.ts:95`) — a *separate* process-singleton `Map<WorkerProvider, WorkerAdapter>` used **only** by `getOrCreateAdapter` (factory.ts:97-104). **`WorkerTrigger` does NOT use `getOrCreateAdapter`** — it calls the lower-level `createWorkerAdapter` (factory.ts:488) and manages its own `adapterPool`. The factory pool exists for the `@blokjs/worker-publish` helper node (per factory.ts:86-93 / index.ts:83-91) so dispatch-only callers share a connection. `_resetAdapterPoolForTests()` (factory.ts:106-111) drains and clears only the factory pool.

### Connect lifecycle
- Adapters are **constructed disconnected** (`connected=false`); construction only reads env/config into `this.config` (e.g. `KafkaAdapter.ts:80-88`, `BullMQAdapter.ts:61-71`). No I/O at construction.
- `connect()` is **idempotent** via the `if (this.connected) return` guard (every adapter, e.g. `KafkaAdapter.ts:91`, `NATSAdapter.ts:96`).
- In `listen()` (`WorkerTrigger.ts:338-350`), each worker workflow → `resolveAdapterForWorkflow` → `adapter.process(config, handler)`. First touch of a provider connects it and registers a `/health` dependency named `worker-<provider>` (`WorkerTrigger.ts:497-506`).

### Stop / drain (`WorkerTrigger.ts:369-394`)
For each active queue, calls `stopProcessing(queue)` on **every** adapter in the pool (line 372-379), swallowing errors since an adapter may not own that queue (an O(queues × adapters) scattershot). Then `disconnect()`s every pooled adapter (line 384-390) and clears both `adapterPool` and `activeQueues`.

`disconnect()` is also idempotent (`if (!this.connected) return`, e.g. `InMemoryAdapter.ts` via `connected` flag, `KafkaAdapter.ts:118`). The poll/loop-based adapters (SQS `SQSAdapter.ts:95-114`, Redis `RedisStreamsAdapter.ts:106-125`) actively **drain in-flight loops** with a 2s deadline busy-wait before tearing down the client.

---

## 5. Per-adapter dispatch / consume / failure semantics

| Adapter | Consume mechanism | `complete()` | `fail(err, requeue)` | Retry source | Stats `waiting` |
|---|---|---|---|---|---|
| **InMemory** | `setInterval` 50ms poll (`InMemoryAdapter.ts:103-107`) | splice from array, `stats.completed++` (`:239`) | requeue→`delayed` w/ exponential backoff capped 30s (`:250-254`); else `failed` | client-side, in `fail` closure | array filter by status |
| **NATS** | JetStream pull consumer + custom `Semaphore` (`NATSAdapter.ts:184-280`) | `msg.ack()` (`:242`) | `requeue`→`msg.nak()` else `msg.term()` (`:244-252`) | broker `max_deliver = retries+1` (`:170`) | `info.num_pending` |
| **BullMQ** | `new Worker(queue, cb)`, BullMQ owns loop (`:145-184`) | no-op (BullMQ auto-completes on resolve) (`:170-172`) | `!requeue`→`moveToFailed`; `requeue`→**`throw`** so BullMQ auto-retries (`:173-179`) | BullMQ `attempts=retries+1` (`:236`) | live `getWaitingCount()` |
| **Kafka** | `consumer.run({eachMessage})` (`:150-198`) | `stats.completed++` only (`:179-181`) | `stats.failed++` then **`throw`** (`:182-185`) | none broker-side; offset commit suppressed → re-poll (`:151` `autoCommit`) | sum of committed offsets (approx) (`:264`) |
| **RabbitMQ** | `channel.consume`, `prefetch(concurrency)` (`:118-207`) | `channel.ack`, `settled` guard (`:170-175`) | `channel.nack(msg,false,requeue && !exceeded)` (`:176-182`) | client-side attempt count via `x-blok-attempt` header vs `maxAttempts` | live `checkQueue().messageCount` |
| **SQS** | N parallel long-poll loops (`:124-237`) | `DeleteMessageCommand` (`:192-204`) | **no delete** → visibility-timeout return (`:205-213`) | SQS redrive policy + `MaxReceiveCount` (broker) | `ApproximateNumberOfMessages` |
| **Redis Streams** | N `XREADGROUP BLOCK` loops (`:150-228`) | `XACK` (`:205-208`) | just `stats.failed++`; entry left unacked → `XPENDING` (`:209-211`) | "run XAUTOCLAIM out of band" (no built-in redrive) | `XLEN` |
| **pg-boss** | `boss.work(queue, {batchSize:1}, handler)` (`:128-142`) | `stats.completed++` (`:170-174`) | `stats.failed++` then **`throw`** (`:175-184`) | pg-boss native (`retryLimit`) | `getQueueSize` |

### The `settled` flag pattern (ASYMMETRIC — only 4 of 8 adapters)
RabbitMQ (`:158`), SQS (`:168`), pg-boss (`:158`) — and partially the wrapping logic — use a `let settled` flag to prevent **double-ACK / double-stat-counting** when both the `WorkerJob.complete/fail` closure AND the wrapper try/catch try to settle the same delivery. The comments cite real-broker integration tests (`rabbitmq-adapter.real-rabbitmq.test.ts`, `sqs-adapter.real-sqs.test.ts`, `pgboss-adapter.real-pg.test.ts`) — RabbitMQ would otherwise hit `PRECONDITION_FAILED` and close the channel (`RabbitMQAdapter.ts:150-158`). **Kafka, NATS, Redis, InMemory do NOT use this flag** — Kafka/NATS/Redis double-increment `stats.completed` on the happy path (e.g. Kafka `:180` in `complete()` AND `:190` in wrapper both `+= 1`; Redis `:207` and `:215`), an inconsistency in stats accounting across adapters.

### Other notable per-adapter asymmetries
- **NATS `x-delay` is consumer-side, not broker-side.** `computeXDelayHoldMs` (`NATSAdapter.ts:41-45`) holds via `setTimeout` inside the handler (`:262-265`) — JetStream stores the header as opaque metadata and does NOT defer delivery. Single-process semantics only.
- **Kafka has no broker-side retry** (`KafkaAdapter.ts:10-16`): on handler throw it re-throws, suppressing offset commit so the message re-polls next cycle — effectively an infinite redelivery loop until a DLQ topic is layered. `config.retries` only sizes `maxRetries` on the job (`:175`) for the trigger's own retry math.
- **SQS/Redis `fail()` are nearly no-ops** — they rely entirely on broker mechanics (visibility timeout / XPENDING). `requeue` is ignored.
- **Redis `addJob` has a dead `NOMKSTREAM` arg** — `args` array is built (`RedisStreamsAdapter.ts:245-246`) but never passed to `xadd` (`:247`); a latent bug.
- **`config.ack === false`** (auto-ACK / at-most-once) is honored by Kafka (`autoCommit`, `:151`), RabbitMQ (`noAck`, `:204`/`:187`), SQS (`:216`), Redis (`:214`). InMemory/NATS/BullMQ/pg-boss ignore it.

---

## 6. `handleJob` — the trigger-side outcome routing (`WorkerTrigger.ts:535-748`)

After an adapter invokes `handler(job)`, control lands in `handleJob`, which wraps the run in an OTel span and routes the result. The **catch arm has a strict precedence of special-cased errors** before generic retry:

1. `DeferredDispatchSignal` (`:634-647`) → **ACK without requeue** (`job.complete()`); the in-process scheduler owns redispatch, so requeueing would duplicate.
2. `QueueExpiredError` (`:654-666`) → **ACK without requeue**; run already flipped to `expired`.
3. `ConcurrencyLimitError` (`:675-695`) → **NACK with requeue** (`job.fail(error, true)`) — always `willRetry:true` regardless of `job.attempts`; throttling is transient, doesn't consume retry budget.
4. Generic failure (`:697-743`) → `shouldRetry = job.attempts < job.maxRetries`. If retry: `job.fail(err, true)` after computing `calculateBackoff` (`:716`, exponential `min(base·2^n, 30s)+10% jitter`, `:775-781`). Else: `job.fail(err, false)` → DLQ.

Success path (`:625-626`) calls `job.complete()`. Timeout enforcement: if `config.timeout>0`, `executeWithTimeout` (`:753-769`) races `this.run(ctx)` against a `setTimeout` reject. Middleware chain (process-global→workflow→trigger) is applied on the **same ctx** before the run (`:595`).

---

## 7. Failure modes & known issues

- **Kafka connect-retry storm + bad scaffold default (`TASK-worker-trigger-fixes.md` Problem 1).** A scaffolded `WorkerServer` hardcodes `protected adapter = new KafkaAdapter(...)`. Because `this.adapter` is the absolute precedence winner (`WorkerTrigger.ts:471`), `BLOK_WORKER_ADAPTER=in-memory` and `trigger.worker.provider` are silently ignored. With no broker, `kafkajs` emits ~6 escalating-backoff connection errors, then `connect()` throws `[blok][kafka] connect failed` (`KafkaAdapter.ts:110-114`), which propagates out of `listen()`'s try/catch (`WorkerTrigger.ts:360-363`) and is caught by the crash-autoflip `unhandledRejection` handler → process dies on boot. Fix is in the CLI scaffold (`packages/cli/src/commands/create/project.ts:2027-2078`), not this subsystem — but the **precedence design** is what makes it unrecoverable via config.

- **InMemory is per-process (by design).** `InMemoryAdapter` holds jobs in instance `Map`s (`InMemoryAdapter.ts:59-61`). Dispatch (`addJob`) and consume (`process`) only connect if they share the *same adapter instance in the same process*. An out-of-process `dispatch()` cannot reach a separately-running consumer's queue (no broker, no IPC). The 50ms `setInterval` poll adds up to 50ms latency. Correct for dev/test, surprising for dispatch→consume testing across processes (`TASK-worker-trigger-fixes.md` secondary note).

- **Dotted workflow names break the worker run path** (`TASK-worker-trigger-fixes.md` Problem 2) — not adapter code, but it manifests on every worker job: `LocalStorage.get()` (`core/runner/src/LocalStorage.ts:20-31`) treats a `.` as a file extension, throwing `File type not supported: site` for a workflow named `publish.site`. The HTTP trigger resolves by name via `WorkflowRegistry`; the worker path doesn't.

- **`dispatch()` / `getQueueStats()` before `listen()` throw** (`WorkerTrigger.ts:424-428`, `:439-443`) — they require either `this.adapter` set or a non-empty `adapterPool`. When dispatching via the pool they pick **the first pool adapter arbitrarily** (`:421-423`), which is wrong if multiple providers are active.

- **Stats double-counting** on Kafka/NATS/Redis (see §5) — `completed` can be inflated 2× on the happy path because those adapters lack the `settled` guard.

- **pg-boss is the only SDK not installed in the monorepo** (`new-adapters.test.ts:122-129`), so its peer-dep error path is the only one unit-tested; the others' missing-peer errors only surface in the docker-compose integration suite.

---

## 8. Key file:line index

- Provider precedence: `WorkerTrigger.ts:469-495` (Layer A), `factory.ts:36-41` (Layer B)
- `this.adapter` override: `WorkerTrigger.ts:189`, `:471-480`
- Factory pool (helper-node use): `factory.ts:95-111`
- Trigger pool (per-trigger): `WorkerTrigger.ts:200`, `:486-493`, drained `:369-394`
- `createWorkerAdapter` switch + exhaustiveness guard: `factory.ts:61-84`
- `handleJob` error routing: `WorkerTrigger.ts:634-743`
- Backoff: `WorkerTrigger.ts:775-781`
- Schema: `core/workflow-helper/src/types/TriggerOpts.ts:532-595`
- `settled` flag adapters: `RabbitMQAdapter.ts:158`, `SQSAdapter.ts:168`, `PgBossAdapter.ts:158`
- NATS consumer-side delay: `NATSAdapter.ts:41-45`, `:262-265`

---

### Subsystem map: execution-persistence

I now have everything needed, with confirmed cross-references. Here is the technical map.

---

# Subsystem Map: Execution + State Persistence (`@blokjs/runner`)

This maps the step-execution loop, the state-persistence rules, and how flow/sub-workflow steps execute. All file:line references verified against source.

## 1. The four players and how they connect

| File | Role |
|---|---|
| `core/runner/src/RunnerSteps.ts` | The step loop. Iterates steps, drives retry/timeout/cancel/wait/idempotency, recurses for flow steps, owns error-unwrapping. |
| `core/shared/src/NodeBase.ts` | `process()` / `processFlow()` — the thin wrapper RunnerSteps calls per step; runs the blueprint mapper then delegates to each node's `run()`. |
| `core/runner/src/Blok.ts` | `BlokService.run()` — base class for `defineNode`/module nodes. Validates, calls `handle()`, calls `applyStepOutput`. |
| `core/runner/src/RuntimeAdapterNode.ts` | `run()` for `runtime.*` (gRPC/HTTP) nodes. Bridges `ExecutionResult` → `ResponseContext`, calls `applyStepOutput`. |
| `core/runner/src/SubworkflowNode.ts` | `run()` for `subworkflow:` steps. Looks up child, builds child ctx, runs child, calls `applyStepOutput`. |
| `core/runner/src/workflow/PersistenceHelper.ts` | `applyStepOutput` — the single, centralized state-write decision (the error guard + ephemeral/spread/as rules). |

**Key architectural fact:** there are **three** call sites for `applyStepOutput` — `Blok.run` (`Blok.ts:147`), `RuntimeAdapterNode.run` (`RuntimeAdapterNode.ts:111`), and `SubworkflowNode` (four times: `:290`, `:465`, `:499`, `:547`). The idempotency cache-hit path in RunnerSteps is a **fourth** caller (`RunnerSteps.ts:554`). Persistence is owned by the node's `run()`, NOT by RunnerSteps — RunnerSteps never writes `ctx.state` directly except via the cache-hit `applyStepOutput`.

## 2. Control flow: `RunnerSteps.runSteps`

Signature: `runSteps(ctx, steps, deep=false, step_name="")` → `Promise<Context>` (`RunnerSteps.ts:142`).

### 2.1 Per-call setup (`:143`–`:184`)
- `ctx.config = { ...ctx.config }` — shallow clone so config mutation by the mapper doesn't leak across calls (`:143`).
- `tracker` is non-null only when `ctx._traceRunId` is set (`:145`–`:146`). **Tracing-gated behavior is pervasive:** idempotency cache, retry-attempt events, resume cursors, and wait persistence all no-op when the tracker is inactive (`BLOK_TRACE_ENABLED=false`).
- **Resume cursor** computation (`:164`–`:177`): two sources.
  - Top-level (`deep===false`): `workflow_runs.lastCompletedStepIndex + 1` (or `0`).
  - Nested (`deep===true`): `_blokInnerResumeIndex` stamped on the child ctx by a primitive (ForEachNode), else `0`.
  - The inner sentinel is cleared after read (`:182`–`:184`) so it fires for one re-entry only.

### 2.2 The loop (`:186`–`:761`) — order of guards per step
For each `step` at index `i`:

1. **Resume skip** (`:192`–`:197`): `if (i < resumeFromIndex) continue;` — skips pre-wait steps already done on the first pass. State from pass 1 is still on `ctx.state`.
2. **Cancellation check** (`:205`–`:207`): `if (ctx.signal?.aborted) throw new RunCancelledError`. Checked **between** steps only — a long-running `step.process()` won't see it mid-flight unless the node consults `ctx.signal` itself.
3. **Primitive-stack cursor bump** (`:216`–`:221`): only when `deep`; updates the top frame's `innerStepIndex` so a wait fired from inside knows its position.
4. **`!step.active` → skip** (`:223`–`:229`), records `skipNode(..., "inactive")`.
5. **`step.stop` → break** (`:230`).
6. **Content-type stamping** (`:242`–`:249`): assigns `step.contentType` onto `ctx.response` **only if it's a mutable object** — wrapped in try/catch because between steps `ctx.response` holds the *previous* step's raw `.data`, which can be a frozen object or a primitive (Bug-4 regression: a `runtime.python3` node returning a primitive). **This is a notable asymmetry: `ctx.response` between steps is the previous step's `.data`, not a `ResponseContext` envelope** — see §5.

### 2.3 Non-flow step path (`:251`–`:751`)
Inside `if (!step.flow)`:

- **Trace start** (`:252`–`:333`): builds `stepPrefix`, populates `ctx._stepInfo`, calls `tracker.startNode(...)` with rich metadata (`subworkflowWait`, `subworkflowDispatch`, `subworkflowDepth`, `middleware`, `iterationIndex`). `nodeRunId` and `ctx._traceNodeId` are set here.
- **`wait` step** (`:348`–`:535`): handled entirely *inside* RunnerSteps (the wait step has no `process()` body). Two passes:
  - **Re-entry / past-deadline** (`:404`–`:425`): mark NodeRun complete (`__waited__: true`), advance `lastCompletedStepIndex` at top-level only, `continue`.
  - **First pass** (`:427`–`:534`): serialize `ctx.state` snapshot via `serializeStateSnapshot` (`:70`–`:98`, capped at `BLOK_STATE_SNAPSHOT_MAX_BYTES` default 1MB), set resume cursor to `i-1` (top-level only), persist primitive-stack cursors when nested, then **`throw new WaitDispatchRequest`** (`:529`). This bubbles out to `TriggerBase` → 202 Accepted.
- **Idempotency cache lookup** (`:537`–`:568`): namespace `(workflowName, step.name, resolvedKey)`. On hit: `applyStepOutput(ctx, step, { data: hit.data })` (`:554`), set `ctx.response = hit.data`, `markNodeCached`, `continue` — **`step.process()` is never called.** Caching layers *above* persistence: the cache-hit data flows through the same ephemeral/spread/as rules.
- **Retry + timeout loop** (`:573`–`:751`):
  - `maxAttempts = retryConfig ? max(1, retryConfig.maxAttempts) : 1` (`:581`); default 1 = no retry.
  - `while(true)` with `attempt += 1` (`:602`–`:603`).
  - `step.process(ctx, step)` is wrapped in `wrapWithTimeout` (`:113`–`:129`) only when `maxDurationMs > 0` (`:608`–`:610`). **Timeout asymmetry:** on timeout, the underlying `fn()` keeps running — there's no AbortSignal cancellation of the in-flight node; the runner just moves on (comment at `:108`–`:112`).
  - `ctx.response = model.data` (`:611`) — **overwrites** the rolling response with the raw `.data`.
  - **Soft error promotion** (`:615`–`:617`): `if (ctx.response?.error) throw ctx.response.error` — a result envelope carrying `.error` is thrown so retry treats soft errors and thrown errors uniformly.
  - **Cache write on success only** (`:619`–`:636`): TTL default 24h (`DEFAULT_IDEMPOTENCY_TTL_MS`, `:17`); TTL 0 → immediately-expired entry (kill-switch).
  - **completeNode** (`:641`–`:660`): passes `_stepMetrics` stashed on ctx by RuntimeAdapterNode (`:649`–`:650`); advances `lastCompletedStepIndex` at top-level (`:657`–`:659`).
  - **catch block** (`:665`–`:741`):
    - `WaitDispatchRequest` / `RunCancelledError` are **re-thrown untouched** (`:676`–`:678`) — control-flow signals are never retried or wrapped.
    - More attempts remain → `recordNodeAttemptFailed`, `computeBackoff` (`:27`–`:36`, capped exponential, no jitter), `sleep`, `continue` (`:679`–`:694`).
    - Final attempt → `failNode`; if final error is `StepTimeoutError` and `maxDurationMs>0`, `markRunTimedOut` (`:711`–`:723`) — flips run to `"timedOut"`, **distinct** from `"failed"`. Then wraps the error: `new Error("${stepPrefix} failed: ${originalMsg}")` with `cause = nodeErr` and `_blokStepId = step.name` (`:732`–`:740`), and throws.

### 2.4 Flow step path (`:752`–`:760`)
The `else` arm (`step.flow === true`):
```
stepName = step.name;
flow_steps = (await step.processFlow(ctx)).data as NodeBase[];   // :754
flow = true; flow_step = i; break;                                // :756–759
```
After the loop (`:763`–`:766`): if `flow`, take remaining steps after `flow_step`, prepend the returned `flow_steps`, and **recursively** call `runSteps(ctx, [...flow_steps, ...nextSteps], deep=true, stepName)`. **This is how branch/if-else/switch work:** the flow node's `processFlow` returns the chosen arm's steps as a `NodeBase[]`, which are spliced in front of the remaining steps and re-run with `deep=true`. The flow node itself "takes over" the rest of the pipeline.

### 2.5 Outer catch — error unwrapping (`:767`–`:846`)
This is the most subtle part:
- `RunCancelledError` (`:774`) and `WaitDispatchRequest` (`:783`) pass through untouched so `TriggerBase.run`'s `instanceof` discrimination works.
- Captures `_blokStepId` from the enrichment wrap **before** unwrapping (`:792`–`:795`).
- If already a `GlobalError` → use directly (`:798`–`:799`).
- Else **walks the `.cause` chain** looking for a `GlobalError` (`:809`–`:823`) — this preserves `@blokjs/throw`'s `code: 401` etc. through the framework's wrap. If none found, constructs a fresh `GlobalError` with `cause = e` preserved (`:826`–`:834`).
- Re-stamps `_blokStepId` on the unwrapped error (`:841`–`:843`) so `TryCatchNode.toErrorEnvelope` can surface `$.error.stepId`.

## 3. `NodeBase.process` / `processFlow` — the per-step wrapper

`process(ctx, step)` (`NodeBase.ts:128`–`:145`):
1. `this.originalConfig = cloneDeep(config[this.name])` (`:136`).
2. `this.blueprintMapper(config[this.name], ctx)` (`:137`) — **resolves `$.`/`js/...` expressions in inputs BEFORE the node runs**, mutating the config wrapper in place.
3. `response = await this.run(ctx)` (`:139`).
4. `if (response.error) throw response.error` (`:141`) — **hard errors thrown here**, caught by RunnerSteps' retry catch.
5. `ctx.response = response` (`:142`) — note: this sets `ctx.response` to the full `ResponseContext`, but RunnerSteps immediately overwrites it with `model.data` at `RunnerSteps.ts:611`.

`processFlow(ctx)` (`:147`–`:166`): **asymmetric error handling** — flow nodes **swallow** errors into `response.error`/`response.success=false` rather than throwing (`:159`–`:163`). A throwing branch condition becomes a soft error on the flow node's envelope, not a thrown exception.

`blueprintMapper` (`:204`–`:223`): re-throws `MapperResolutionError` (strict mode) so it surfaces; logs any *other* mapper bug to stderr but does **not** swallow silently.

## 4. `applyStepOutput` — the centralized persistence decision (`PersistenceHelper.ts:57`–`:91`)

Rules **in evaluation order**:

| Order | Rule | Code |
|---|---|---|
| **0** | **Error guard → no-op.** `isErroredResult` returns true if `success===false` OR `error != null` OR `errors != null`. Skips state write entirely. | `:61`, `:108`–`:113` |
| **1** | `ephemeral === true` → no-op (only `ctx.prev` carries it). | `:64` |
| **2** | `spread === true` AND `isPlainObject(data)` → `Object.assign(state, data)`. Non-object data with spread is **silently ignored** at runtime (normalizer warns at load). | `:76`–`:84` |
| **3** | Default → `state[as ?? name] = data` (skips if `data === undefined`). | `:86`–`:90` |

**Why Rule 0 is the headline behavior (and is centralized):** without it, the framework's internal `BlokResponse.setError()` sets `data = {}`, and the helper would persist that empty object — making `ctx.state[<id>] !== undefined` a false positive on every attempted step. The guard makes **`ctx.state[<step-id>] === undefined` a truthful "did this step succeed?" check** inside `tryCatch.catch` arms. Centralizing it in `applyStepOutput` means all four call sites inherit identical behavior.

`isPlainObject` (`:93`–`:99`): rejects arrays and non-`Object.prototype`/null-proto objects — so `spread: true` over an array or a class instance silently does nothing.

### How each `run()` feeds the guard
- **`Blok.run`** (`Blok.ts:99`–`:159`): `defineNode.handle()` catches every throw and stuffs it onto `BlokResponse.error`. `errored = blokResponse.error != null` (`:111`). It passes the **full `IBlokResponse`** to `applyStepOutput` (`:147`) so the `error` field triggers Rule 0. Then mirrors `response.success = !errored` / `response.error` onto the outer envelope (`:158`–`:159`) — a fix noted as repairing a silently-broken `node_errors` OTel counter.
- **`RuntimeAdapterNode.run`** (`RuntimeAdapterNode.ts:70`–`:134`): merges SDK `vars_delta` into state via `Object.assign` **before** `applyStepOutput` (`:103`–`:105`) — this is a side-channel write that stacks with the auto-store. Then `applyStepOutput(ctx, this, result)` (`:111`) where `result` is the `ExecutionResult` carrying `errors` (plural) → Rule 0. Converts `result.errors` → `GlobalError` (`:114`–`:126`).
- **`SubworkflowNode`** (see §6): builds `result = { success: !childCtx.response?.error, data: childCtx.response }` (`:289`) and calls `applyStepOutput` so a failed child doesn't write parent state.

## 5. How `ctx.state` and `ctx.prev` are maintained

- **`ctx.state`** is the durable, cross-step store. Written **only** by `applyStepOutput` (or `ctx.publish`/`vars_delta`). `ctx.vars` is an **alias of the same object** (`createChildContext` line `vars: state`; TriggerBase `:1554`).
- **`ctx.prev`** is a **getter that returns `ctx.response`** (`createChildContext` `:1570`–`:1572`; TriggerBase `:1570`–`:1572`). It is *not* a stored field.
- **`ctx.response` is overwritten every step** at `RunnerSteps.ts:611` (`ctx.response = model.data`). So `ctx.prev` reflects only the **immediately previous** step's `.data`. This is why cross-step reads must use `ctx.state[<id>]`, not `ctx.prev`.
- **Asymmetry worth flagging:** `NodeBase.process` sets `ctx.response = response` (the full envelope, `:142`), but RunnerSteps then sets `ctx.response = model.data` (the unwrapped data, `:611`). The envelope is transient; the `.data` is what survives into the next step's `ctx.prev`. And the content-type stamp at `:242`–`:249` operates on this raw `.data`, which is why it must defend against primitives/frozen objects.

## 6. Sub-workflow execution (`SubworkflowNode.run`, `:153`–`:296`)

Step sequence:
1. **Recursion guard** (`:154`–`:161`): `depth = ctx._subworkflowDepth + 1`; throws past `BLOK_MAX_SUBWORKFLOW_DEPTH` (default 10, `:16`–`:23`).
2. **Resolve child name** (`:170`, via `resolveSubworkflowName` `:334`–`:382`): static names pass through; `js/`/`$.`/`${` expressions are mapper-resolved against live ctx (polymorphic G3); optional `namespace` prefix; `allowList` enforcement (`:375`–`:379`).
3. **Registry lookup** (`:171`–`:179`): `WorkflowRegistry.getInstance().get(resolvedName)`; throws with the known-workflow list if missing.
4. **Authorization hook** (`:189`–`:194`): default-allow unless `setAuthorizeFn` installed.
5. **http-self branch** (`:203`–`:205`): if `dispatch === "http-self"`, delegate to `dispatchHttpSelf` (§6.1).
6. **Materialize child** (`:211`–`:216`): fresh `Configuration` (preloaded `entry.workflow`, still normalized), lazy-import `Runner` (circular-dep avoidance).
7. **Build child ctx** (`:225`–`:234`): `createChildContext` — **fresh `state`, `response`, `error`, `id`; parent step's resolved `inputs` become child `request.body`** (function-call semantics). Depth counter carried forward (`:234`).
8. **Child trace run** (`:237`–`:255`): `tracker.startRun` with `triggerType: "subworkflow"`, `parentRunId`, `parentNodeRunId` for lineage.
9. **Dispatch** by `this.wait`:
   - **`wait: false`** → `dispatchAsync` (`:258`–`:259`, `:503`–`:553`): `setImmediate` schedules `childRunner.run`; child errors caught → `tracker.failRun` + `console.error`, **NOT propagated** to parent. Parent gets `{runId, workflowName, scheduledAt}` immediately, persisted via `applyStepOutput` (`:547`).
   - **`wait: true` (default)** → synchronous (`:262`–`:295`): `await childRunner.run(childCtx)`; on success `completeRun`, on throw `failRun` + re-throw (propagates to parent's retry loop). `finally` aborts `listenerCleanup` to prevent parent-signal listener accumulation (`:269`–`:278`). Result: `{ success: !childCtx.response?.error, data: childCtx.response }` → `applyStepOutput` (`:289`–`:290`); child's `ctx.response` lands on parent `state[<id>]`.

### 6.1 http-self dispatch (`dispatchHttpSelf`, `:409`–`:501`)
- Requires the child to have `trigger.http.path` (`:418`–`:422`), else throws.
- URL = `getSelfBaseUrl()` + path (`:36`–`:43`, `BLOK_SELF_BASE_URL` or `http://localhost:${PORT||4000}`).
- Lineage crosses via headers `X-Blok-Parent-Run-Id` / `X-Blok-Parent-Node-Run-Id` / `X-Blok-Subworkflow-Depth` (`:433`–`:441`).
- `wait: false` → fire-and-forget `fetch`, returns `{runId: null, ...}` (`:449`–`:471`) — **the child runId is unknown on the parent side** (the receiver creates the record). Asymmetry vs in-process `wait:false`, which *does* return a `runId`.
- `wait: true` → awaits fetch; non-2xx throws (`:491`–`:495`).
- All paths end with `applyStepOutput` (`:465`, `:499`).

### 6.2 Child isolation contract (`createChildContext`)
- Fresh `state`/`response`/`error`/`id`; **shared by reference**: `logger`, `env`, `eventLogger` (intentional).
- Child gets its **own `AbortController`** chained off the parent's signal: parent cancel cascades to child, but child cancel does not propagate up (`:childAbortController` block). The `listenerCleanup` AbortController auto-removes the parent-signal listener when the child completes (PR-1 A3 fix against `MaxListenersExceededWarning`).

## 7. Notable / asymmetric behaviors (for downstream designers)

1. **`ctx.response` means two different things** depending on where you read it: inside `NodeBase.process` it's briefly the full `ResponseContext` (`:142`), but between steps it's the previous step's raw `.data` (`RunnerSteps.ts:611`). Content-type stamping defends against this (`:242`–`:249`).
2. **`processFlow` swallows errors; `process` throws them.** Flow/branch condition errors become soft errors on the flow node's envelope (`NodeBase.ts:159`–`:163`), not exceptions.
3. **The error guard (Rule 0) only protects state, not `ctx.prev`.** A failed step is excluded from `ctx.state` but its envelope still flows to `ctx.prev` for the immediately next step.
4. **`spread` over a non-plain-object silently no-ops** at runtime (`PersistenceHelper.ts:81`–`:83`) — array, class instance, or primitive all write nothing; only the load-time normalizer warns.
5. **`vars_delta` (RuntimeAdapterNode `:103`) and `ctx.publish` write state outside `applyStepOutput`** — they bypass the ephemeral/spread/as/error rules entirely. A `runtime.*` node that returns errors but also emits `vars_delta` *will* mutate state despite Rule 0.
6. **Timeout doesn't cancel the node** (`wrapWithTimeout`, `:108`–`:112`) — the orphaned `step.process()` keeps running; only `wait:true` http-self and cooperative `ctx.signal` checks actually interrupt work.
7. **Cancellation is between-steps only** (`RunnerSteps.ts:205`) — mid-step cancellation requires the node to poll `ctx.signal`.
8. **Cache hit bypasses `step.process` entirely** including sub-workflow side effects — with `wait:true` a cached sub-workflow result means the child never runs (the documented footgun).
9. **Tracing-gated correctness:** resume cursors, wait persistence, idempotency caching, and retry-attempt events all silently no-op when `BLOK_TRACE_ENABLED=false` (tracker null). This couples the persistence/wait machinery to the trace store.
10. **`wait:false` runId asymmetry** between in-process (`childRunId`, `:542`) and http-self (`null`, `:458`).

## 8. Cross-reference to the two known-bug write-ups
Neither known bug lives in this subsystem, but both touch adjacent registration paths that this subsystem depends on:
- `TASK-ts-middleware-registration.md`: TS workflows registered without `isMiddleware`. **Relevant here** because `SubworkflowNode` resolves children via the same `WorkflowRegistry.getInstance().get(resolvedName)` (`SubworkflowNode.ts:171`–`:172`) — the registry that the buggy `HttpTrigger.buildFileBasedRoutes` feeds. Sub-workflow lookup works (route-table path registers them), but the `middleware` flag gap is in the *same* registry.
- `TASK-worker-trigger-fixes.md`: dotted names (`publish.site`) throw `File type not supported` in `LocalStorage.get()`. **Relevant here** because `SubworkflowNode` deliberately resolves by name through `WorkflowRegistry`, *not* `LocalStorage` (`:171`–`:172`) — so dotted child names work for sub-workflows, confirming the write-up's recommended fix (resolve worker workflows from the in-memory registry like sub-workflows already do).

### Key file:line anchors
- Step loop entry: `RunnerSteps.ts:142`; per-step guards `:192`/`:205`/`:223`/`:230`; wait `:348`–`:535`; idempotency hit `:551`–`:568`; retry/timeout loop `:601`–`:751`; flow recursion `:763`–`:766`; error unwrap `:767`–`:846`.
- Persistence rules: `PersistenceHelper.ts:57`–`:91`; error guard `:108`–`:113`.
- `process`/`processFlow`: `NodeBase.ts:128`–`:166`; persistence knobs `:31`–`:44`.
- `Blok.run` persistence: `Blok.ts:147`; error mirroring `:158`–`:159`.
- `RuntimeAdapterNode.run` persistence: `RuntimeAdapterNode.ts:103`–`:111`.
- Sub-workflow dispatch: `SubworkflowNode.ts:153`–`:296` (sync `:262`–`:295`, async `:503`–`:553`, http-self `:409`–`:501`).
- Child isolation: `core/runner/src/utils/createChildContext.ts` (fresh state, chained AbortController, `prev`/`req` getters).