# How to use everything we built — v0.5 → v0.7 + C4/C1

## 1. The big picture: what ships today

You have **four production-ready trigger families** plus a **rich reliability layer**, all consuming the same v2 workflow shape.

| Trigger | Where to put the workflow | What it does | Production-ready? |
|---|---|---|---|
| **`trigger.http`** | [triggers/http/workflows/json/](triggers/http/workflows/json/) or [triggers/http/src/workflows/](triggers/http/src/workflows/) | Classic REST request handler | ✅ Since v0.4 |
| **`trigger.websocket`** | Same folder | WS upgrade on same port, per-message workflow runs, room broadcast | ✅ v0.7 PR #83 |
| **`trigger.sse`** | Same folder | One workflow run per stream open, in-process bus + Last-Event-Id replay | ✅ v0.7 PR #84 |
| **`trigger.webhook`** | Same folder | HMAC verification + replay protection + polymorphic dispatch | ✅ v0.7 PR #85 |
| **`trigger.worker`** | [triggers/worker/template/src/workflows/](triggers/worker/template/src/workflows/) | Background jobs across 8 broker adapters | ✅ v0.7 PR #86 |
| **`trigger.pubsub`** | [triggers/pubsub/template/src/workflows/](triggers/pubsub/template/src/workflows/) | Pub/Sub across 6 adapters with fan-out / competing-consumer | ✅ v0.7 PR #87 |
| **`trigger.cron`** | (own project; see `triggers/cron/`) | Schedule expressions, timezone, overlap-guard | ✅ Earlier |

The first four (**HTTP + WS + SSE + Webhook**) **multiplex on the same Hono port** (4000 by default). The same dev server serves all of them. See [triggers/http/src/index.ts:25-44](triggers/http/src/index.ts#L25-L44) — that's the orchestrator that wires them together.

Worker, Pub/Sub, and Cron run as their own processes, not on the HTTP port.

---

## 2. Where the example workflows live + are they real?

**Verdict: real, not mocked.** Almost every workflow targets a real external API. The few helper-injection workflows are realistic; nothing is stubbed.

### HTTP / WS / SSE / Webhook (same folder, scanned recursively)

[triggers/http/workflows/json/](triggers/http/workflows/json/) holds **47 JSON workflows** — including 14 from v0.5 reliability work and 4 from v0.7:

**v0.7 trigger demos** (open these to see the new triggers in action):

| File | Trigger | What it does |
|---|---|---|
| [v07-ws-echo.json](triggers/http/workflows/json/v07-ws-echo.json) | `websocket` | Echo server on `/ws/echo`. Connect → "connected" greeting; send → JSON-wrapped echo. Real WS round-trip via `@blokjs/ws-reply`. |
| [v07-sse-stream.json](triggers/http/workflows/json/v07-sse-stream.json) | `sse` | SSE endpoint at `/sse/demo` subscribing to in-process bus channel `sse-demo`. Streams forever. |
| [v07-sse-publish.json](triggers/http/workflows/json/v07-sse-publish.json) | `http` (POST) | Companion — POSTs publish to the bus, every SSE client receives. |
| [v07-stripe-webhook.json](triggers/http/workflows/json/v07-stripe-webhook.json) | `webhook` (Stripe) | Real Stripe webhook verifier + **polymorphic dispatch**: `subworkflow: "js/ctx.request.body.type"` + `namespace: "stripe"` → `body.type === "invoice.paid"` lands on the `stripe.invoice.paid` workflow. |
| [v07-github-webhook.json](triggers/http/workflows/json/v07-github-webhook.json) | `webhook` (GitHub) | Real HMAC-SHA256 verifier on `X-Hub-Signature-256`. Switches on `X-GitHub-Event` and dispatches to per-event sub-workflows ([v05-github-handler-push.json](triggers/http/workflows/json/v05-github-handler-push.json) etc.). |
| [stripe.invoice.paid.json](triggers/http/workflows/json/stripe.invoice.paid.json) | (sub-workflow only) | Real handler — receives the verified Stripe event from `v07-stripe-webhook`. |

**v0.5 reliability demos** (these exercise every primitive — branch, switch, forEach, loop, tryCatch, wait, sub-workflows, idempotency, retry, debounce, concurrency keys, etc.). All hit real targets like `httpbin.org`, `countriesnow.space`, `swapi.dev`, MongoDB Atlas:

- [v05-saga.json](triggers/http/workflows/json/v05-saga.json) — `tryCatch` saga with rollback, you control the failure URL via request body.
- [v05-parallel-foreach-with-wait.json](triggers/http/workflows/json/v05-parallel-foreach-with-wait.json) — parallel `forEach` with `mode: parallel`, `concurrency: 5`, plus a `wait: { for: "100ms" }` inside the body. Exercises the Phase 4 wait-inside-primitives runtime.
- [v05-async-job-poller.json](triggers/http/workflows/json/v05-async-job-poller.json) — `loop` with `until` condition + capped backoff.
- [v05-csv-import.json](triggers/http/workflows/json/v05-csv-import.json) — `forEach` over rows with per-row retry.
- [v05-multi-tenant-router.json](triggers/http/workflows/json/v05-multi-tenant-router.json) — `switch` on tenant header + sub-workflow dispatch.
- [v05-user-signup-saga.json](triggers/http/workflows/json/v05-user-signup-saga.json) — `tryCatch` with compensation steps.
- [v05-travel-booking.json](triggers/http/workflows/json/v05-travel-booking.json) — multi-step saga with rollback.
- [v05-protected.json](triggers/http/workflows/json/v05-protected.json) + [v05-jwt-protected.json](triggers/http/workflows/json/v05-jwt-protected.json) — JWT auth via workflow-level middleware.
- [v05-tenant-{acme,beta,gamma}.json](triggers/http/workflows/json/v05-tenant-acme.json) — concurrency-key per-tenant rate limiting.

**Real external APIs used** across these:
- `https://httpbin.org/...` — request inspection + status-code injection
- `https://countriesnow.space/api/v0.1/countries`
- `https://swapi.dev/api/films`
- `https://api.spacexdata.com/v3/launches`
- `https://catfact.ninja/fact`
- MongoDB Atlas (real cluster) for `mongodb.json`

### Worker + Pub/Sub templates

These are **scaffold templates** for `blokctl create project` — not pre-mounted. They post to `https://httpbin.org/post` as a real placeholder so the user sees a working baseline:
- [triggers/worker/template/src/workflows/jobs/process-job.ts](triggers/worker/template/src/workflows/jobs/process-job.ts)
- [triggers/pubsub/template/src/workflows/messages/on-message.ts](triggers/pubsub/template/src/workflows/messages/on-message.ts)

### TypeScript-DSL workflows (also under HTTP)

[triggers/http/src/workflows/](triggers/http/src/workflows/) holds three working TS workflows:
- [countries-helper.ts](triggers/http/src/workflows/countries-helper.ts) — fetches the countries list
- [countries-cats-helper.ts](triggers/http/src/workflows/countries-cats-helper.ts) — parallel calls
- [empty.ts](triggers/http/src/workflows/empty.ts) — bare-bones starter (this is the scaffold)

The `Workflows.ts` index ([triggers/http/src/Workflows.ts](triggers/http/src/Workflows.ts)) registers them. JSON workflows under `triggers/http/workflows/` are auto-scanned at boot.

---

## 3. The v2 workflow structure (what you write)

You write either **TS** ([@blokjs/helper](core/helper) `workflow()` builder) or **JSON** (mirror shape). The runner normalizes v1 → v2 at load time so legacy works.

### Anatomy

```jsonc
{
  "name": "my-workflow",                          // required, 3+ chars
  "version": "1.0.0",                             // semver
  "description": "What this does",
  "trigger": {                                    // EXACTLY ONE of:
    "http":      { "method": "POST", "path": "/api/x" },
    "websocket": { "path": "/ws/chat", "events": ["message"] },
    "sse":       { "path": "/sse/feed", "heartbeatInterval": 15000 },
    "webhook":   { "provider": "stripe", "path": "/webhooks/stripe", "secretEnv": "STRIPE_WEBHOOK_SECRET" },
    "worker":    { "queue": "background-jobs", "concurrency": 5, "provider": "redis-streams" },
    "pubsub":    { "provider": "gcp", "topic": "events", "subscription": "events-sub" },
    "cron":      { "schedule": "0 * * * *", "timezone": "UTC" }
  },
  "middleware": ["request-id", "audit-log"],      // optional, per-workflow
  "steps": [
    // each step is one of these shapes:
    { "id": "fetch",    "use": "@blokjs/api-call", "inputs": { "url": "..." } },
    { "id": "branch",   "branch": { "when": "$.req.method === 'POST'", "then": [...], "else": [...] } },
    { "id": "route",    "switch": { "on": "...", "cases": [...], "default": [...] } },
    { "id": "fan-out",  "forEach": { "in": "$.req.body.items", "as": "item", "mode": "parallel", "concurrency": 5, "do": [...] } },
    { "id": "poll",     "loop":   { "until": "...", "max": 10, "do": [...] } },
    { "id": "saga",     "tryCatch": { "try": [...], "catch": [...], "finally": [...] } },
    { "id": "throttle", "wait": { "for": "100ms" } },                         // or { "until": "<isoDate>" }
    { "id": "child",    "subworkflow": "send-email", "inputs": {...}, "wait": false },
    // every step accepts these knobs:
    {
      "id": "side-effect",
      "use": "...",
      "ephemeral": true,                          // skip state[id]
      "as": "alias",                              // rename to state[alias]
      "spread": true,                             // shallow-merge data into state
      "idempotencyKey": "$.req.body.requestId",   // cache result
      "idempotencyKeyTTL": 86400000,
      "retry": { "maxAttempts": 3, "minTimeoutInMs": 500, "factor": 2 },
      "maxDuration": "30s",                       // step-level timeout
      "tags": ["billing"],                        // for trace filtering
      "metadata": { "criticality": "high" }
    }
  ]
}
```

### Persistence rules (memorize)

| Default | `ephemeral: true` | `spread: true` | `as: "x"` |
|---|---|---|---|
| `ctx.state[<id>] = result.data` | not stored | `Object.assign(ctx.state, result.data)` | `ctx.state["x"] = result.data` |

Read anywhere via `$.state.<id>` (DSL proxy) or the equivalent `"js/ctx.state.<id>"` (JSON string). Adjacent steps can also read `ctx.prev`.

### Trigger-level reliability knobs (concurrency + scheduling)

```jsonc
"trigger": {
  "http": {
    "method": "POST",
    "path": "/render",
    "concurrencyKey": "$.req.body.userId",   // per-key in-flight cap
    "concurrencyLimit": 5,
    "onLimit": "queue",                       // or "throw" (default → 429)
    "delay": "1h",                            // schedule for later
    "ttl": "30m",                             // expire if not started
    "debounce": { "key": "$.req.params.docId", "mode": "trailing", "delay": "500ms", "maxDelay": "5s" }
  }
}
```

---

## 4. Starting the dev server + running everything

### One-shot setup

```bash
bun install
bun run http:dev
```

This builds `@blokjs/runner` then starts `triggers/http`'s server at **http://localhost:4000**. It exposes:
- All HTTP workflows under their declared paths
- WS upgrade on `/ws/echo` (from `v07-ws-echo.json`)
- SSE stream on `/sse/demo` (from `v07-sse-stream.json`)
- Webhook receivers on `/webhooks/stripe` and `/webhooks/github`
- Blok Studio (the UI + API): **http://localhost:4000/__blok**

### Curl recipes for each trigger

**HTTP (sanity check)**
```bash
curl -s http://localhost:4000/countries | jq '.data | length'
```

**WebSocket** (needs `wscat` — `bun add -g wscat`)
```bash
wscat -c ws://localhost:4000/ws/echo
> {"event":"hello","data":{"hi":"there"}}
< {"event":"echo","data":{"original":{"event":"hello","data":{"hi":"there"}}}}
```

**SSE — open in one terminal:**
```bash
curl -N http://localhost:4000/sse/demo
```
**Publish from another:**
```bash
curl -s -X POST http://localhost:4000/v07-sse-publish \
  -H 'content-type: application/json' \
  -d '{"event":"tick","data":{"now":1}}'
# Watch the first terminal — event arrives within ms
```

**Webhook (Stripe — needs a real signature)**
```bash
export STRIPE_WEBHOOK_SECRET="whsec_test_..."
# Use the Stripe CLI or generate a v1 signature yourself
stripe listen --forward-to http://localhost:4000/webhooks/stripe
```
The polymorphic dispatch is the headline: a `body.type === "invoice.paid"` event routes to the [stripe.invoice.paid.json](triggers/http/workflows/json/stripe.invoice.paid.json) handler with zero switch boilerplate.

**Webhook (GitHub)**
```bash
export GITHUB_WEBHOOK_SECRET="..."
# Point your repo's webhook config at http://your-tunnel/webhooks/github
# Or simulate locally:
PAYLOAD='{"ref":"refs/heads/main","commits":[]}'
SIG="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | cut -d' ' -f2)"
curl -X POST http://localhost:4000/webhooks/github \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: $SIG" \
  -H 'content-type: application/json' \
  -d "$PAYLOAD"
```

**Reliability demos**
```bash
# tryCatch saga — success path
curl -s -X POST http://localhost:4000/v05-saga \
  -H 'content-type: application/json' \
  -d '{"user":"alice","middleUrl":"https://httpbin.org/post"}'

# tryCatch saga — failure path (catch arm fires, rollback recorded)
curl -s -X POST http://localhost:4000/v05-saga \
  -H 'content-type: application/json' \
  -d '{"user":"alice","middleUrl":"https://httpbin.org/status/500"}'

# parallel forEach + wait
curl -s -X POST http://localhost:4000/v05-parallel-foreach-with-wait \
  -H 'content-type: application/json' \
  -d '{"items":["a","b","c","d","e"]}'
```

### Worker + Pub/Sub

These don't run on port 4000. You scaffold them with `blokctl create project <name>` and the template is a standalone project. Inside, you start with whatever the project's `package.json` `dev` script is (typically a worker entrypoint that calls `WorkerTrigger.listen()`).

Quick worker test using the in-memory adapter:
```bash
# Set provider via env or in trigger config
export BLOK_WORKER_ADAPTER=in-memory
# Boot the worker project — see triggers/worker/template
```

For a real broker:
```bash
docker run -p 6379:6379 redis  # or NATS, Kafka, etc.
export BLOK_WORKER_ADAPTER=redis-streams
```

---

## 5. Studio: where to watch it work

Open **http://localhost:4000/__blok** in your browser. Every run lands here with full step-level traces, including:

- Per-step inputs/outputs (sanitized)
- Retry attempts (`NODE_ATTEMPT_FAILED` events)
- Concurrency gate decisions (`RUN_THROTTLED`, `RUN_QUEUED`)
- Wait suspensions (`WAIT_REQUESTED` + resumption traces)
- Sub-workflow lineage (child runs appear as a strip on the parent)
- Cancellation traces (`RUN_CANCELLED`)

Key API endpoints (when you want to script against them):

| Endpoint | Purpose |
|---|---|
| `GET /__blok/runs` | List runs, filter by status/workflow/tags/metadata |
| `GET /__blok/runs/:id` | Single-run detail with all NodeRuns |
| `GET /__blok/runs/:id/subruns` | Children of a sub-workflow parent |
| `POST /__blok/runs/:id/replay` | Re-dispatch with captured payload |
| `POST /__blok/runs/:id/cancel` | Cancel a delayed/queued/running run |
| `GET /__blok/concurrency/health` | Active backend + lease config |
| `GET /__blok/concurrency/state` | Per-bucket in-flight count |

---

## 6. C4 + C1 — the new cross-process backends (open PRs)

Both are on branches, not yet merged. To exercise them you'll need to check out the branch and run with brokers.

### C4 — Redis concurrency backend (PR #89 — `feat/c4-redis-concurrency-backend`)

Replaces NATS KV with Redis for the cross-process concurrency gate. Lua scripts make every acquire atomic (no OCC retry loop).

```bash
git checkout feat/c4-redis-concurrency-backend
bun install
docker run -d -p 6379:6379 --name blok-redis redis:7

# Opt in
export BLOK_CONCURRENCY_BACKEND=redis
export BLOK_CONCURRENCY_REDIS_URL=redis://localhost:6379
export BLOK_CONCURRENCY_REDIS_KEY_PREFIX=blok-concurrency-dev  # required if BLOK_ENV=production

bun run http:dev
```

Verify:
```bash
# Health endpoint should show backend=redis
curl -s http://localhost:4000/__blok/concurrency/health
# {"backend":"redis","disabled":false,"leaseMs":3600000}

# Hit a workflow with concurrencyKey — should rate-limit across processes
for i in 1 2 3 4 5 6; do
  curl -s -X POST http://localhost:4000/v05-tenant-acme &
done
wait
# Some return 200, some 429 — depending on the limit configured
```

Inspect the keys directly:
```bash
docker exec blok-redis redis-cli KEYS "blok-concurrency-dev:*"
docker exec blok-redis redis-cli GET "blok-concurrency-dev:v05-tenant-acme__acme"
# {"leases":[{"runId":"...","expiresAt":...}]}
```

### C1 — Cross-process debounce (PR #90 — `feat/c1-cross-process-debounce`)

Stacked on C4. Makes `DebounceCoordinator` coordinate trailing-window ownership across processes via the same Lua / CAS pattern.

```bash
git checkout feat/c1-cross-process-debounce  # includes C4
docker run -d -p 6379:6379 --name blok-redis redis:7

export BLOK_DEBOUNCE_BACKEND=redis
export BLOK_DEBOUNCE_REDIS_URL=redis://localhost:6379
export BLOK_DEBOUNCE_REDIS_KEY_PREFIX=blok-debounce-dev
export BLOK_DEBOUNCE_OWNER_LEASE_MS=60000   # default

bun run http:dev
```

Test with a debounce workflow. Use one of the v0.5 examples that has `debounce`, or write a quick one:

```jsonc
// triggers/http/workflows/json/v07-debounce-demo.json
{
  "name": "v07-debounce-demo",
  "version": "1.0.0",
  "trigger": {
    "http": {
      "method": "POST",
      "path": "/save/:docId",
      "debounce": {
        "key": "$.req.params.docId",
        "mode": "trailing",
        "delay": "500ms",
        "maxDelay": "5s"
      }
    }
  },
  "steps": [
    { "id": "log", "use": "@blokjs/log", "inputs": { "message": "saved" } }
  ]
}
```

Then:
```bash
# Spam pings — only ONE fires after 500ms of silence
for i in 1 2 3 4 5; do
  curl -s -X POST http://localhost:4000/save/doc-1 -H 'content-type: application/json' -d '{"n":'$i'}' &
done
wait
# 4 responses say "debounced" (202), 1 says "delayed" (the active trailing run)
# Watch /__blok/runs to confirm only one run actually fires
```

For cross-process verification, run the dev server **twice** on different ports. Both will coordinate through Redis — only one window owner across both processes.

Inspect:
```bash
docker exec blok-redis redis-cli KEYS "blok-debounce-dev:*"
docker exec blok-redis redis-cli GET "blok-debounce-dev:v07-debounce-demo__doc-1"
# {"mode":"trailing","scheduledAt":...,"activeRunId":"...","ownerProcessId":"...","ownerLeaseExpiresAt":...}
```

**Important semantic to keep in mind**: cross-process debounce is **owner-local payload**. The process that owns the window fires its captured payload. Coalesce pings from other processes bump `pingCount` + push `scheduledAt` but their payloads are dropped. This is documented in [BACKLOG.md C1](BACKLOG.md) — payload-persisted variant is a deferred follow-up.

---

## 7. The reliability primitives (v0.5 + v0.6) — what to actually try

| Primitive | What it does | Example workflow |
|---|---|---|
| `branch` | if/else | [v05-event-router.json](triggers/http/workflows/json/v05-event-router.json) |
| `switch` | match on value | [v05-multi-tenant-router.json](triggers/http/workflows/json/v05-multi-tenant-router.json) |
| `forEach` (sequential) | iterate | [v05-csv-import.json](triggers/http/workflows/json/v05-csv-import.json) |
| `forEach` (parallel, concurrency) | fan-out | [v05-data-export.json](triggers/http/workflows/json/v05-data-export.json) |
| `forEach` + `wait` inside | Phase 2-4 | [v05-parallel-foreach-with-wait.json](triggers/http/workflows/json/v05-parallel-foreach-with-wait.json) |
| `loop` (`until`) | poll with backoff | [v05-polling-with-backoff.json](triggers/http/workflows/json/v05-polling-with-backoff.json) |
| `tryCatch` | error handling + rollback | [v05-saga.json](triggers/http/workflows/json/v05-saga.json) |
| `wait` | sleep / pause | [v05-async-job-poller.json](triggers/http/workflows/json/v05-async-job-poller.json) |
| `subworkflow` | nested workflow | [v05-github-webhook-router.json](triggers/http/workflows/json/v05-github-webhook-router.json) |
| `idempotencyKey` (step-level) | cache result | [v05-user-signup-saga.json](triggers/http/workflows/json/v05-user-signup-saga.json) |
| `retry` (step-level) | exponential backoff | [v05-async-job-poller.json](triggers/http/workflows/json/v05-async-job-poller.json) |
| `concurrencyKey` (trigger-level) | per-key rate limit | [v05-tenant-acme.json](triggers/http/workflows/json/v05-tenant-acme.json) |
| `onLimit: "queue"` | defer on saturation | (configure on any concurrencyKey trigger) |
| `debounce` (trigger-level) | coalesce rapid pings | (configure on any trigger; or land C1) |
| Workflow / global middleware | cross-cutting concerns | [middleware/jwt-auth.json](triggers/http/workflows/json/middleware/jwt-auth.json) |

---

## 8. Quick reference — env vars worth knowing

| Variable | Why |
|---|---|
| `BLOK_MAPPER_MODE=strict` | Fail-fast on `js/...` expression errors. **Recommended for production.** |
| `BLOK_TRACE_ENABLED=false` | Disable Studio tracing (also disables idempotency cache) |
| `BLOK_CONCURRENCY_BACKEND={nats-kv,redis}` | Cross-process concurrency gate (C4 lands `redis`) |
| `BLOK_DEBOUNCE_BACKEND={nats-kv,redis}` | Cross-process debounce (C1) |
| `BLOK_WORKER_ADAPTER=<provider>` | Default worker adapter when workflow doesn't specify `provider` |
| `BLOK_WS_BACKPLANE=<provider>` | Cross-process WS broadcast via pub/sub fan-out (v0.7) |
| `BLOK_SCHEDULING_DISABLED=1` | Kill-switch for delay/ttl/debounce gates |
| `BLOK_CONCURRENCY_DISABLED=1` | Kill-switch for concurrency gate |
| `BLOK_MAX_SUBWORKFLOW_DEPTH=10` | Recursion cap |

Full list with defaults: [docs/d/operations/env-vars.mdx](docs/d/operations/env-vars.mdx).

---

## 9. Integration tests against real brokers (Phase 2)

Unit tests (the default `bun run test`) use fake clients that mirror Lua / CAS semantics in TypeScript — fast, hermetic, and run on every commit. The **integration tests** exercise the same backends + adapters against real services (Postgres, Redis, NATS, Kafka, RabbitMQ, LocalStack, GCP Pub/Sub emulator).

**Bring services up** ([infra/testing/docker-compose.yml](infra/testing/docker-compose.yml)):
```bash
bun run test:integration:up
```

**Run all integration tests** (sets `BLOK_INTEGRATION_*` env vars + runs the full workspace test suite — integration tests gate on the env vars so unit-only runs are unaffected):
```bash
bun run test:integration
```

**Tear down**:
```bash
bun run test:integration:down
```

Or use the orchestration script directly — it brings up the compose, waits for healthchecks, runs `bun run test` with all env vars set, and tears down on exit:
```bash
bash scripts/integration-test.sh           # full cycle
bash scripts/integration-test.sh --no-up   # services already running
bash scripts/integration-test.sh --skip-down  # leave services up
```

**Per-service env vars** (each test file skips when its var is unset):
| Variable | Default (from compose) |
|---|---|
| `BLOK_INTEGRATION_REDIS_URL` | `redis://localhost:6380` |
| `BLOK_INTEGRATION_NATS_SERVERS` | `nats://localhost:4223` |
| `BLOK_INTEGRATION_KAFKA_BROKERS` | `localhost:9094` |
| `BLOK_INTEGRATION_RABBITMQ_URL` | `amqp://blok:blok_test@localhost:5673` |
| `BLOK_INTEGRATION_POSTGRES_URL` | `postgres://blok:blok_test@localhost:5433/blok_test` |
| `BLOK_INTEGRATION_SQS_ENDPOINT` | `http://localhost:4567` |
| `BLOK_INTEGRATION_GCP_PUBSUB_ENDPOINT` | `localhost:8086` |

**CI**: [.github/workflows/integration.yml](.github/workflows/integration.yml) runs the full integration suite on every PR + push to `main`. ~15-min cap.

**What's covered today** (Phase 2, shipping in `feat/docker-compose-ci`):
- Reliability backends: `RedisConcurrencyBackend` (C4 verify), `RedisDebounceBackend` (C1 verify), `NatsKvConcurrencyBackend` (H3), `NatsKvDebounceBackend` (C1 verify) — all against real Redis + NATS JetStream.
- Durable scheduler crash-restart (H4) — real sqlite file survives close + reopen.
- `NATSWorkerAdapter` (closes #86 NATS debt) — publish + consume against real JetStream.
- `NATSPubSubAdapter` (closes #87 debt) — fan-out + competing-consumer modes.

**Follow-up adapter coverage** (same pattern, deferred to a Phase 2.1 PR): `KafkaWorkerAdapter`, `RabbitMQAdapter`, `SQSAdapter` (LocalStack), `PgBossAdapter`, `RedisStreamsAdapter` (worker + pubsub), `KafkaPubSubAdapter`, `GCPPubSubAdapter` (emulator), `AzureServiceBusAdapter`, `AWSSNSAdapter`.

---

## 10. Suggested testing order

1. **Sanity** — `bun run http:dev`, hit `http://localhost:4000/countries` and `/__blok`. Confirm a run appears in Studio.
2. **WebSocket** — `wscat` against `/ws/echo`. Confirm `connect` + `message` traces in Studio.
3. **SSE** — open `/sse/demo` in one terminal, post to `/v07-sse-publish` in another. Verify events flow.
4. **Webhooks** — set `STRIPE_WEBHOOK_SECRET`, run `stripe listen --forward-to ...`. Verify polymorphic routing.
5. **Reliability primitives** — fire `/v05-saga` with both URLs to see success + failure paths.
6. **Concurrency** — fire `/v05-tenant-acme` from a loop, watch some throttle.
7. **C4** — check out `feat/c4-redis-concurrency-backend`, spin up Redis, repeat #6 with `BLOK_CONCURRENCY_BACKEND=redis`, inspect Redis keys.
8. **C1** — check out `feat/c1-cross-process-debounce`, add a debounce workflow, run TWO copies of the dev server on different ports against the same Redis, watch only one process fire.

---

**Where to look if you hit something weird:**
- Step's input isn't resolving? Set `BLOK_MAPPER_MODE=strict` — you'll get the exact expression that failed.
- WS not connecting? Open `/__blok` — the catch-all may have grabbed the WS path if you redefined it.
- Webhook returning 401? Check the secret env var matches the provider's signing key.
- A workflow run vanished? Check `BLOK_TRACE_ENABLED` isn't false.

Both PRs (#89, #90) are open and ready for review whenever you want them merged.
