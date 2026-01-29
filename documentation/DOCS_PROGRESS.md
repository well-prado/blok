# Blok Documentation Progress Tracker

> Tracking every documentation page from planning to published.

## Status Legend
- `[ ]` Not started
- `[D]` Drafted (content written, needs review)
- `[R]` In review
- `[x]` Published

## Overall Progress

| Phase | Total | Done | In Progress | Remaining |
|-------|-------|------|-------------|-----------|
| Phase 1: Foundation | 18 | 0 | 0 | 18 |
| Phase 2: Triggers | 9 | 0 | 0 | 9 |
| Phase 3: Runtimes | 12 | 0 | 0 | 12 |
| Phase 4: Security | 9 | 0 | 0 | 9 |
| Phase 5: Observability | 12 | 0 | 0 | 12 |
| Phase 6: Tools & Deploy | 10 | 0 | 0 | 10 |
| Phase 7: Advanced | 10 | 0 | 0 | 10 |
| **Total** | **80** | **0** | **0** | **80** |

---

## Phase 1: Foundation (P0 - Launch Blocking)

### Getting Started
| # | Page | Status | Module Reference | Assigned | Notes |
|---|------|--------|-----------------|----------|-------|
| 1.1 | Introduction (What is Blok?) | [ ] | [overview.md](modules/overview.md) | - | Sets the tone for all docs |
| 1.2 | Installation | [ ] | [overview.md](modules/overview.md) | - | pnpm, Node 18+, Docker |
| 1.3 | Quick Start (5-minute guide) | [ ] | [quick-start/](quick-start/) | - | Create project → node → workflow → run |
| 1.4 | Project Structure | [ ] | [overview.md](modules/overview.md) | - | Explain every top-level directory |
| 1.5 | Configuration | [ ] | [core-runner.md](modules/core-runner.md) | - | Env vars, config files, runtime config |

### Core Concepts
| # | Page | Status | Module Reference | Assigned | Notes |
|---|------|--------|-----------------|----------|-------|
| 1.6 | How Blok Works | [ ] | [core-runner.md](modules/core-runner.md) | - | Architecture overview, request lifecycle |
| 1.7 | Nodes | [ ] | [nodes.md](modules/nodes.md) | - | What nodes are, how they work |
| 1.8 | Workflows | [ ] | [workflow-helper.md](modules/workflow-helper.md) | - | Workflow structure and execution |
| 1.9 | Triggers Overview | [ ] | [triggers.md](modules/triggers.md) | - | All trigger types at a glance |
| 1.10 | Context & Data Flow | [ ] | [core-shared.md](modules/core-shared.md) | - | **HIGH PRIORITY** — Critical learnings from E2E: ctx.vars vs ctx.response.data, Mapper resolution, runtime adapter data flow. See DOCS_ROADMAP.md for details. |

### Building Nodes
| # | Page | Status | Module Reference | Assigned | Notes |
|---|------|--------|-----------------|----------|-------|
| 1.11 | Function-First Nodes | [ ] | [define-node.md](modules/define-node.md) | - | defineNode API, Zod schemas |
| 1.12 | Input/Output Schemas | [ ] | [define-node.md](modules/define-node.md) | - | Zod validation patterns |

### First Steps
| # | Page | Status | Module Reference | Assigned | Notes |
|---|------|--------|-----------------|----------|-------|
| 1.13 | HTTP Trigger | [ ] | [trigger-http.md](modules/trigger-http.md) | - | Most common trigger type |
| 1.14 | CLI: create command | [ ] | [cli.md](modules/cli.md) | - | Project/node/workflow scaffolding |
| 1.15 | CLI: dev command | [ ] | [cli.md](modules/cli.md) | - | Local development server |
| 1.16 | Docker Setup | [ ] | [deployment.md](modules/deployment.md) | - | Dockerfile, docker-compose |

### First Examples
| # | Page | Status | Module Reference | Assigned | Notes |
|---|------|--------|-----------------|----------|-------|
| 1.17 | Hello World Example | [ ] | - | - | Minimal working example |
| 1.18 | REST API Example | [ ] | - | - | Real-world HTTP API |

---

## Phase 2: Trigger System

| # | Page | Status | Module Reference | Assigned | Notes |
|---|------|--------|-----------------|----------|-------|
| 2.1 | gRPC Trigger | [ ] | [trigger-grpc.md](modules/trigger-grpc.md) | - | |
| 2.2 | Queue Triggers | [ ] | [trigger-queue.md](modules/trigger-queue.md) | - | Kafka, RabbitMQ, SQS, Redis |
| 2.3 | Pub/Sub Triggers | [ ] | [trigger-pubsub.md](modules/trigger-pubsub.md) | - | GCP, AWS SNS, Azure |
| 2.4 | Cron Triggers | [ ] | [trigger-cron.md](modules/trigger-cron.md) | - | Scheduled workflows |
| 2.5 | Webhook Triggers | [ ] | [trigger-webhook.md](modules/trigger-webhook.md) | - | GitHub, Stripe, Shopify |
| 2.6 | WebSocket Trigger | [ ] | [trigger-websocket.md](modules/trigger-websocket.md) | - | Real-time |
| 2.7 | SSE Trigger | [ ] | [trigger-sse.md](modules/trigger-sse.md) | - | Server-Sent Events |
| 2.8 | Worker Trigger | [ ] | [trigger-worker.md](modules/trigger-worker.md) | - | Background jobs |
| 2.9 | Building Custom Triggers | [ ] | [triggers.md](modules/triggers.md) | - | TriggerBase extension |

---

## Phase 3: Multi-Language Runtimes

| # | Page | Status | Module Reference | Assigned | Notes |
|---|------|--------|-----------------|----------|-------|
| 3.1 | Runtime Architecture | [ ] | [runtime-adapters.md](modules/runtime-adapters.md) | - | **KEY CONTENT**: 3 adapter types (NodeJS/Python3/HTTP), workflow type mapping, env vars, ExecutionResult contract. See DOCS_ROADMAP.md Phase 3 notes. |
| 3.2 | Node.js Runtime | [ ] | [runtime-adapters.md](modules/runtime-adapters.md) | - | |
| 3.3 | Python 3 Runtime | [ ] | [runtime-python.md](modules/runtime-python.md) | - | Document gRPC protocol, config.inputs behavior, resolved inputs as request.body |
| 3.4 | Go SDK | [ ] | [sdk-go.md](modules/sdk-go.md) | - | |
| 3.5 | Java SDK | [ ] | [sdk-java.md](modules/sdk-java.md) | - | |
| 3.6 | Rust SDK | [ ] | [sdk-rust.md](modules/sdk-rust.md) | - | |
| 3.7 | C# / .NET SDK | [ ] | [sdk-csharp.md](modules/sdk-csharp.md) | - | |
| 3.8 | PHP SDK | [ ] | [sdk-php.md](modules/sdk-php.md) | - | |
| 3.9 | Ruby SDK | [ ] | [sdk-ruby.md](modules/sdk-ruby.md) | - | |
| 3.10 | Docker Runtime | [ ] | [runtime-adapters.md](modules/runtime-adapters.md) | - | |
| 3.11 | WASM Runtime | [ ] | [runtime-adapters.md](modules/runtime-adapters.md) | - | |
| 3.12 | Building Custom Runtimes | [ ] | [runtime-adapters.md](modules/runtime-adapters.md) | - | |

---

## Phase 4: Security & Enterprise

| # | Page | Status | Module Reference | Assigned | Notes |
|---|------|--------|-----------------|----------|-------|
| 4.1 | Security Overview | [ ] | [security.md](modules/security.md) | - | |
| 4.2 | Auth Middleware | [ ] | [security.md](modules/security.md) | - | |
| 4.3 | OAuth 2.0 / OIDC | [ ] | [security.md](modules/security.md) | - | |
| 4.4 | RBAC | [ ] | [security.md](modules/security.md) | - | |
| 4.5 | ABAC | [ ] | [security.md](modules/security.md) | - | |
| 4.6 | Secret Management | [ ] | [security.md](modules/security.md) | - | |
| 4.7 | Encryption | [ ] | [security.md](modules/security.md) | - | |
| 4.8 | Audit Logging | [ ] | [security.md](modules/security.md) | - | |
| 4.9 | PII Detection | [ ] | [security.md](modules/security.md) | - | |

---

## Phase 5: Observability & Operations

| # | Page | Status | Module Reference | Assigned | Notes |
|---|------|--------|-----------------|----------|-------|
| 5.1 | Observability Overview | [ ] | [observability.md](modules/observability.md) | - | |
| 5.2 | Structured Logging | [ ] | [observability.md](modules/observability.md) | - | |
| 5.3 | Distributed Tracing | [ ] | [observability.md](modules/observability.md) | - | |
| 5.4 | Prometheus Metrics | [ ] | [observability.md](modules/observability.md) | - | |
| 5.5 | Grafana Dashboards | [ ] | [observability.md](modules/observability.md) | - | |
| 5.6 | APM Integration | [ ] | [observability.md](modules/observability.md) | - | |
| 5.7 | Sentry Integration | [ ] | [observability.md](modules/observability.md) | - | |
| 5.8 | CloudWatch | [ ] | [observability.md](modules/observability.md) | - | |
| 5.9 | Azure Monitor | [ ] | [observability.md](modules/observability.md) | - | |
| 5.10 | Health Checks | [ ] | [observability.md](modules/observability.md) | - | |
| 5.11 | Circuit Breakers | [ ] | [observability.md](modules/observability.md) | - | |
| 5.12 | Rate Limiting | [ ] | [observability.md](modules/observability.md) | - | |

---

## Phase 6: Tools & Deployment

| # | Page | Status | Module Reference | Assigned | Notes |
|---|------|--------|-----------------|----------|-------|
| 6.1 | Testing Overview | [ ] | [testing.md](modules/testing.md) | - | |
| 6.2 | Test Harness | [ ] | [testing.md](modules/testing.md) | - | |
| 6.3 | Full CLI Reference | [ ] | [cli.md](modules/cli.md) | - | |
| 6.4 | VS Code Extension | [ ] | [ide.md](modules/ide.md) | - | |
| 6.5 | Docker Compose (Dev) | [ ] | [deployment.md](modules/deployment.md) | - | |
| 6.6 | Docker Compose (Prod) | [ ] | [deployment.md](modules/deployment.md) | - | |
| 6.7 | Kubernetes / Helm | [ ] | [deployment.md](modules/deployment.md) | - | |
| 6.8 | Terraform | [ ] | [deployment.md](modules/deployment.md) | - | |
| 6.9 | AI Code Generation | [ ] | [ai-generation.md](modules/ai-generation.md) | - | |
| 6.10 | Migration Guides | [ ] | [migration.md](modules/migration.md) | - | |

---

## Phase 7: Advanced & Examples

| # | Page | Status | Module Reference | Assigned | Notes |
|---|------|--------|-----------------|----------|-------|
| 7.1 | HMR / Hot Reload | [ ] | [advanced.md](modules/advanced.md) | - | |
| 7.2 | Node Result Caching | [ ] | [advanced.md](modules/advanced.md) | - | |
| 7.3 | Cost Estimation | [ ] | [advanced.md](modules/advanced.md) | - | |
| 7.4 | GraphQL Generation | [ ] | [advanced.md](modules/advanced.md) | - | |
| 7.5 | OpenAPI Generation | [ ] | [advanced.md](modules/advanced.md) | - | |
| 7.6 | Workflow Visualization | [ ] | [advanced.md](modules/advanced.md) | - | |
| 7.7 | Performance Profiling | [ ] | [advanced.md](modules/advanced.md) | - | |
| 7.8 | Compliance Guides | [ ] | [compliance.md](modules/compliance.md) | - | |
| 7.9 | E-commerce Example | [ ] | - | - | |
| 7.10 | Event-Driven Example | [ ] | - | - | |

---

## Changelog

| Date | Update |
|------|--------|
| 2026-01-29 | Added critical learnings from E2E validation: ctx.vars data flow, runtime adapter architecture, Python3 adapter notes |
| 2026-01-29 | Initial documentation roadmap and progress tracker created |

---

**Last Updated:** 2026-01-29
**Total Pages:** 80
**Completed:** 0 / 80 (0%)
