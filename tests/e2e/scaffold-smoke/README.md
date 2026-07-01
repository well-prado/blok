# Scaffold smoke E2E

The **"scaffold → boot → curl"** verification, codified. It proves the thing we
actually ship — a project created by `blokctl` — works end to end: **no dead
triggers, no dead runtimes, no unresolved helper nodes.**

Every other test suite mocks something. This one mocks nothing: it creates a
real project with the local `blokctl`, boots it under `blokctl dev`, and hits
every endpoint over the real wire (HTTP, WebSocket, gRPC) — the same way a user
would. It exists because unit/integration tests kept passing while the *shipped
scaffold* was broken (a helper node wasn't registered, a trigger printed "not
yet implemented", a sidecar booted with the wrong interpreter). Those are only
caught by scaffolding for real and curling.

## What it covers

Booted from a single `--examples` scaffold with every applicable trigger +
every detected runtime:

| Category | Check | Proves |
|---|---|---|
| http | `GET /health-check` | HTTP trigger serves |
| http | `GET /countries-dsl` | `@blokjs/respond` helper resolves (#640) |
| sse | `POST /v07-sse-publish` | `@blokjs/sse-publish` helper resolves |
| websocket | `/ws/echo` dispatch | WS trigger dispatches + `@blokjs/ws-reply` runs |
| webhook | `POST /webhooks/stripe` (bad + valid sig) | HMAC signature gate rejects 401 / accepts 200 |
| mcp | `POST /mcp` initialize + `tools/call greet` | MCP transport + `@blokjs/expr` helper |
| worker | `POST /fanout/jobs` | `@blokjs/worker-publish` enqueues + in-memory worker consumes |
| cron | dev log | cron trigger boots + schedules the heartbeat |
| grpc | `GrpcClient → @blokjs/expr` | gRPC trigger serves the project's own nodes |
| pubsub | `POST /orders` → broker → consumer | produce → NATS → `trigger: { pubsub }` consumer runs |
| runtime | `POST /runtimes/<lang>/hello` | each language sidecar boots + answers over gRPC |

## Running

```bash
bun run e2e:smoke                      # detect + scaffold + boot + curl + teardown
# or
bash tests/e2e/scaffold-smoke/run.sh
```

It **gates on what's installed** and reports what it SKIPPED and why — no silent
truncation. `pubsub` needs a NATS broker; each runtime needs its toolchain
(interpreted runtimes are skipped when the toolchain is missing/too old — Ruby
< 3.1, no Composer/RoadRunner for PHP; see #644).

### Env knobs

| Var | Effect |
|---|---|
| `SMOKE_RUNTIMES=go,python3` | limit to these runtimes (default: all detected) |
| `SMOKE_TRIGGERS=http,grpc` | limit to these triggers (default: all applicable) |
| `SMOKE_SKIP_BUILD=1` | skip `bun run build` (assume `dist/` is current) |
| `SMOKE_KEEP=1` | keep the scaffolded project + `dev.log` for inspection |
| `NATS_SERVERS=host:port` | NATS for the pubsub trigger (default `localhost:4222`) |
| `BLOK_SMOKE_REQUIRE_ALL=1` | **fail** unless every applicable check passes (CI mode) |
| `BLOK_SMOKE_REQUIRE=grpc,pubsub` | require only these categories to pass |

Without a gate a `FAIL` still exits non-zero; a `SKIP` never does. In CI, set
`BLOK_SMOKE_REQUIRE_ALL=1` so a runtime/trigger that silently stops booting
fails the build instead of quietly dropping out of the matrix.

## Prerequisites

- **bun** (runs the CLI, the dev server, and this driver).
- A built monorepo — `run.sh` runs `bun run build` first unless `SMOKE_SKIP_BUILD=1`.
- **NATS** on `localhost:4222` for the pubsub trigger (`docker compose -f infra/development/docker-compose.yml up -d nats`, or the shared `blok-nats` container).
- Per-runtime toolchains for the sidecars you want covered (Go, Rust, Java+Maven, .NET, PHP+Composer+RoadRunner, Ruby ≥ 3.1, Python 3).

## Design notes

- **Single source of truth for what to check.** The driver (`smoke.ts`) reads
  the scaffold's `.blok/config.json` for spawned triggers + runtimes, unioned
  with the requested trigger set (`SMOKE_TRIGGERS`) since SSE/WebSocket/Webhook/
  MCP *mount on the HTTP process* and never appear in `config.json`.
- **Assert behaviour, not just "it booted."** Each check asserts a real
  response body / status / log line, so a trigger that boots but does nothing
  still fails.
- **Streaming triggers assert dispatch, not frame delivery.** SSE/WebSocket
  checks assert the trigger dispatched + the helper node ran (the delivery layer
  has its own tracked issues, e.g. #650) — the point here is trigger + node
  resolution.
- **Portless triggers via the dev log.** Cron/worker/pubsub observation reads
  the captured `blokctl dev` output (`SMOKE_DEV_LOG`).
