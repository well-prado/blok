# Blok Documentation Site Map

> Maps every planned documentation page to its source files and module references.
> Use this document as the master checklist when writing each page.

## Legend
- **Page** — The documentation page title
- **URL Path** — Proposed URL slug
- **Source Files** — Codebase files to read when writing this page
- **Module Ref** — Link to module reference document in `documentation/modules/`
- **Deps** — Pages that should be written first (this page references them)

---

## Getting Started

| # | Page | URL Path | Source Files | Module Ref | Deps |
|---|------|----------|-------------|-----------|------|
| 1 | Introduction | `/` | README.md, ROADMAP.md | overview.md | - |
| 2 | Installation | `/getting-started/installation` | package.json, pnpm-workspace.yaml | overview.md | - |
| 3 | Quick Start | `/getting-started/quick-start` | triggers/http/, examples/ | quick-start/SETUP_GUIDE.md | 2 |
| 4 | Project Structure | `/getting-started/project-structure` | All top-level dirs | overview.md | 2 |
| 5 | Configuration | `/getting-started/configuration` | Configuration.ts, .env, docker-compose | core-runner.md | 2 |

## Core Concepts

| # | Page | URL Path | Source Files | Module Ref | Deps |
|---|------|----------|-------------|-----------|------|
| 6 | How Blok Works | `/concepts/how-it-works` | Runner.ts, TriggerBase.ts, index.ts | core-runner.md | 1-5 |
| 7 | Nodes | `/concepts/nodes` | defineNode.ts, BlokService.ts, NodeBase.ts | nodes.md, define-node.md | 6 |
| 8 | Workflows | `/concepts/workflows` | workflow-helper/, examples/workflows/ | workflow-helper.md | 6 |
| 9 | Triggers | `/concepts/triggers` | TriggerBase.ts, triggers/*/ | triggers.md | 6 |
| 10 | Context & Data | `/concepts/context` | Context.ts, Mapper.ts, VarsContext.ts | core-shared.md | 6 |

## Building Nodes

| # | Page | URL Path | Source Files | Module Ref | Deps |
|---|------|----------|-------------|-----------|------|
| 11 | Function-First Nodes | `/nodes/function-first` | defineNode.ts, FUNCTION_FIRST_NODES.md | define-node.md | 7 |
| 12 | Input/Output Schemas | `/nodes/schemas` | defineNode.ts, Zod usage | define-node.md | 11 |
| 13 | Using Context | `/nodes/context` | Context.ts, examples/ | core-shared.md | 10, 11 |
| 14 | Error Handling | `/nodes/errors` | GlobalError.ts, defineNode error mapping | core-shared.md | 11 |
| 15 | Class-Based Nodes | `/nodes/class-based` | BlokService.ts, NodeBase.ts | core-runner.md | 7 |
| 16 | Testing Nodes | `/nodes/testing` | TestHarness.ts, TestLogger.ts | testing.md | 11 |

## Building Workflows

| # | Page | URL Path | Source Files | Module Ref | Deps |
|---|------|----------|-------------|-----------|------|
| 17 | Workflow JSON | `/workflows/json-structure` | examples/workflows/*.json | workflow-helper.md | 8 |
| 18 | Workflow Builder | `/workflows/builder` | workflow-helper/src/ | workflow-helper.md | 8 |
| 19 | Conditional Logic | `/workflows/conditionals` | if-else@1.0.0/, AddIf.ts | nodes.md, workflow-helper.md | 17 |
| 20 | Error Handling | `/workflows/error-handling` | TryCatch types | workflow-helper.md | 17 |
| 21 | Variables & Data | `/workflows/variables` | VarsContext.ts, Mapper.ts | core-shared.md | 10, 17 |
| 22 | Testing Workflows | `/workflows/testing` | WorkflowTestRunner.ts | testing.md | 17 |

## Triggers

| # | Page | URL Path | Source Files | Module Ref | Deps |
|---|------|----------|-------------|-----------|------|
| 23 | Triggers Overview | `/triggers/overview` | TriggerBase.ts, TriggerOpts.ts | triggers.md | 9 |
| 24 | HTTP | `/triggers/http` | triggers/http/ | triggers.md | 23 |
| 25 | gRPC | `/triggers/grpc` | triggers/grpc/ | triggers.md | 23 |
| 26 | Queue | `/triggers/queue` | triggers/queue/, adapters/ | triggers.md | 23 |
| 27 | Pub/Sub | `/triggers/pubsub` | triggers/pubsub/, adapters/ | triggers.md | 23 |
| 28 | Cron | `/triggers/cron` | triggers/cron/ | triggers.md | 23 |
| 29 | Webhooks | `/triggers/webhooks` | triggers/webhook/ | triggers.md | 23 |
| 30 | WebSocket | `/triggers/websocket` | triggers/websocket/ | triggers.md | 23 |
| 31 | SSE | `/triggers/sse` | triggers/sse/ | triggers.md | 23 |
| 32 | Worker | `/triggers/worker` | triggers/worker/, adapters/ | triggers.md | 23 |
| 33 | Custom Triggers | `/triggers/custom` | TriggerBase.ts | triggers.md | 23 |

## Multi-Language Runtimes

| # | Page | URL Path | Source Files | Module Ref | Deps |
|---|------|----------|-------------|-----------|------|
| 34 | Architecture | `/runtimes/architecture` | adapters/, RuntimeRegistry.ts | runtime-adapters.md | 6 |
| 35 | Node.js | `/runtimes/nodejs` | NodeJsRuntimeAdapter.ts | runtime-adapters.md | 34 |
| 36 | Python 3 | `/runtimes/python` | runtimes/python3/, Python3RuntimeAdapter.ts | runtime-adapters.md | 34 |
| 37 | Go SDK | `/runtimes/go` | sdks/go/, examples/runtimes/go/ | sdks.md | 34 |
| 38 | Java SDK | `/runtimes/java` | sdks/java/, examples/runtimes/java/ | sdks.md | 34 |
| 39 | Rust SDK | `/runtimes/rust` | sdks/rust/, examples/runtimes/rust/ | sdks.md | 34 |
| 40 | C# / .NET SDK | `/runtimes/csharp` | sdks/csharp/, examples/runtimes/csharp/ | sdks.md | 34 |
| 41 | PHP SDK | `/runtimes/php` | sdks/php/, examples/runtimes/php/ | sdks.md | 34 |
| 42 | Ruby SDK | `/runtimes/ruby` | sdks/ruby/, examples/runtimes/ruby/ | sdks.md | 34 |
| 43 | Docker Runtime | `/runtimes/docker` | DockerRuntimeAdapter.ts | runtime-adapters.md | 34 |
| 44 | WASM Runtime | `/runtimes/wasm` | WasmRuntimeAdapter.ts | runtime-adapters.md | 34 |
| 45 | Custom Runtime | `/runtimes/custom` | RUNTIME_ADAPTER_EXAMPLE.md | runtime-adapters.md | 34 |

## Security

| # | Page | URL Path | Source Files | Module Ref | Deps |
|---|------|----------|-------------|-----------|------|
| 46 | Overview | `/security/overview` | security/index.ts | security.md | - |
| 47 | Auth Middleware | `/security/auth` | AuthMiddleware.ts | security.md | 46 |
| 48 | OAuth 2.0 | `/security/oauth` | OAuthProvider.ts | security.md | 46 |
| 49 | RBAC | `/security/rbac` | RBAC.ts | security.md | 46 |
| 50 | ABAC | `/security/abac` | ABAC.ts | security.md | 46 |
| 51 | Secrets | `/security/secrets` | SecretManager.ts | security.md | 46 |
| 52 | Encryption | `/security/encryption` | EncryptionAtRest.ts, TLSConfig.ts | security.md | 46 |
| 53 | Audit Logging | `/security/audit` | AuditLogger.ts | security.md | 46 |
| 54 | PII Detection | `/security/pii` | PIIDetector.ts | security.md | 46 |

## Observability

| # | Page | URL Path | Source Files | Module Ref | Deps |
|---|------|----------|-------------|-----------|------|
| 55 | Overview | `/observability/overview` | monitoring/index.ts | observability.md | - |
| 56 | Logging | `/observability/logging` | StructuredLogger.ts | observability.md | 55 |
| 57 | Tracing | `/observability/tracing` | DistributedTracer.ts, TracingBootstrap.ts | observability.md | 55 |
| 58 | Metrics | `/observability/metrics` | PrometheusMetricsBridge.ts | observability.md | 55 |
| 59 | Dashboards | `/observability/dashboards` | infra/metrics/dashboards/ | observability.md | 58 |
| 60 | APM | `/observability/apm` | APMIntegration.ts | observability.md | 55 |
| 61 | Sentry | `/observability/sentry` | SentryIntegration.ts | observability.md | 55 |
| 62 | CloudWatch | `/observability/cloudwatch` | CloudWatchIntegration.ts | observability.md | 55 |
| 63 | Azure Monitor | `/observability/azure-monitor` | AzureMonitorIntegration.ts | observability.md | 55 |
| 64 | Health Checks | `/observability/health` | HealthCheck.ts | observability.md | 55 |
| 65 | Circuit Breakers | `/observability/circuit-breakers` | CircuitBreaker.ts | observability.md | 55 |
| 66 | Rate Limiting | `/observability/rate-limiting` | RateLimiter.ts | observability.md | 55 |

## Testing

| # | Page | URL Path | Source Files | Module Ref | Deps |
|---|------|----------|-------------|-----------|------|
| 67 | Overview | `/testing/overview` | testing/index.ts | testing.md | - |
| 68 | Test Harness | `/testing/harness` | TestHarness.ts, WorkflowTestRunner.ts | testing.md | 67 |
| 69 | Integration Tests | `/testing/integration` | __tests__/integration/, docker-compose | testing.md | 67 |
| 70 | Contract Tests | `/testing/contracts` | tests/integration/sdk-contract/ | testing.md | 67 |

## CLI Reference

| # | Page | URL Path | Source Files | Module Ref | Deps |
|---|------|----------|-------------|-----------|------|
| 71 | CLI Overview | `/cli/overview` | packages/cli/src/index.ts | cli.md | - |
| 72 | AI Generation | `/cli/generate` | commands/generate/ | cli.md | 71 |

## IDE Integration

| # | Page | URL Path | Source Files | Module Ref | Deps |
|---|------|----------|-------------|-----------|------|
| 73 | VS Code | `/ide/vscode` | packages/vscode-extension/ | ide.md | - |
| 74 | IntelliJ | `/ide/intellij` | packages/intellij-plugin/ | ide.md | - |
| 75 | Neovim | `/ide/neovim` | packages/neovim-plugin/ | ide.md | - |

## Deployment

| # | Page | URL Path | Source Files | Module Ref | Deps |
|---|------|----------|-------------|-----------|------|
| 76 | Docker | `/deployment/docker` | dockerfiles/, docker-compose | deployment.md | - |
| 77 | Kubernetes | `/deployment/kubernetes` | infra/helm/ | deployment.md | 76 |
| 78 | Terraform | `/deployment/terraform` | infra/terraform/ | deployment.md | - |

## Advanced

| # | Page | URL Path | Source Files | Module Ref | Deps |
|---|------|----------|-------------|-----------|------|
| 79 | HMR | `/advanced/hmr` | hmr/ | advanced.md | - |
| 80 | Caching | `/advanced/caching` | cache/ | advanced.md | - |

---

**Total: 80 documentation pages**
**Priority Order: Pages 1-24 first (Getting Started + Core + Nodes + Workflows + HTTP Trigger)**
