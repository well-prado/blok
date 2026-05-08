# Blok Framework — AI-Friendly Documentation Index

> **Purpose:** This file is structured for optimal AI/LLM retrieval. It provides a flat, keyword-rich index of every concept, API, and feature in Blok with direct pointers to source files.

## Framework Identity
- **Name:** Blok (formerly blok)
- **Type:** Workflow orchestration framework
- **Language:** TypeScript (Node.js)
- **License:** Apache 2.0
- **Repository:** https://github.com/deskree-inc/blok
- **Documentation:** https://blok.build/
- **CLI:** blokctl (npm package)
- **Package Scope:** @blokjs/*

## Quick Answers

### How to create a new Blok project?
```bash
npx blokctl@latest create project
```

### How to create a node?
```typescript
// File: src/nodes/my-node/index.ts
import { z } from "zod";
import { defineNode } from "@blokjs/runner";

export default defineNode({
  name: "my-node",
  description: "What this node does",
  input: z.object({ /* Zod schema */ }),
  output: z.object({ /* Zod schema */ }),
  async execute(ctx, input) {
    return { /* output matching schema */ };
  },
});
```
**Source:** `core/runner/src/defineNode.ts`

### How to create a workflow?
```json
{
  "name": "my-workflow",
  "trigger": { "http": { "method": "POST", "path": "/api/endpoint" } },
  "steps": [
    {
      "name": "step-1",
      "node": "my-node",
      "type": "local",
      "inputs": { "field": { "$param": "ctx.request.body.field" } }
    }
  ],
  "response": { "status": 200, "body": "ctx.vars.step-1" }
}
```
**Source:** `core/workflow-helper/src/types/`

### How to run locally?
```bash
pnpm install && pnpm http:dev
# Server at http://localhost:4000
```

### How to run with Docker?
```bash
docker compose -f infra/docker-compose.production.yml up -d
```

---

## Concept → Source File Index

### Core APIs
| Concept | File | Package |
|---------|------|---------|
| defineNode | `core/runner/src/defineNode.ts` | @blokjs/runner |
| BlokService (class-based node) | `core/runner/src/BlokService.ts` | @blokjs/runner |
| Context type | `core/shared/src/types/Context.ts` | @blokjs/shared |
| GlobalError | `core/shared/src/GlobalError.ts` | @blokjs/shared |
| Runner | `core/runner/src/Runner.ts` | @blokjs/runner |
| TriggerBase | `core/runner/src/TriggerBase.ts` | @blokjs/runner |
| Workflow builder | `core/workflow-helper/src/index.ts` | @blokjs/helper |
| Configuration | `core/runner/src/Configuration.ts` | @blokjs/runner |
| NodeBase | `core/shared/src/NodeBase.ts` | @blokjs/shared |
| Mapper | `core/shared/src/utils/Mapper.ts` | @blokjs/shared |

### Runtime Adapters
| Adapter | File | Protocol |
|---------|------|----------|
| RuntimeAdapter interface | `core/runner/src/adapters/RuntimeAdapter.ts` | - |
| RuntimeRegistry | `core/runner/src/RuntimeRegistry.ts` | - |
| NodeJs adapter | `core/runner/src/adapters/NodeJsRuntimeAdapter.ts` | In-process |
| Bun adapter | `core/runner/src/adapters/BunRuntimeAdapter.ts` | In-process |
| Python3 adapter | `core/runner/src/adapters/Python3RuntimeAdapter.ts` | gRPC |
| Docker adapter | `core/runner/src/adapters/DockerRuntimeAdapter.ts` | HTTP/gRPC |
| WASM adapter | `core/runner/src/adapters/WasmRuntimeAdapter.ts` | In-process |

### Triggers
| Trigger | Entry File | Config Type |
|---------|-----------|------------|
| HTTP | `triggers/http/src/index.ts` | `{ method, path }` |
| gRPC | `triggers/grpc/src/index.ts` | `{ service, method }` |
| Queue | `triggers/queue/src/QueueTrigger.ts` | `{ provider, topic }` |
| Pub/Sub | `triggers/pubsub/src/PubSubTrigger.ts` | `{ provider, channel }` |
| Cron | `triggers/cron/src/CronTrigger.ts` | `{ schedule, timezone }` |
| Webhook | `triggers/webhook/src/WebhookTrigger.ts` | `{ source, events }` |
| WebSocket | `triggers/websocket/src/WebSocketTrigger.ts` | `{ path }` |
| SSE | `triggers/sse/src/SSETrigger.ts` | `{ path }` |
| Worker | `triggers/worker/src/WorkerTrigger.ts` | `{ queue, concurrency }` |

### Security
| Feature | File |
|---------|------|
| Auth Middleware (JWT/API key) | `core/runner/src/security/AuthMiddleware.ts` |
| OAuth 2.0 / OIDC | `core/runner/src/security/OAuthProvider.ts` |
| RBAC | `core/runner/src/security/RBAC.ts` |
| ABAC | `core/runner/src/security/ABAC.ts` |
| Secret Manager | `core/runner/src/security/SecretManager.ts` |
| Audit Logger | `core/runner/src/security/AuditLogger.ts` |
| Encryption at Rest | `core/runner/src/security/EncryptionAtRest.ts` |
| PII Detector | `core/runner/src/security/PIIDetector.ts` |
| TLS Config | `core/runner/src/security/TLSConfig.ts` |

### Monitoring
| Feature | File |
|---------|------|
| Distributed Tracing | `core/runner/src/monitoring/DistributedTracer.ts` |
| Structured Logging | `core/runner/src/monitoring/StructuredLogger.ts` |
| Prometheus Metrics | `core/runner/src/monitoring/PrometheusMetricsBridge.ts` |
| Circuit Breaker | `core/runner/src/monitoring/CircuitBreaker.ts` |
| Rate Limiter | `core/runner/src/monitoring/RateLimiter.ts` |
| Health Check | `core/runner/src/monitoring/HealthCheck.ts` |
| Performance Profiler | `core/runner/src/monitoring/PerformanceProfiler.ts` |
| Sentry | `core/runner/src/integrations/SentryIntegration.ts` |
| APM (DataDog/NewRelic) | `core/runner/src/integrations/APMIntegration.ts` |
| CloudWatch | `core/runner/src/integrations/CloudWatchIntegration.ts` |
| Azure Monitor | `core/runner/src/integrations/AzureMonitorIntegration.ts` |

### SDKs (Multi-Language)
| Language | Path | Entry |
|----------|------|-------|
| Go | `sdks/go/` | `cmd/server/main.go` |
| Java | `sdks/java/` | `src/main/java/com/blok/` |
| Rust | `sdks/rust/` | `src/main.rs` |
| C# | `sdks/csharp/` | `src/Blok.Core/Program.cs` |
| PHP | `sdks/php/` | `src/Server.php` |
| Ruby | `sdks/ruby/` | `lib/blok/server.rb` |
| Python | `runtimes/python3/` | `server.py` |

### CLI Commands
| Command | File |
|---------|------|
| create project | `packages/cli/src/commands/create/project.ts` |
| create node | `packages/cli/src/commands/create/node.ts` |
| generate ai-node | `packages/cli/src/commands/generate/NodeGenerator.ts` |
| generate ai-workflow | `packages/cli/src/commands/generate/WorkflowGenerator.ts` |
| generate ai-trigger | `packages/cli/src/commands/generate/TriggerGenerator.ts` |
| dev | `packages/cli/src/commands/dev/index.ts` |
| build | `packages/cli/src/commands/build/index.ts` |
| deploy | `packages/cli/src/commands/deploy/index.ts` |
| monitor | `packages/cli/src/commands/monitor/index.ts` |
| graph | `packages/cli/src/commands/graph/index.ts` |
| cost | `packages/cli/src/commands/cost/index.ts` |
| migrate | `packages/cli/src/commands/migrate/index.ts` |

### Infrastructure
| Resource | File |
|----------|------|
| Helm Chart | `infra/helm/blok/` |
| Terraform | `infra/terraform/main.tf` |
| CloudFormation | `infra/cloudformation/blok-stack.yaml` |
| Azure ARM | `infra/arm/blok-deploy.json` |
| Docker (HTTP) | `dockerfiles/Dockerfile.deploy.http` |
| Dev Docker Compose | `infra/development/docker-compose.yml` |
| Prod Docker Compose | `infra/docker-compose.production.yml` |
| Test Docker Compose | `infra/testing/docker-compose.yml` |
| Monitoring Compose | `infra/metrics/docker-compose.yml` |
| Grafana Dashboards | `infra/metrics/dashboards/` |
| Prometheus Config | `infra/metrics/prometheus.yml` |

### Testing
| Type | Location |
|------|----------|
| Unit tests (runner) | `core/runner/__tests__/unit/` |
| Unit tests (shared) | `core/shared/__tests__/unit/` |
| Integration tests | `core/runner/__tests__/integration/` |
| SDK contract tests | `tests/integration/sdk-contract/` |
| Test harness | `core/runner/src/testing/TestHarness.ts` |
| Workflow test runner | `core/runner/src/testing/WorkflowTestRunner.ts` |

---

## Keywords for Search

blok, blok, workflow, orchestration, node, trigger, context, runner,
defineNode, function-first, zod, schema, validation, typescript, javascript,
http, grpc, queue, kafka, rabbitmq, sqs, redis, pubsub, gcp, aws, azure,
cron, webhook, websocket, sse, worker, bullmq, nats,
runtime, adapter, nodejs, python, go, java, rust, csharp, php, ruby, docker, wasm,
security, auth, jwt, oauth, rbac, abac, secret, vault, encryption, tls, audit, pii,
monitoring, logging, tracing, opentelemetry, prometheus, grafana, sentry, cloudwatch,
circuit-breaker, rate-limiter, health-check, metrics, apm, datadog, newrelic,
testing, unit-test, integration-test, vitest, test-harness,
cli, blokctl, generate, ai, code-generation, scaffold,
deployment, docker, kubernetes, helm, terraform, cloudformation, arm,
hmr, hot-reload, caching, cost-estimation, graphql, openapi, visualization
