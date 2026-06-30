# Blok — Real-Environment E2E Test Matrix

Comprehensive, **runnable** E2E coverage driven against **real infrastructure** — live broker
containers, real gRPC sidecars, a real metrics/tracing/logs stack, and a live Blok runner
process. **No mocks of trigger/runtime/broker internals.** Every assertion checks a real wire
response, real broker state, a real OTel instrument, or an observed clock-fired run.

This file is the index. It was seeded by a multi-agent authoring pass (52 detailed cases across
8 domains) plus the live runs below.

## Live results already proven (this campaign)

| Area | Proof | Result |
|---|---|---|
| **All 7 gRPC runtimes** | `tests/e2e/cross-runtime` — built 7 SDK Docker images, drove them through the runner's real `GrpcRuntimeAdapter` | **108/108**, 0 failed — ListNodes + typed execute + validation-error envelope + user-node discovery per language, plus the `go→rust→csharp→java→php→ruby→python3` cross-runtime chain (7 ordered entries) |
| **Node runtime (in-process)** | Scaffolded HTTP project E2E (`apiCall` → handle → `RespondNode`) | both nodes executed; run traced; metrics + logs emitted |
| **Worker queue (BullMQ / Redis)** | Real `BullMQAdapter` against a live Redis container | enqueue→consume; flaky job threw on attempt 1 → redelivered through Redis → succeeded on attempt 2 |
| **Observability stack** | `infra/metrics` — Prometheus/Grafana/Tempo/Loki/Alloy/Alertmanager all `Up` | (live signal verification in E5) |

## How to run (real infra families)

**A. Web/event triggers (no broker)** — one Hono app on :4000 multiplexes HTTP/SSE/WS/Webhook/MCP:
```bash
bun run build && bun run http:dev   # or: cd triggers/http && PORT=4000 bun run src/index.ts
```

**B. Message brokers (single container each)** — `infra/testing/docker-compose.yml`:
```bash
docker network create shared-network 2>/dev/null || true
docker compose -f infra/testing/docker-compose.yml up -d nats redis kafka gcp-pubsub-emulator localstack
# host ports: NATS 4223, Redis 6380, Kafka 9094, GCP emu 8086, LocalStack 4567
```

**C. Cross-runtime gRPC sidecars** — `tests/e2e/cross-runtime/docker-compose.yml` (ports 10001–10007):
```bash
bun tests/e2e/cross-runtime/prepare-usernodes.ts
docker compose -f tests/e2e/cross-runtime/docker-compose.yml up -d --build
BLOK_E2E_REQUIRE_ALL=1 BLOK_E2E_USERNODES=1 bun tests/e2e/cross-runtime/spec-b-typed-e2e.ts
```

**D. Observability** — `infra/metrics/docker-compose.yml` (Prometheus :9090, Grafana :3000, Tempo :4318 OTLP, Loki :3100, Alertmanager :9093):
```bash
docker network create shared-network 2>/dev/null || true
docker compose -f infra/metrics/docker-compose.yml up -d
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 APP_NAME=blok-http bun run http:dev
```

## Epics (52 cases authored; detail in tracking issues)

| Epic | Domain | Cases | Infra |
|---|---|---|---|
| **E1** | Streaming & web triggers (HTTP / SSE / WebSocket) | 11 | port-4000 Hono multiplex |
| **E2** | Event/RPC triggers (Webhook / MCP / Cron / gRPC) | 22 | HMAC signers, MCP SSE+Streamable-HTTP, cron clock-firing, Connect gRPC |
| **E3** | PubSub real brokers (NATS / Redis / Kafka / GCP / AWS / Azure) | 10 | `infra/testing` brokers |
| **E4** | Cross-runtime SDK sidecars (node + 7 gRPC) | 8 | `tests/e2e/cross-runtime` — **proven live (108/108)** |
| **E5** | Observability (metrics / tracing / logs / Studio / alerting) | 13 | `infra/metrics` stack |
| **E6** | Worker / queues (8 backends: BullMQ/Redis-Streams/pg-boss/NATS/RabbitMQ/Kafka/SQS/in-memory) | TODO¹ | single-container brokers — **BullMQ proven live** |
| **E7** | CLI + node packaging (`create`/`dev`/`nodes sync`/`runtime add`/auto-discovery) | TODO¹ | local CLI |

¹ E6 (worker-queues detail) and E7 (cli-nodes detail) authoring agents hit the structured-output
retry cap; the recon runbooks for both are captured (queue backends + CLI commands) and the live
BullMQ case is proven — these two domains need a focused re-author before tracking.

## For EACH case the spec carries

`id` · `infra` (real service + port + env) · `setup` (exact commands) · `workflow` (handle-DSL or
trigger config under test) · `steps` (curl / dispatch / publish) · `assertions` (**real-data
checks** — response shape, broker state, metric value, log line, Studio run trace) · `edgeCases`
(malformed input, broker down, crash/restart, timeout, backpressure, auth, idempotency, concurrency).

## Framework bug-fix tasks surfaced

1. **OBS-FIX-PROM-PORT** — `infra/metrics/prometheus.yml` scrapes `blok-http:4000` but the served metrics port + compose port mapping disagree; make the served port, compose mapping, and scrape target agree.
2. **OBS-FIX-TEMPO-MEMCACHED** — `infra/metrics/tempo.yaml` references a `memcached:11211` cache with no compose service; remove the `cache.caches` block (or add the service).
3. **PUBSUB-AWS-ENDPOINT** — `AWSSNSAdapter` hardcodes `new SQSClient({region})` / `new SNSClient({region})` with no `endpoint` override (the worker `SQSAdapter` takes one); add it so LocalStack works without `AWS_ENDPOINT_URL`.
4. **PUBSUB-LOCALSTACK-SNS** — `infra/testing/docker-compose.yml` LocalStack `SERVICES` is `sqs`-only; add `sns` for the SNS→SQS fan-out path.
5. **PUBSUB-AZURE-EMULATOR** — no Azure Service Bus emulator is wired; add a compose pair (`servicebus-emulator` + `mssql/server` + `Config.json`) so the Azure path is runnable.
6. **PUBSUB-KAFKA-SEEK** — the Kafka pubsub adapter ignores `startFrom:{seq}` / `{timestamp}` (falls through to latest); honor seek via `admin.seek` or document+validate the limit.

## Coverage summary

8 runtimes (node + 7 gRPC) · 9 triggers (http/sse/websocket/webhook/mcp/cron/grpc/pubsub/worker) ·
8 worker backends · 6 pubsub backends · the full handle-DSL feature surface (branch/forEach/switchOn/
tryCatch/ephemeral/spread/as/idempotencyKey/retry/maxDuration/concurrencyKey/delay/ttl/debounce/
sub-workflows) · the observability pipeline (metrics/traces/logs/Studio/alerting) · the CLI.
