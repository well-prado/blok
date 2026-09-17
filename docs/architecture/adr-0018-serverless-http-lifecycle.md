# ADR 0018 — Serverless HTTP lifecycle and capability contract

- Status: Accepted as the design contract for issues #1075–#1083
- Date: 2026-09-17
- Governing issue: [#1075](https://github.com/well-prado/blok/issues/1075)
- Scope: HTTP and Inertia deployments on request-driven platforms, including
  Vercel Functions

## Context

`HttpTrigger.listen()` currently owns two different responsibilities:

1. preparing an application (loading workflows and nodes, registering routes
   and middleware, and installing request handlers); and
2. starting a long-lived Node.js server and process services.

The first responsibility is needed by every HTTP request. The second is not
available in a serverless function, where the platform owns the listener and
may reuse one module instance for many requests. A serverless adapter must not
bind a port, assume that a process will remain alive after a response, or use
process-local state as durable application state.

This ADR defines the boundary that the HTTP trigger refactor and the Node.js /
Bun function adapter must implement. It does not make a promise about a
provider's maximum duration, memory, streaming, or deployment filesystem;
those remain provider constraints checked by the adapter and deployment
conformance gate.

## Decision

### 1. Two-phase public lifecycle

The HTTP trigger exposes one preparation phase and one request phase:

```ts
export interface PreparedHttpTrigger {
  /** The prepared Hono application, useful to adapters and integrations. */
  readonly app: Hono<AppBindings>;
  /** Dispatches one web-standard request; it never binds a socket. */
  readonly fetch: (request: Request, env?: AppBindings["Bindings"]) => Response | Promise<Response>;
  /** Capability report used by deployment diagnostics and conformance tests. */
  readonly capabilities: Readonly<Record<string, "supported" | "conditional" | "unsupported">>;
}

export default class HttpTrigger extends TriggerBase {
  prepare(): Promise<PreparedHttpTrigger>;
  fetch(request: Request, env?: AppBindings["Bindings"]): Promise<Response>;
  listen(): Promise<number>;
}
```

The exact TypeScript declaration may be expressed with a named result type or
an equivalent structural type, but the semantics are normative:

- `prepare()` performs all application preparation and returns a stable
  prepared application. It does not bind `PORT`, create an `http.Server`,
  install a timer, install a process signal handler, or start a listener.
- `fetch(request, env?)` awaits preparation and dispatches exactly one request
  through the prepared application. It accepts a standard web `Request` so a
  Vercel, Node.js, Bun, or compatible adapter can pass the provider request
  without a provider-specific wrapper in workflow code.
- `listen()` remains the long-running process entry point. It uses the same
  preparation implementation and the same `app.fetch` request dispatch, then
  adds only the listener and process-lifetime services documented in §4.
- A function adapter owns provider response conversion, invocation context,
  abort/deadline propagation, and platform logging. Blok owns route matching,
  workflow execution, response headers, Inertia semantics, and cleanup of the
  request scope.

`fetch()` is the serverless entry point. Applications must not call
`listen()` from a function handler, and an adapter must not call `serve()` or
`http.createServer()` on the request path.

### 2. Preparation is single-flight and idempotent

Preparation has one memoized in-flight promise per trigger instance:

```text
new HttpTrigger()
      │
      ├─ first prepare() ──┐
      ├─ concurrent fetch ─┼─ await the same preparation promise
      └─ concurrent prepare()┘
                               │
                         prepared app
```

The following guarantees are required:

| Situation | Required behavior |
|---|---|
| Cold start | The first `prepare()` performs the complete preparation before the first request is dispatched. |
| Concurrent first requests | All callers await one single-flight preparation. Route registration and global setup happen once; no caller sees a partially prepared app. |
| Warm reuse | Later `prepare()` and `fetch()` calls reuse the same prepared app and do not rescan, remount, or duplicate middleware. |
| Successful retry | A successful preparation remains valid for the lifetime of the trigger instance. HMR is a development-only exception and explicitly rebuilds its route overlay. |
| Failed preparation | All waiters receive the failure and no request is served from the partial app. The rejected single-flight entry is cleared so a later cold invocation may retry. The failure must be logged with its phase; it must never be silently converted into a 200 or a route miss. |
| Request failure | A workflow or request failure is isolated to that request. It must not invalidate the prepared app or poison later invocations. |
| Cancellation | A request abort/deadline cancels only that request's execution. Preparation is not cancelled by an individual request after it has started. |

Preparation may be retried after failure because serverless instances can see a
transient filesystem import, environment, or database failure. Implementations
must still avoid an unbounded retry loop; the platform or adapter controls
invocation retry/backoff.

### 3. Preparation ordering and side effects

The current `listen()` preparation sequence is the source order below. The
refactor may split it into helpers, but it must preserve the ordering and the
"before first request" boundary:

| Order | Preparation operation | Serverless rule |
|---:|---|---|
| 1 | `BLOK_ROUTES_ONLY=1` offline route-table short circuit | Remains a CLI-only mode; a function adapter must reject it or never select it. |
| 2 | Bootstrap metrics, unless disabled | Use a process-global provider at most once; do not start a Prometheus listener in a function. |
| 3 | Bootstrap OTLP tracing, when configured | Install the SDK once; request spans must be ended before the response and flushed within the provider budget. |
| 4 | Resolve the manual `Workflows.ts` map | Await lazy imports with the existing bounded boot timeout. |
| 5 | Scan JSON and TypeScript workflow roots and build the route table | Complete before serving; route collisions are reported by the existing diagnostics contract. |
| 6 | Populate `WorkflowRegistry`, live routes, and middleware registrations | Register each workflow and middleware once per prepared trigger. |
| 7 | Register process-global middleware from the registry or `BLOK_GLOBAL_MIDDLEWARE` | Registry configuration wins over the environment fallback. |
| 8 | Validate workflow references and build the node catalog | Advisory or strict behavior follows `BLOK_VALIDATE_REFS`; strict errors fail preparation. |
| 9 | Run pre-catch-all hooks | Hooks may mount routes but cannot bind a socket; bounded failures are reported before serving. |
| 10 | Resolve `BLOK_STATIC_DIR`, asset version, and static mount | Static assets and SPA fallback are prepared before the first request. |
| 11 | Install Hono middleware and routes | Install Inertia safety/devtools, public/static assets, CORS, request cleanup, health, metrics (when available), RPC, nodes, trace/Studio, application routes, explicit routes, and the legacy catch-all in that order. |
| 12 | Publish the prepared `app.fetch` | This is the serverless readiness boundary. No request is dispatched before it. |

Preparation must not perform request-specific work, run a workflow, or open a
listener. Database pools and other external clients may be created lazily or
once during preparation, but their lifecycle must be safe for warm reuse and
must not be treated as proof of durable state.

### 4. Long-running `listen()` shares preparation

The long-running path is defined as:

```text
listen()
  └─ await prepare()
      └─ bind PORT with the Node.js server adapter
          └─ install long-lived hooks/services
              └─ serve prepared app.fetch
```

Only the final two stages are listener-only effects. They include:

- binding the configured `PORT` and exposing the underlying `http.Server` to
  registered same-port trigger hooks;
- enabling HMR when requested;
- installing crash auto-flip and graceful shutdown handlers;
- starting the storage janitor; and
- starting/recovering the in-process scheduler and pending dispatches.

Each listener-only service remains idempotent and is skipped by `fetch()`.
`stop()` remains valid for the listener path and must not be required by a
serverless adapter. A listener bind failure rejects `listen()` with the
existing actionable port error; it does not alter the prepared app's contract.

### 5. Capability classification

The adapter and `blokctl inertia doctor` expose these classifications. A
conditional feature must report its unmet provider prerequisite rather than
silently falling back to an incorrect behavior.

| Capability | Classification | Contract and serverless prerequisite |
|---|---|---|
| Unary HTTP workflows and JSON responses | Supported | Provider invokes the function with a web request and permits the workflow to finish within its deadline. |
| Inertia v3 visits, redirects, partial reloads, deferred/optional/once props, Precognition, CSRF, uploads, and same-origin SPA assets | Supported | Build assets into the deployment and set `BLOK_STATIC_DIR` (or use the adapter's static mapping). Session/flash and upload limits still apply. |
| Inertia standalone cross-origin mode | Conditional | Requires an explicit, non-wildcard `BLOK_CORS_ORIGIN` allow-list for credentialed cookies and provider support for the configured headers. Same-origin remains the safe default. |
| Node.js/Bun function adapter | Conditional | Supported when the provider supports the selected engine, ESM output, web `Request`/`Response`, environment variables, and the deployment's package size/duration limits. The adapter never starts a listener. |
| SSE / response streaming | Conditional | Requires provider streaming support, a bounded function duration, and an adapter that forwards the web stream. Reconnects and events must not depend on process memory; otherwise fail deployment conformance rather than buffering indefinitely. |
| WebSockets | Unsupported in the HTTP Function | A function invocation is request/response scoped. Use a managed WebSocket service or the long-running WebSocket trigger and route its events to durable Blok endpoints. |
| Cron and scheduled invocation | Conditional | A provider scheduler must invoke an authenticated HTTP endpoint. The function must be idempotent; schedule ownership and retries belong to the provider or a durable scheduler. In-process cron timers are not started. |
| Workers, queues, and background consumers | Unsupported in the HTTP Function | Run `WorkerTrigger` or a managed queue consumer separately. A request may enqueue durable work, but must not rely on a detached promise after returning. |
| Deferred-run scheduler and delayed dispatch | Conditional | Requires the durable store and an external scheduler/claimer invocation. The in-process timer and boot recovery loop are disabled in function mode. |
| Studio and trace API | Conditional | Requires a durable trace store, explicit production authorization (`setTraceAuth`), and a deployment policy that exposes `/__blok/*`. Live process controls and debug sessions are unavailable. |
| Prometheus `/metrics` listener | Unsupported in the HTTP Function | No separate scrape listener is started. Use provider metrics or an OTLP/telemetry exporter. Per-request metrics may remain enabled. |
| OpenTelemetry tracing | Conditional | Requires a configured OTLP exporter and a bounded flush/flush-on-shutdown strategy compatible with the provider. Without an exporter, tracing is local/no-op as today. |
| MCP HTTP tools | Conditional | Works only as ordinary request/response HTTP when the provider supports the required body and duration limits; MCP streaming transports inherit the SSE condition. |
| HMR, crash handlers, janitor, graceful shutdown | Unsupported in the HTTP Function | These are process-lifetime services and are only started by `listen()` in development or a long-running deployment. |

### 6. Durable state and default-safe configuration

Serverless instances are disposable and may run concurrently. The following
state must be in a shared durable service before a deployment claims production
support: sessions, flash/CSRF material that must survive instances, trace/run
records, idempotency keys, concurrency locks, scheduled dispatches, and any
application data. An in-memory store is valid for local development and tests,
not for a multi-instance deployment.

Required and recommended configuration is:

| Variable | Default-safe behavior | Serverless guidance |
|---|---|---|
| `NODE_ENV` / `BLOK_ENV` | Do not assume development | Set `production`; this activates production auth/error behavior. |
| `BLOK_FLASH_SECRET` | No signed flash cookie | Required when flash or CSRF bounce-back is used; generate and store as a secret. |
| `BLOK_SESSION_SECRET` | No signed session cookie | Required by the auth starter kit; never use a per-invocation value. |
| `BLOK_SESSION_STORE` | Project default (SQLite outside test) | Select a shared durable backend; do not use `memory` in production. |
| `BLOK_TRACE_STORE` and `BLOK_TRACE_PG_*` | Existing configured store | Select Postgres/Neon (issue #1079) for shared run, cache, lock, and schedule state. Never commit connection credentials. |
| `BLOK_STATIC_DIR` | No static mount | Set to the built SPA directory for same-origin assets, or configure the platform's static mapping. |
| `ASSET_VERSION` | Read from `.blok-asset-version` when present | Pin it per deployment so Inertia's 409 asset-version reload is deterministic. |
| `BLOK_CORS_ORIGIN` | Unset: no CORS headers | Set an exact origin or allow-list only for standalone SPAs; `*` is not valid for credentialed sessions. |
| `BLOK_TRACE_AUTH_DISABLED` / `BLOK_RPC_AUTH_DISABLED` | Production gates stay on | Leave unset. Opting out requires an external firewall and an explicit deployment review. |
| `BLOK_TRACE_ENABLED` | Existing default | Keep enabled only with a durable store/exporter sized for the workload; set `false` deliberately because it also disables store-backed features. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | No remote exporter | Configure only a reachable, authenticated exporter and keep flush within the function deadline. |
| `BLOK_HMR` | Follows development mode | Leave unset/false in functions. |
| `PORT` | Long-running default only | Ignored by `fetch()`; the platform owns the socket. |
| `BLOK_JANITOR_DISABLED`, `BLOK_GRACEFUL_SHUTDOWN_DISABLED`, `BLOK_CRASH_AUTOFLIP_DISABLED` | Existing long-running defaults | The function adapter skips these process-lifetime services regardless of flags; a separate durable maintenance job performs cleanup/recovery. |

Secrets are opaque references at deployment time. They must not appear in
workflow values, manifests, logs, traces, generated diagnostics, or this ADR.

### 7. Conformance test matrix

The implementation work must turn this design matrix into executable tests. A
provider-independent adapter fixture is sufficient; it must use a fresh
trigger instance for cold cases and a shared instance for warm/concurrent
cases.

| Test ID | Setup | Required assertion |
|---|---|---|
| `serverless-cold-01` | New trigger; call `fetch()` once | Preparation completes before dispatch and the request reaches a registered route. |
| `serverless-single-flight-02` | New trigger; issue concurrent `prepare()`/`fetch()` calls | One preparation promise, one route registration, all requests succeed. |
| `serverless-warm-03` | Reuse a prepared trigger for multiple requests | No duplicate middleware/routes/scans; all responses remain equivalent. |
| `serverless-failure-04` | Force a preparation import/validation failure, then repair it | All initial waiters reject; no partial response; a later call retries and succeeds. |
| `serverless-request-isolation-05` | One workflow request fails, then invoke a healthy route | The second request succeeds and preparation is still reusable. |
| `serverless-listen-regression-06` | Use a free test port and call `listen()` | The listener path remains available and serves the same route through the prepared app. |
| `serverless-no-listener-07` | Call `prepare()`/`fetch()` with no free port assumption | No socket is bound and no process-lifetime timer/signal service is installed. |
| `serverless-capabilities-08` | Inspect the adapter capability report | Every row in §5 is represented with supported/conditional/unsupported and a prerequisite/reason. |
| `serverless-inertia-09` | Real web request against a built same-origin SPA | Inertia headers, asset versioning, redirects, partial/deferred props, CSRF, and upload behavior remain intact. |
| `serverless-durable-10` | Use a shared Postgres/Neon test store with two trigger instances | Idempotency, locks, session/flash, and trace/run records are visible across instances. |

The boot-order assertions belong beside the `HttpTrigger` refactor tests. The
existing listener regression suite remains authoritative for `listen()` and
must stay green. Tests must use dynamically allocated or documented test
ports; they must never bind or kill ports reserved by a developer demo.

## Consequences

- The same route graph and request semantics serve both a long-running Blok
  process and a serverless function. Differences are explicit listener and
  process-lifetime capabilities, not two independent HTTP implementations.
- A cold function may pay the preparation cost once, while warm invocations
  avoid it. Single-flight preparation prevents concurrent cold requests from
  registering conflicting route graphs.
- Durable storage and provider scheduling become deployment requirements for
  features that previously benefited from process-local recovery and timers.
- Some existing defaults are intentionally development-friendly (SQLite,
  in-memory stores, HMR, process janitor). `blokctl` and deployment docs must
  surface them as incompatible or conditional for serverless production.
- The adapter can be implemented for Vercel first without making Vercel APIs a
  dependency of `@blokjs/trigger-http` or workflow authoring code.

## Non-goals and follow-up slices

- This ADR does not implement `prepare()`, `fetch()`, a Vercel adapter, Neon
  storage, or deployment scaffolding. Those are issues #1076–#1083.
- This ADR does not promise that WebSockets, in-process workers, or cron can be
  emulated by an HTTP function. Their classification is an intentional product
  boundary.
- Provider-specific limits and deployment files must be documented and tested
  by the adapter and conformance issues without weakening this lifecycle
  contract.
