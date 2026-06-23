# Blok Framework — Fixes & SPECs from the Paga.eu validation pass

> **Produced:** 2026-06-23, while validating the **Paga.eu** product (a Brazilian
> SMB fintech: Pix + WhatsApp billing, ads automation, AI pricing) against Blok.
> The validation surfaced framework-side defects independent of any product. The
> "no database / it's 75% CRUD" observations were product-architecture notes, **not**
> framework bugs (Blok is an orchestration framework, not a datastore) and are
> explicitly out of scope here.
>
> **Status:** Part A is **IMPLEMENTED** on branch `fix/blok-framework-issues`
> (code + tests + lint green). Part B is **SPEC-ONLY** (larger features awaiting
> approval). The three pre-existing bugs (01/02/03) were re-verified and are
> already fixed in current source — see the note at the end.

---

## Part A — Implemented in this pass

Each fix is contained, has tests, and passes `biome check`. Branch: `fix/blok-framework-issues`.

### A1 — Webhook `buildCustomVerifier` hardcoded `eventId: ""` → replay dedup never fired for custom providers

- **Files:** [`triggers/webhook/src/verifiers.ts`](../../triggers/webhook/src/verifiers.ts), [`triggers/webhook/src/WebhookTrigger.ts`](../../triggers/webhook/src/WebhookTrigger.ts)
- **Was:** every built-in verifier (github/stripe/svix/shopify) extracts a real
  event id, but `buildCustomVerifier` returned `eventId: ""` unconditionally.
  `WebhookTrigger` gates replay/idempotency dedup on
  `config.idempotencyKey && result.eventId` — so for ANY custom-HMAC provider
  (e.g. a Brazilian Pix PSP: Mercado Pago / Asaas / Efí, which redeliver routinely)
  the dedup was silently skipped → duplicate processing risk.
- **Fix:** `CustomSignatureConfig` gains optional `eventIdHeader` (wins) and
  `eventIdPath` (dot-path into the parsed body, e.g. `"id"`, `"data.id"`).
  `buildCustomVerifier` resolves the event id from header → body path → `""`.
  Plumbed through `WebhookTrigger`'s `signature` config block.
- **Tests:** 4 new cases in `verifiers.test.ts` (body-path, header-wins, no-config
  fallback, numeric coercion). 31/31 webhook tests green.
- **Author usage:**
  ```ts
  trigger: { webhook: { signature: {
    scheme: "hmac-sha256", header: "x-signature", secretEnv: "MP_WEBHOOK_SECRET",
    eventIdPath: "data.id",         // ← now dedups on the PSP's event id
  }, idempotencyKey: "$.req.body.id" } }
  ```

### A2 — `@blokjs/api-call` discarded `Retry-After` + body, threw `Error(statusText)` on ≥400

- **File:** [`nodes/web/api-call@1.0.0/util.ts`](../../nodes/web/api-call@1.0.0/util.ts)
- **Was:** `if (response.status >= 400 ...) throw new Error(response.statusText)`
  — dropped the response body and all headers (incl. `Retry-After`), and mapped
  every ≥400 to a generic 500 (no retryable-vs-permanent classification).
- **Fix:** throws a `GlobalError` carrying the **upstream** status via `setCode`
  (a 429/503 now surfaces as 429/503, not 500 — the framework preserves a thrown
  GlobalError's code verbatim) and `setJson({ status, statusText, url, retryAfter,
  retryAfterSeconds, body })`. `Retry-After` is parsed (seconds or HTTP-date).
- **Tests:** new `test/util.test.ts` (429 + Retry-After, 503 + HTTP-date, 404 no
  retry-after, 200 happy path). 14/14 api-call tests green. Existing
  network-rejection test (→ 500) unaffected — that path is untouched.

### A3 — Reference deploy Dockerfile aborted a clean `docker build`

- **File:** [`dockerfiles/Dockerfile.deploy.http`](../../dockerfiles/Dockerfile.deploy.http)
- **Was:** unconditional `COPY supervisord.conf /etc/...` — but `supervisord.conf`
  is generated per-project and isn't in the framework repo, so
  `docker compose -f infra/docker-compose.production.yml build` (context = repo
  root) failed at that step on a clean checkout.
- **Fix:** use the project's `supervisord.conf` when present (already brought in by
  `COPY . .`), else synthesize a minimal Node-only config at build time so the
  build never hard-fails.

### A4 — `docker-compose.production.yml` ran `replicas: 3` with per-replica state backends

- **File:** [`infra/docker-compose.production.yml`](../../infra/docker-compose.production.yml)
- **Was:** `replicas: 3` but the `blok` service set no `BLOK_CONCURRENCY_BACKEND`
  / `BLOK_DEBOUNCE_BACKEND`, so the concurrency gate and debounce windows defaulted
  to in-process — fragmenting per-tenant limits and running each debounce window
  N times across replicas.
- **Fix:** wire `BLOK_CONCURRENCY_BACKEND=redis` + `BLOK_DEBOUNCE_BACKEND=redis`
  (+ `*_REDIS_URL`) at the existing Redis service. Documented (commented) the
  trace-store dimension: webhook idempotency + the durable scheduler share the
  trace store, which needs a shared Postgres (`BLOK_TRACE_STORE=postgres` +
  `DATABASE_URL`) for cross-replica correctness — left commented since no Postgres
  service ships in this compose.

### A6 — `@blokjs/audit-log` misrepresented as durable (minimal honesty fix)

- **File:** [`nodes/utility/helpers@1.0.0/src/auditLog.ts`](../../nodes/utility/helpers@1.0.0/src/auditLog.ts)
- **Was:** an in-memory 1000-entry ring with a durable-sounding name; JSDoc
  referenced a `GET /__blok/audit` endpoint that **does not exist**.
- **Fix (minimal):** corrected the JSDoc (loud "NOT DURABLE" callout, removed the
  dead endpoint claim) + a one-time `console.warn` in production. The full
  pluggable-backend version is specced in **B3** below.
- **Tests:** existing helpers suite green (52/52).

### A10 — Wildcard CORS on all user routes, no override

- **File:** [`triggers/http/src/runner/HttpTrigger.ts`](../../triggers/http/src/runner/HttpTrigger.ts)
- **Was:** unconditional `this.app.use(cors())` → Hono default `origin: "*"` on
  every workflow route, with no way to restrict it.
- **Fix:** `BLOK_CORS_ORIGIN` env. **Unset = no CORS headers** (same-origin, safe
  default); set to `*` for an explicit public-API opt-in, or a single/comma-list
  of origins for a credentialed app.
- **⚠️ Breaking change:** deployments relying on the implicit `*` must now set
  `BLOK_CORS_ORIGIN=*`. Call out in release notes (deliberate hardening).

### A11 — `/__blok/rpc/:name` had no mount-level auth gate

- **File:** [`triggers/http/src/runner/HttpTrigger.ts`](../../triggers/http/src/runner/HttpTrigger.ts)
- **Was:** the RPC mount is registered before the `/__blok` trace router, so the
  trace-auth gate (FW-1) never covered it. Any http-triggered workflow without its
  own auth middleware was callable unauthenticated (and, combined with A10, cross-origin).
- **Fix:** a production-only deny-by-default gate on the RPC handler, reusing the
  operator's `setTraceAuth` hook (one auth surface for the whole `/__blok/` mount).
  In production without an authorize hook → 503 + hint; hook denies → 401; hook
  allows → runs. Kill-switch `BLOK_RPC_AUTH_DISABLED=1` (mirrors
  `BLOK_TRACE_AUTH_DISABLED`). Non-production behavior unchanged.
- **Tests:** 4 new cases in `HttpTrigger.rpc.test.ts` (503 / disabled-passthrough /
  401 / allow). 11/11 RPC tests green.
- **⚠️ Breaking change:** a production deployment that (a) sets
  `NODE_ENV=production`, (b) never calls `setTraceAuth`, and (c) uses the RPC mount
  must set `BLOK_RPC_AUTH_DISABLED=1` or register an authorize hook. (Such a
  deployment is already 503 for the trace API, so this is consistent.)

### A12 — `blokctl gen app-types` silently skipped JSON workflows

- **File:** [`packages/cli/src/commands/gen/appTypes.ts`](../../packages/cli/src/commands/gen/appTypes.ts)
- **Was:** the codegen only scans `.ts`; JSON-authored workflows were dropped from
  the typed client with **no warning**, and the JSDoc pointed at a
  `blokctl gen client` command that doesn't exist. (The "SSE/WS scaffold is v1"
  half of this issue was a **false alarm** — those scaffolds are already v2.)
- **Fix:** scan the resolved TS dir + `workflows/json` + `triggers/http/workflows/json`
  for JSON workflows and emit a visible `ℹ️` warning listing the names that were
  excluded (in both the empty and normal paths). Corrected the stale JSDoc.
- **Tests:** existing `appTypes.test.ts` green (16/16).

---

## Part B — SPEC-only (deferred, larger features)

### B1 — Per-step `rateLimit` DSL knob (true RPS limiting)

**Status:** `enhancement-missing-feature`. The `RateLimiter` token-bucket class
(`core/runner/src/monitoring/RateLimiter.ts`) is fully functional and referenced
in `TriggerBase` (for metrics) but is **not wired to step execution** — there is no
per-step `rateLimit` field, only the in-flight `concurrencyKey` semaphore.

**Spec (additive):**
1. **Schema** (`core/workflow-helper/src/types/StepOpts.ts`): add
   `rateLimit: { requests: int≥1, perMs: int≥1, key?: string }` to
   `V2RegularStepSchema` + `V2SubworkflowStepSchema` (before `.strict()`); reject on
   `V2WaitStepSchema`; do NOT add to branch/forEach/loop/switch/tryCatch containers.
2. **`NodeBase`** (`core/shared/src/NodeBase.ts`): add `rateLimit?` next to `retry`/`maxDurationMs`.
3. **`Configuration.ts`**: copy `rateLimit` onto the node in the v2 / sub-workflow /
   flow hydration paths (mirror how `retry` is copied).
4. **`RunnerSteps.ts`**: a process-global per-step `Map<string, RateLimiter>` keyed
   by `${workflow}::${step}::${requests}::${perMs}`. Insert the gate AFTER the
   idempotency-cache check and BEFORE the retry loop. On exhaustion throw a new
   `StepRateLimitedError({ stepId, retryAfterMs })`; if the step has `retry`, the
   loop backs off `retryAfterMs`; else the step fails. `key` defaults to `step.id`
   (process-global bucket); a `$`-expression scopes per-tenant.
5. **Cross-process** (follow-up): `BLOK_STEP_RATE_LIMIT_BACKEND=nats-kv|redis`,
   mirroring the concurrency backends. Ship in-memory first; **document the
   per-process footgun** (effective limit = requests × processes until the backend
   ships). Kill-switch `BLOK_STEP_RATE_LIMIT_DISABLED=1`.
6. Export `StepRateLimitedError` from `core/runner/src/index.ts`.

**Why deferred:** moderate, touches 5 files + a new error type + schema; needs the
cross-process backend story to be genuinely useful for the Paga.eu provider-call use case.

### B2 — SSE cross-process backplane (multi-replica fan-out)

**Status:** `confirmed-broken` (documented in `SSE-STREAMING-RUNTIME-GAPS.md`). The
SSE bus (`triggers/sse/src/bus.ts`) is an in-process singleton; under 2+ replicas a
publish only reaches clients on the same replica.

**Spec (large feature):** introduce an `SseBusBackend` interface
(`connect/disconnect/publish/subscribe/clear`); the existing `Bus` becomes
`InProcessSseBusBackend` (default). Add `RedisSseBusBackend` (Redis **Streams** —
`XADD`/`XREAD` give ordered `Last-Event-Id` replay that pub/sub can't) and
`NatsSseBusBackend` (JetStream `byStartSequence`). Factory `createSseBusBackend()`
keys on `BLOK_SSE_BACKEND` (`memory` default | `redis` | `nats`); `SSETrigger.listen()`
wires it. `@blokjs/sse-publish`'s `bus.publish(...)` becomes `await`-ed (the only
caller-visible change). FW-5 production refusal on default key prefix. Sticky
sessions remain an operator concern (the backplane solves producer→consumer
fan-out, not multi-replica fan-in to one client). Full file list + env vars in the
triage record. Default (unset) preserves today's single-process behavior exactly.

**Why deferred:** large — new backend implementations + integration tests requiring
real Redis/NATS; one minor async API change.

### B3 — `@blokjs/audit-log` pluggable durable backend (full version)

**Status:** the minimal honesty fix shipped (A6). The full version makes the sink
pluggable: an `AuditLogSink` interface + `InMemoryAuditSink` default +
`setAuditLogSink()` + a `RedisAuditSink` (lazy `ioredis`, `LPUSH`+`LTRIM` to a
`BLOK_AUDIT_REDIS_KEY` list, mirroring `redisKv.ts`). Exported from the helpers
`index.ts`; docs updated with the pluggable-backend section. Files:
`auditLog.ts`, `index.ts`, `docs/d/reference/helpers/audit-log.mdx`.

**Why deferred:** the durable backend is the right long-term shape but is a new
public API; the minimal fix already removes the misleading claims and warns in prod.

---

## Note — the three pre-existing bugs (01/02/03) are already fixed

A status re-verification against current source confirms all three known bugs
specced in `01`/`02`/`03` are **already resolved** (they were unimplemented when
those specs were written):

- **Bug 01** (TS middleware `isMiddleware`): fixed — `workflowV2.ts` threads
  `middleware: true` through `toJson()`; `WorkflowRouter.readMiddlewareFlag` +
  `HttpTrigger.registerManualMiddleware` register trigger-less TS middleware.
- **Bug 02** (worker Kafka scaffold): fixed — `updateQueueProvider` no-ops without
  an explicit `--queue-provider`; default scaffold leaves `this.adapter` undefined
  → in-memory; `.env.local` gets `BLOK_WORKER_ADAPTER=in-memory`.
- **Bug 03** (dotted worker names): fixed — `WorkerTrigger.handleJob` passes the
  preloaded in-memory workflow to `configuration.init`, bypassing `LocalStorage`;
  `LocalStorage.get` now gates the dot-strip on a known file type.
