# Blok Framework — Complete Architecture Overview

> This document serves as the master reference for understanding the entire Blok framework. It maps every folder, module, and system in the codebase and explains how they connect.

## What is Blok?

Blok is an open-source workflow orchestration framework built with TypeScript. It enables developers to compose backend logic from small, single-responsibility units called **nodes**, connect them into **workflows**, and trigger execution via **triggers** (HTTP, gRPC, queues, cron, webhooks, WebSocket, SSE, workers).

Blok is **language-agnostic**: while the core engine runs in Node.js, individual nodes can execute in any language (Python, Go, Java, Rust, C#, PHP, Ruby) through a pluggable runtime adapter system.

## Monorepo Structure

Blok is a **pnpm monorepo** managed with **Nx**. Here is every top-level directory and its purpose:

```
blok/
├── core/                    # Core engine (runner, shared types, workflow builder)
│   ├── runner/              # Workflow execution engine (THE heart of Blok)
│   ├── shared/              # Shared types, base classes, utilities
│   └── workflow-helper/     # Programmatic workflow builder DSL
│
├── triggers/                # Event sources that start workflow execution
│   ├── http/                # Express.js HTTP server
│   ├── grpc/                # gRPC/Connect RPC server
│   ├── cron/                # Scheduled task trigger (node-cron)
│   ├── queue/               # Message queue consumer (Kafka, RabbitMQ, SQS, Redis)
│   ├── pubsub/              # Pub/sub subscriber (GCP, AWS SNS, Azure Service Bus)
│   ├── webhook/             # External webhook handler (GitHub, Stripe, Shopify)
│   ├── websocket/           # WebSocket server
│   ├── sse/                 # Server-Sent Events
│   └── worker/              # Background job processor (BullMQ, in-memory)
│
├── nodes/                   # Built-in node implementations (versioned)
│   ├── control-flow/        # if-else@1.0.0
│   └── web/                 # api-call@1.0.0, react@1.0.0
│
├── packages/                # Developer tooling
│   ├── cli/                 # blokctl CLI (create, generate, dev, build, deploy, etc.)
│   ├── vscode-extension/    # VS Code extension (diagnostics, hover, completion)
│   ├── lsp-server/          # Language Server Protocol implementation
│   ├── intellij-plugin/     # JetBrains IDE plugin
│   ├── neovim-plugin/       # Neovim plugin
│   └── syntax/              # TextMate grammar for workflow syntax highlighting
│
├── runtimes/                # Multi-language runtime implementations
│   ├── proto/               # gRPC protocol definition (node.proto)
│   └── python3/             # Python 3 runtime (gRPC server + node SDK)
│
├── sdks/                    # Production-ready SDKs for 6 languages
│   ├── go/                  # Go SDK (server, node, registry, middleware)
│   ├── java/                # Java SDK (Maven, Spring Boot compatible)
│   ├── rust/                # Rust SDK (tonic gRPC, axum HTTP)
│   ├── csharp/              # C#/.NET SDK (ASP.NET, Grpc.Net)
│   ├── php/                 # PHP SDK (PSR-7/PSR-15)
│   └── ruby/                # Ruby SDK (Rack/Sinatra)
│
├── templates/               # Project scaffolding templates
│   ├── node/                # Standard class-based node template
│   ├── node-function/       # Function-first node template (new)
│   ├── node-ui/             # UI node template (React)
│   └── ts-template/         # Basic TypeScript project template
│
├── examples/                # Example implementations
│   ├── workflows/           # 5 workflow JSON examples
│   ├── integrations/        # AWS S3, SendGrid, Stripe examples
│   ├── runtimes/            # Runtime examples in 6 languages (+ Dockerfiles)
│   └── templates/           # Industry templates (e-commerce, fintech, healthcare)
│
├── infra/                   # Infrastructure-as-Code
│   ├── helm/blok/           # Kubernetes Helm chart
│   ├── terraform/           # Terraform modules
│   ├── cloudformation/      # AWS CloudFormation stack
│   ├── arm/                 # Azure ARM templates
│   ├── metrics/             # Prometheus + Grafana + Loki + Tempo
│   ├── development/         # Dev docker-compose (Postgres + Adminer)
│   ├── testing/             # Test docker-compose (full broker stack)
│   ├── edge/                # Edge deployment config
│   └── multi-region/        # Multi-region deployment
│
├── docs/                    # Existing documentation
│   ├── architecture/        # Runtime adapters, trigger system, observability, security
│   ├── compliance/          # SOC2, GDPR, HIPAA, ISO27001, security hardening
│   └── migration/           # Class→function, single→multi-runtime guides
│
├── tests/                   # Top-level integration tests
│   └── integration/sdk-contract/ # Cross-language SDK contract tests
│
├── benchmarks/              # Performance benchmarks (runner, memory)
├── sdk/javascript/          # Browser JavaScript SDK
├── workflows/json/          # Workflow definition files
├── new-version-docs/        # Architecture planning documents
└── documentation/           # THIS folder — documentation roadmap & preparation
```

## How Blok Works — Request Lifecycle

```
1. TRIGGER receives an event
   (HTTP request, queue message, cron tick, webhook, etc.)
         │
         ▼
2. TRIGGER creates a Context object
   (Contains: request data, headers, params, query)
         │
         ▼
3. TRIGGER loads the matching WORKFLOW
   (JSON file that defines the node execution graph)
         │
         ▼
4. RUNNER executes the workflow step by step
   For each step:
   a. Resolve the NODE (from NodeMap registry)
   b. Determine the RUNTIME (Node.js, Python, Docker, etc.)
   c. Map INPUT data (from context/previous nodes)
   d. Execute the node via the RUNTIME ADAPTER
   e. Validate OUTPUT
   f. Store result in CONTEXT (ctx.response, ctx.vars)
   g. Evaluate CONDITIONS (if-else branching)
         │
         ▼
5. RUNNER returns final RESPONSE
   (Sent back through the trigger to the caller)
```

## Key Concepts

| Concept | Definition | Primary File |
|---------|-----------|-------------|
| **Node** | A single-responsibility unit of business logic | `core/runner/src/defineNode.ts` |
| **Workflow** | A JSON graph that connects nodes in sequence | `core/workflow-helper/` |
| **Trigger** | An event source that starts workflow execution | `core/runner/src/TriggerBase.ts` |
| **Context** | The data object that flows through a workflow | `core/shared/src/types/Context.ts` |
| **Runner** | The engine that executes workflows node by node | `core/runner/src/index.ts` |
| **Runtime Adapter** | Plugin that executes nodes in a specific language | `core/runner/src/adapters/` |
| **Runtime Registry** | Registry of all available runtime adapters | `core/runner/src/RuntimeRegistry.ts` |

## Package Dependencies

```
@blok/shared       ← Base types (Context, NodeBase, GlobalError)
       ↑
@blok/runner       ← Core execution engine (depends on shared + helper)
       ↑
@blok/helper       ← Workflow builder DSL (depends on shared)
       ↑
@blok/trigger-http ← HTTP trigger (depends on runner + shared + helper)
       ↑
blokctl (CLI)                ← CLI tooling (depends on runner)
```

## Environment Variables

### Core Runner
| Variable | Description | Default |
|----------|-------------|---------|
| `WORKFLOWS_PATH` | Path to workflow JSON files | `./workflows` |
| `NODES_PATH` | Path to node implementations | `./src/nodes` |
| `CONSOLE_LOG_ACTIVE` | Enable console logging | `true` |
| `NODE_ENV` | Environment (development/production) | `development` |
| `APP_NAME` | Application name for logging | `blok-http` |
| `PORT` | HTTP server port | `4000` |

### Python Runtime
| Variable | Description | Default |
|----------|-------------|---------|
| `RUNTIME_PYTHON3_HOST` | Python gRPC server host | `localhost` |
| `RUNTIME_PYTHON3_PORT` | Python gRPC server port | `50051` |

### Message Brokers (for queue/pubsub triggers)
| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection URL | - |
| `RABBITMQ_URL` | RabbitMQ connection URL | - |
| `NATS_URL` | NATS connection URL | - |
| `KAFKA_BROKERS` | Kafka broker addresses | - |

### Observability
| Variable | Description | Default |
|----------|-------------|---------|
| `PROMETHEUS_ENABLED` | Enable Prometheus metrics | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry collector endpoint | - |
| `SENTRY_DSN` | Sentry error tracking DSN | - |

### Security
| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | JWT signing secret | - |
| `OAUTH_CLIENT_ID` | OAuth client ID | - |
| `OAUTH_CLIENT_SECRET` | OAuth client secret | - |
| `VAULT_ADDR` | HashiCorp Vault address | - |
| `VAULT_TOKEN` | HashiCorp Vault token | - |
| `AWS_REGION` | AWS region for Secrets Manager | - |

## NPM Scripts (Root)

| Script | Command | Description |
|--------|---------|-------------|
| `test` | `nx run-many -t test` | Run all tests across all packages |
| `build` | Complex pipeline | Build CLI + core packages + nodes |
| `http:dev` | Filter trigger-http dev | Start HTTP trigger dev server |
| `runner:dev` | Filter runner build:dev | Build runner in watch mode |
| `runner:test` | Filter runner test:dev | Run runner tests in watch mode |
| `cli:dev` | Filter blokctl build:dev | Build CLI in watch mode |
| `lint` | `biome check --write` | Lint all files |
| `doc:dev` | `npx mintlify dev` | Start docs dev server |

## Technology Stack

| Category | Technology |
|----------|-----------|
| Language | TypeScript (Node.js 18+) |
| Package Manager | pnpm 10+ |
| Monorepo Tool | Nx 20 |
| Build | TypeScript compiler (tsc) |
| Test Runner | Vitest |
| Linter | Biome |
| HTTP Server | Express.js |
| gRPC | @connectrpc/connect, @grpc/grpc-js |
| Schema Validation | Zod |
| Serialization | Protocol Buffers (protobuf) |
| Containerization | Docker |
| Orchestration | Kubernetes (Helm) |
| Monitoring | Prometheus + Grafana |
| Tracing | OpenTelemetry |
| Logging | Grafana Loki |
| CI/CD | GitHub Actions, GitLab CI, CircleCI, Jenkins, Travis CI |
