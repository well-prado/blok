# Blok Documentation Roadmap

> **Goal:** Build world-class, Laravel/Next.js-quality documentation that is human-friendly, AI-retrievable, and comprehensive enough to onboard any developer from zero to production in under 30 minutes.

## Design Principles

### 1. Human-First Writing
- Every page starts with a plain-English explanation of **what** and **why** before diving into **how**
- Use progressive disclosure: simple concepts first, advanced details later
- Include real-world analogies where they help understanding
- Keep paragraphs short (3-4 sentences max)
- Use headings as scannable questions ("How do I create a node?")

### 2. AI-Friendly Structure
- Every page has a clear `title`, `description`, and `keywords` frontmatter
- Use consistent heading hierarchy (H1 = page title, H2 = sections, H3 = subsections)
- Code blocks always include language identifiers and file paths
- API signatures are in structured, parseable formats
- Cross-references use explicit paths, not ambiguous text

### 3. Code-First Examples
- Every concept includes a runnable code example within the first scroll
- Examples progress from minimal to production-ready
- All examples are tested and verified against the current codebase
- Include both TypeScript and JSON examples where applicable

### 4. Inspired By The Best
- **Laravel**: Clear navigation, progressive complexity, consistent voice, real-world examples
- **Next.js**: Interactive code blocks, file-tree visualizations, tabbed examples (App Router / Pages Router style)
- **Stripe**: API reference with inline examples, copy-paste ready snippets
- **Tailwind CSS**: Searchability, utility-first organization, quick wins early

---

## Documentation Site Architecture

### Technology Stack (Recommended)
- **Framework**: Mintlify (already referenced in existing docs) or Nextra/Fumadocs
- **Search**: Algolia DocSearch or built-in full-text search
- **Code Blocks**: Syntax-highlighted with copy buttons, file path labels
- **Versioning**: Git-based versioning tied to releases
- **API Reference**: Auto-generated from TypeDoc + custom pages

### Navigation Structure

```
docs/
├── Getting Started/
│   ├── Introduction
│   ├── Installation
│   ├── Quick Start (5-minute guide)
│   ├── Project Structure
│   └── Configuration
│
├── Core Concepts/
│   ├── How Blok Works
│   ├── Nodes
│   ├── Workflows
│   ├── Triggers
│   ├── Context & Data Flow
│   └── The Runner
│
├── Building Nodes/
│   ├── Function-First Nodes (defineNode)
│   ├── Input & Output Schemas (Zod)
│   ├── Using Context
│   ├── Error Handling
│   ├── Class-Based Nodes (Legacy)
│   └── Testing Nodes
│
├── Building Workflows/
│   ├── Workflow JSON Structure
│   ├── Workflow Builder (TypeScript DSL)
│   ├── Conditional Logic
│   ├── Error Handling & Try-Catch
│   ├── Variables & Data Passing
│   └── Testing Workflows
│
├── Triggers/
│   ├── Overview
│   ├── HTTP
│   ├── gRPC
│   ├── Queue (Kafka, RabbitMQ, SQS, Redis)
│   ├── Pub/Sub (GCP, AWS SNS, Azure Service Bus)
│   ├── Cron / Scheduled
│   ├── Webhooks (GitHub, Stripe, Shopify)
│   ├── WebSocket
│   ├── SSE (Server-Sent Events)
│   ├── Worker (Background Jobs)
│   └── Building Custom Triggers
│
├── Multi-Language Runtimes/
│   ├── Architecture Overview
│   ├── Runtime Adapters
│   ├── Node.js Runtime
│   ├── Python 3 Runtime
│   ├── Go SDK
│   ├── Java SDK
│   ├── Rust SDK
│   ├── C# / .NET SDK
│   ├── PHP SDK
│   ├── Ruby SDK
│   ├── Docker Runtime
│   ├── WASM Runtime
│   └── Building a Custom Runtime
│
├── AI Code Generation/
│   ├── Overview
│   ├── Generating Nodes
│   ├── Generating Workflows
│   ├── Generating Triggers
│   ├── Generating Runtime Adapters
│   └── Prompt Engineering
│
├── Security/
│   ├── Overview
│   ├── Authentication Middleware
│   ├── OAuth 2.0 / OIDC
│   ├── RBAC (Role-Based Access Control)
│   ├── ABAC (Attribute-Based Access Control)
│   ├── Secret Management
│   ├── Encryption (At Rest & In Transit)
│   ├── TLS Configuration
│   ├── Audit Logging
│   └── PII Detection & Masking
│
├── Observability/
│   ├── Overview
│   ├── Structured Logging
│   ├── Distributed Tracing (OpenTelemetry)
│   ├── Prometheus Metrics
│   ├── Grafana Dashboards
│   ├── APM Integration (DataDog, New Relic)
│   ├── Error Tracking (Sentry)
│   ├── Cloud Monitoring (CloudWatch, Azure Monitor)
│   ├── Health Checks
│   ├── Circuit Breakers
│   └── Rate Limiting
│
├── Testing/
│   ├── Overview
│   ├── Testing Nodes
│   ├── Testing Workflows
│   ├── Test Harness API
│   ├── Integration Testing
│   ├── SDK Contract Tests
│   └── Performance Testing
│
├── CLI Reference/
│   ├── Overview
│   ├── blokctl create
│   ├── blokctl generate (AI)
│   ├── blokctl dev
│   ├── blokctl build
│   ├── blokctl deploy
│   ├── blokctl migrate
│   ├── blokctl monitor
│   ├── blokctl profile
│   ├── blokctl graph
│   ├── blokctl cost
│   └── blokctl marketplace
│
├── IDE Integration/
│   ├── VS Code Extension
│   ├── IntelliJ Plugin
│   ├── Neovim Plugin
│   └── LSP Server
│
├── Deployment/
│   ├── Docker
│   ├── Docker Compose
│   ├── Kubernetes (Helm Charts)
│   ├── Terraform
│   ├── AWS (CloudFormation)
│   ├── Azure (ARM Templates)
│   ├── Edge Deployment
│   └── Multi-Region
│
├── Blok Studio/
│   ├── Overview & Quick Start
│   ├── Dashboard & Navigation
│   ├── Workflow Runs & Trace Inspector
│   ├── Trace Graph & Timeline
│   ├── Run Diff & Comparison
│   ├── Metrics & Performance Analytics
│   ├── Custom Dashboards
│   ├── Webhooks & Notifications
│   ├── Command Palette & Keyboard Shortcuts
│   └── Extending the Studio
│
├── Advanced/
│   ├── Hot Module Replacement
│   ├── Node Result Caching
│   ├── Cost Estimation
│   ├── GraphQL Schema Generation
│   ├── OpenAPI Generation
│   ├── Workflow Visualization
│   ├── Performance Profiling
│   └── Runtime Marketplace
│
├── Migration Guides/
│   ├── Class to Function-First Nodes
│   └── Single to Multi-Runtime
│
├── Compliance/
│   ├── SOC 2
│   ├── GDPR
│   ├── HIPAA
│   ├── ISO 27001
│   └── Security Hardening
│
├── API Reference/
│   ├── Core Runner
│   ├── Shared Types
│   ├── Workflow Helper
│   ├── Trigger Types
│   ├── defineNode API
│   ├── Context API
│   ├── Security API
│   └── Monitoring API
│
└── Examples & Recipes/
    ├── Hello World
    ├── REST API with Authentication
    ├── E-commerce Checkout Flow
    ├── User Registration with Email
    ├── Data Pipeline
    ├── Scheduled Reports
    ├── Webhook Processor
    ├── Multi-Language Workflow
    ├── Real-time Chat (WebSocket)
    └── Event-Driven Microservices
```

---

## Phased Implementation Plan

### Phase 1: Foundation (Must-Have for Launch)
**Goal:** Enable any developer to install, create a project, build a node, define a workflow, and run it locally.

| # | Page | Priority | Source Files | Status |
|---|------|----------|-------------|--------|
| 1.1 | Introduction | P0 | README.md, ROADMAP.md | - [ ] |
| 1.2 | Installation | P0 | package.json, pnpm-workspace.yaml, Makefile | - [ ] |
| 1.3 | Quick Start (5-min) | P0 | triggers/http/, core/runner/, examples/ | - [ ] |
| 1.4 | Project Structure | P0 | Full codebase analysis | - [ ] |
| 1.5 | Configuration | P0 | Configuration.ts, .env files, docker-compose | - [ ] |
| 1.6 | How Blok Works | P0 | core/runner/src/index.ts, TriggerBase.ts | - [ ] |
| 1.7 | Nodes | P0 | defineNode.ts, BlokService.ts, NodeBase.ts | - [ ] | **NOTE:** All 28 TS nodes now use `defineNode()`. Document function-first as the standard, class-based as legacy. |
| 1.8 | Workflows | P0 | workflow-helper/, examples/workflows/ | - [ ] |
| 1.9 | Triggers Overview | P0 | triggers/http/, TriggerBase.ts | - [ ] |
| 1.10 | Context & Data Flow | P0 | core/shared/src/types/Context.ts | - [ ] |

> **CRITICAL LEARNINGS for page 1.10 (Context & Data Flow):**
>
> 1. **ctx.vars vs ctx.response.data** — `ctx.response.data` only holds the PREVIOUS node's output and gets overwritten each step (`RunnerSteps.ts` line 33: `ctx.response = model.data`). For cross-step data persistence, always use `ctx.vars`.
> 2. **ctx.vars pattern** — Each step can store output in `ctx.vars[stepName]`. Downstream steps read via `js/ctx.vars['prevStep'].fieldName` expressions in workflow JSON inputs. RuntimeAdapterNode auto-saves `result.data` to `ctx.vars[this.name]`.
> 3. **set_var / ctx.vars lifecycle** — `ctx.vars` is an object that persists throughout the entire workflow execution. Any node can read/write to it. The Mapper (blueprintMapper) resolves `js/` expressions before each node executes.
> 4. **Data flow between runtime adapters** — HttpRuntimeAdapter sends resolved inputs (from config) as the request body. Python3RuntimeAdapter sends resolved inputs as `request.body` in gRPC context. Both extract `result.data` and store it in `ctx.vars[stepName]`.
> 5. **ctx.request.body** — Contains the original HTTP request body for the first node. For runtime adapter nodes, `request.body` may contain resolved inputs from the Mapper, not the original HTTP body.
> 6. **ctx.config[nodeName]** — The workflow JSON `nodes` section maps to `ctx.config`. Each node's `inputs` are resolved by the Mapper before `handle()` is called.
| 1.11 | Function-First Nodes | P0 | defineNode.ts, FUNCTION_FIRST_NODES.md | - [ ] | **NOTE:** Migration complete. All nodes use `defineNode()` with Zod schemas. `contentType` support added. CLI templates default to function-first. |
| 1.12 | Input/Output Schemas | P0 | Zod schemas, StepOpts.ts | - [ ] |
| 1.13 | HTTP Trigger | P0 | triggers/http/ | - [ ] |
| 1.14 | CLI: create | P0 | packages/cli/src/commands/create/ | - [ ] |
| 1.15 | CLI: dev | P0 | packages/cli/src/commands/dev/ | - [ ] |
| 1.16 | Docker Setup | P0 | dockerfiles/, docker-compose files | - [ ] |
| 1.17 | Hello World Example | P0 | Custom (new) | - [ ] |
| 1.18 | REST API Example | P0 | examples/workflows/ | - [ ] |

### Phase 2: Trigger System (All trigger docs)
**Goal:** Document every trigger type with configuration, examples, and deployment instructions.

| # | Page | Priority | Source Files | Status |
|---|------|----------|-------------|--------|
| 2.1 | gRPC Trigger | P1 | triggers/grpc/ | - [ ] |
| 2.2 | Queue Triggers | P1 | triggers/queue/ + 4 adapters | - [ ] |
| 2.3 | Pub/Sub Triggers | P1 | triggers/pubsub/ + 3 adapters | - [ ] |
| 2.4 | Cron Triggers | P1 | triggers/cron/ | - [ ] |
| 2.5 | Webhook Triggers | P1 | triggers/webhook/ | - [ ] |
| 2.6 | WebSocket Trigger | P1 | triggers/websocket/ | - [ ] |
| 2.7 | SSE Trigger | P1 | triggers/sse/ (SSETrigger abstract base + SSEServer concrete trigger + runner infrastructure) | - [ ] |
| 2.8 | Worker Trigger | P1 | triggers/worker/ + 2 adapters | - [ ] |
| 2.9 | Building Custom Triggers | P1 | TriggerBase.ts | - [ ] |

### Phase 3: Multi-Language Runtimes
**Goal:** Full documentation for every language SDK and runtime adapter.

> **KEY LEARNINGS for Phase 3 (Runtime Documentation):**
>
> **3 Adapter Types with different protocols:**
> - **NodeJsRuntimeAdapter** — In-process execution, no serialization
> - **Python3RuntimeAdapter** — gRPC (base64-encoded JSON), sends resolved inputs as `request.body` in context, passes `config.inputs` to Python BlokService `handle()`, extracts `parsedResponse.data`
> - **HttpRuntimeAdapter** — HTTP POST to `/execute` (Go, Rust, Java, C#, PHP, Ruby), sends resolved inputs from `ctx.config[node.name].inputs` as request body, returns `ExecutionResult` with vars support
>
> **Workflow type mapping:**
> - `"type": "module"` → NodeJS in-process
> - `"type": "runtime.python3"` → Python3 gRPC adapter
> - `"type": "runtime.go"` → HttpRuntimeAdapter (Go SDK container)
> - Same pattern for `runtime.rust`, `runtime.java`, `runtime.csharp`, `runtime.php`, `runtime.ruby`
>
> **RuntimeAdapterNode behavior:**
> - Acts as bridge between RuntimeAdapter and RunnerNode
> - Auto-saves `result.data` to `ctx.vars[this.name]` after each execution
> - Merges SDK-returned `result.vars` into `ctx.vars` if present
>
> **Environment variables per runtime:**
> - `RUNTIME_{LANG}_HOST` (default: `localhost`)
> - `RUNTIME_{LANG}_PORT` (Go=9001, Rust=9002, Java=9003, C#=9004, PHP=9005, Ruby=9006)
>
> **SDK ExecutionResult contract (all SDKs must return):**
> ```json
> { "success": true, "data": {...}, "errors": null, "vars": {...}, "logs": [], "metrics": { "duration_ms": 5 } }
> ```

| # | Page | Priority | Source Files | Status |
|---|------|----------|-------------|--------|
| 3.1 | Runtime Architecture | P1 | adapters/, RuntimeRegistry.ts | - [ ] |
| 3.2 | Node.js Runtime | P1 | NodeJsRuntimeAdapter.ts | - [ ] |
| 3.3 | Python 3 Runtime | P1 | runtimes/python3/, Python3RuntimeAdapter.ts | - [ ] |
| 3.4 | Go SDK | P1 | sdks/go/, examples/runtimes/go/ | - [ ] |
| 3.5 | Java SDK | P1 | sdks/java/, examples/runtimes/java/ | - [ ] |
| 3.6 | Rust SDK | P1 | sdks/rust/, examples/runtimes/rust/ | - [ ] |
| 3.7 | C# / .NET SDK | P1 | sdks/csharp/, examples/runtimes/csharp/ | - [ ] |
| 3.8 | PHP SDK | P2 | sdks/php/, examples/runtimes/php/ | - [ ] |
| 3.9 | Ruby SDK | P2 | sdks/ruby/, examples/runtimes/ruby/ | - [ ] |
| 3.10 | Docker Runtime | P1 | DockerRuntimeAdapter.ts | - [ ] |
| 3.11 | WASM Runtime | P2 | WasmRuntimeAdapter.ts | - [ ] |
| 3.12 | Building Custom Runtimes | P1 | RUNTIME_ADAPTER_EXAMPLE.md | - [ ] |

### Phase 4: Security & Enterprise
**Goal:** Document all security features for enterprise adoption.

| # | Page | Priority | Source Files | Status |
|---|------|----------|-------------|--------|
| 4.1 | Security Overview | P1 | security/index.ts | - [ ] |
| 4.2 | Auth Middleware | P1 | AuthMiddleware.ts | - [ ] |
| 4.3 | OAuth 2.0 / OIDC | P1 | OAuthProvider.ts | - [ ] |
| 4.4 | RBAC | P1 | RBAC.ts | - [ ] |
| 4.5 | ABAC | P1 | ABAC.ts | - [ ] |
| 4.6 | Secret Management | P1 | SecretManager.ts | - [ ] |
| 4.7 | Encryption | P2 | EncryptionAtRest.ts, TLSConfig.ts | - [ ] |
| 4.8 | Audit Logging | P2 | AuditLogger.ts | - [ ] |
| 4.9 | PII Detection | P2 | PIIDetector.ts | - [ ] |

### Phase 5: Observability & Operations
**Goal:** Document monitoring, logging, tracing, and operational tooling.

| # | Page | Priority | Source Files | Status |
|---|------|----------|-------------|--------|
| 5.1 | Observability Overview | P1 | monitoring/index.ts | - [ ] |
| 5.2 | Structured Logging | P1 | StructuredLogger.ts | - [ ] |
| 5.3 | Distributed Tracing | P1 | DistributedTracer.ts, TracingBootstrap.ts | - [ ] |
| 5.4 | Prometheus Metrics | P1 | PrometheusMetricsBridge.ts, PrometheusBootstrap.ts | - [ ] |
| 5.5 | Grafana Dashboards | P1 | infra/metrics/dashboards/ | - [ ] |
| 5.6 | APM Integration | P2 | APMIntegration.ts | - [ ] |
| 5.7 | Sentry Integration | P2 | SentryIntegration.ts | - [ ] |
| 5.8 | CloudWatch | P2 | CloudWatchIntegration.ts | - [ ] |
| 5.9 | Azure Monitor | P2 | AzureMonitorIntegration.ts | - [ ] |
| 5.10 | Health Checks | P1 | HealthCheck.ts | - [ ] |
| 5.11 | Circuit Breakers | P1 | CircuitBreaker.ts | - [ ] |
| 5.12 | Rate Limiting | P1 | RateLimiter.ts | - [ ] |

### Phase 6: Testing, CLI, IDE & Deployment
**Goal:** Complete reference documentation for all tooling and deployment options.

| # | Page | Priority | Source Files | Status |
|---|------|----------|-------------|--------|
| 6.1 | Testing Overview | P1 | testing/index.ts | - [ ] |
| 6.2 | Test Harness | P1 | TestHarness.ts, WorkflowTestRunner.ts | - [ ] |
| 6.3 | Full CLI Reference | P1 | packages/cli/src/ | - [ ] |
| 6.4 | VS Code Extension | P1 | packages/vscode-extension/ | - [ ] |
| 6.5 | Docker Compose (Dev) | P1 | infra/development/ | - [ ] |
| 6.6 | Docker Compose (Prod) | P1 | infra/docker-compose.production.yml | - [ ] |
| 6.7 | Kubernetes / Helm | P2 | infra/helm/ | - [ ] |
| 6.8 | Terraform | P2 | infra/terraform/ | - [ ] |
| 6.9 | AI Code Generation | P1 | packages/cli/src/commands/generate/ | - [ ] |
| 6.10 | Migration Guides | P1 | docs/migration/ | - [ ] |

### Phase 7: Blok Studio (Trace UI)
**Goal:** Document the built-in real-time workflow trace UI for developers.

| # | Page | Priority | Source Files | Status |
|---|------|----------|-------------|--------|
| 7.1 | Studio Overview & Quick Start | P1 | apps/studio/, vite.config.ts | - [ ] |
| 7.2 | Dashboard & Navigation | P1 | routes/index.tsx, components/layout/ | - [ ] |
| 7.3 | Workflow Runs & Trace Inspector | P1 | routes/runs/, components/runs/ | - [ ] |
| 7.4 | Trace Graph & Timeline | P1 | components/trace/TraceGraph.tsx, TraceTimeline.tsx | - [ ] |
| 7.5 | Run Diff & Comparison | P1 | routes/runs/diff.tsx, components/trace/DiffView.tsx | - [ ] |
| 7.6 | Metrics & Performance Analytics | P1 | routes/metrics.tsx, components/metrics/ | - [ ] |
| 7.7 | Custom Dashboards | P1 | routes/dashboards.tsx, components/dashboard/ | - [ ] |
| 7.8 | Webhooks & Notifications | P2 | routes/webhooks.tsx, components/shared/NotificationToast.tsx | - [ ] |
| 7.9 | Command Palette & Keyboard Shortcuts | P2 | components/shared/CommandPalette.tsx | - [ ] |
| 7.10 | Extending the Studio | P2 | lib/api.ts, lib/sse.ts, types.ts | - [ ] |

> **NOTE:** The Studio is a complete React 19 SPA with 70 frontend tests. It connects to the runner's trace API (`/__blok/*`) via Vite proxy and provides real-time observability via SSE. Run with `pnpm --filter @blok/studio run dev` on `localhost:5555`.

### Phase 8: Advanced Topics & Examples
**Goal:** Deep-dive content and real-world recipes.

| # | Page | Priority | Source Files | Status |
|---|------|----------|-------------|--------|
| 8.1 | HMR / Hot Reload | P2 | hmr/ | - [ ] |
| 8.2 | Node Result Caching | P2 | cache/NodeResultCache.ts | - [ ] |
| 8.3 | Cost Estimation | P2 | cost/CostEstimator.ts | - [ ] |
| 8.4 | GraphQL Generation | P2 | graphql/GraphQLSchemaGenerator.ts | - [ ] |
| 8.5 | OpenAPI Generation | P2 | openapi/OpenAPIGenerator.ts | - [ ] |
| 8.6 | Workflow Visualization | P2 | visualization/ | - [ ] |
| 8.7 | Performance Profiling | P2 | monitoring/PerformanceProfiler.ts | - [ ] |
| 8.8 | Compliance Guides | P2 | docs/compliance/ | - [ ] |
| 8.9 | E-commerce Example | P2 | examples/templates/ecommerce/ | - [ ] |
| 8.10 | Event-Driven Example | P2 | examples/workflows/ | - [ ] |

---

## Total Page Count

| Phase | Pages | Priority |
|-------|-------|----------|
| Phase 1: Foundation | 18 | P0 (launch-blocking) |
| Phase 2: Triggers | 9 | P1 |
| Phase 3: Runtimes | 12 | P1/P2 |
| Phase 4: Security | 9 | P1/P2 |
| Phase 5: Observability | 12 | P1/P2 |
| Phase 6: Tools & Deploy | 10 | P1/P2 |
| Phase 7: Blok Studio | 10 | P1/P2 |
| Phase 8: Advanced | 10 | P2 |
| **Total** | **90 pages** | |

---

## Quality Standards

### Every Documentation Page Must Include

1. **Frontmatter** with title, description, keywords, category
2. **Introduction paragraph** (2-3 sentences, what and why)
3. **Prerequisites** section (if applicable)
4. **Quick example** (code within first screen)
5. **Detailed explanation** with step-by-step instructions
6. **Configuration reference** (all options documented)
7. **Common patterns / recipes**
8. **Troubleshooting** section (common errors and fixes)
9. **Related pages** (links to next logical reading)
10. **API reference** (for code-heavy pages)

### Code Example Standards

```
[language] [filepath (if applicable)]
// Comment explaining what this does
actual code here
```

- Every code block must be copy-pasteable and runnable
- Include file paths when showing file contents
- Show both minimal and production-ready versions
- Include expected output where helpful

### Writing Style Guide

- **Voice**: Second person ("you"), active voice ("Create a node" not "A node is created")
- **Tone**: Professional but friendly, like a knowledgeable colleague
- **Length**: Each page 800-2000 words (not counting code)
- **Headings**: Question-style or action-style ("How to create a node", "Creating your first workflow")
- **Lists**: Use for 3+ items, numbered for sequences, bullets for collections
- **Callouts**: Use Note/Warning/Tip boxes sparingly but effectively

---

## Documentation Infrastructure

### Search & Discovery
- Full-text search across all pages
- Code search within examples
- Tag-based filtering (trigger type, language, difficulty)
- "Related pages" suggestions

### Versioning Strategy
- Documentation versioned alongside releases
- "Latest" always points to current stable
- Previous versions accessible via dropdown
- Migration guides between versions

### Feedback System
- "Was this helpful?" on every page
- "Edit this page" links to GitHub
- Issue template for doc improvements
- Community discussion threads per section

### AI Integration
- Structured data for RAG retrieval
- Consistent naming conventions across all pages
- Machine-readable API reference (JSON/YAML)
- Embeddings-ready content structure

---

## Key Source Files for Each Section

### Getting Started Sources
| File | What to Document |
|------|-----------------|
| `package.json` (root) | Available scripts, dependencies |
| `pnpm-workspace.yaml` | Monorepo structure |
| `Makefile` | Development commands |
| `dockerfiles/Dockerfile.deploy.http` | Container setup |
| `infra/development/docker-compose.yml` | Dev environment |
| `infra/docker-compose.production.yml` | Production stack |
| `triggers/http/package.json` | HTTP trigger entry point |

### Core Concepts Sources
| File | What to Document |
|------|-----------------|
| `core/runner/src/index.ts` | Runner exports, main API |
| `core/runner/src/defineNode.ts` | Function-first node API |
| `core/runner/src/TriggerBase.ts` | Trigger architecture |
| `core/runner/src/RuntimeRegistry.ts` | Runtime system |
| `core/runner/src/Configuration.ts` | Configuration model |
| `core/shared/src/types/Context.ts` | Context type definition |
| `core/shared/src/NodeBase.ts` | Node base class |
| `core/workflow-helper/src/index.ts` | Workflow builder API |
| `core/workflow-helper/src/types/` | Workflow/trigger/step types |
| `core/runner/src/RunnerSteps.ts` | Step execution flow, ctx.response overwrite behavior |
| `core/runner/src/RuntimeAdapterNode.ts` | Runtime adapter bridge, ctx.vars auto-save |
| `core/shared/src/NodeBase.ts` | blueprintMapper, js/ expression resolution |

### Runtime Sources
| File | What to Document |
|------|-----------------|
| `core/runner/src/adapters/RuntimeAdapter.ts` | Adapter interface |
| `core/runner/src/adapters/NodeJsRuntimeAdapter.ts` | Node.js adapter |
| `core/runner/src/adapters/Python3RuntimeAdapter.ts` | Python adapter |
| `core/runner/src/adapters/DockerRuntimeAdapter.ts` | Docker adapter |
| `core/runner/src/adapters/BunRuntimeAdapter.ts` | Bun adapter |
| `core/runner/src/adapters/HttpRuntimeAdapter.ts` | HTTP adapter (Go, Rust, Java, C#, PHP, Ruby) |
| `core/runner/src/adapters/WasmRuntimeAdapter.ts` | WASM adapter |
| `core/runner/src/RuntimeAdapterNode.ts` | Bridge between RuntimeAdapter and RunnerNode, ctx.vars auto-save |
| `sdks/go/` | Go SDK reference |
| `sdks/java/` | Java SDK reference |
| `sdks/rust/` | Rust SDK reference |
| `sdks/csharp/` | C# SDK reference |
| `sdks/php/` | PHP SDK reference |
| `sdks/ruby/` | Ruby SDK reference |
| `runtimes/python3/` | Python runtime |
| `runtimes/proto/node.proto` | gRPC protocol definition |

### Blok Studio Sources
| File | What to Document |
|------|-----------------|
| `apps/studio/package.json` | Studio dependencies, scripts (`dev`, `build`, `test`) |
| `apps/studio/vite.config.ts` | Dev server port (5555), API proxy to backend (4000) |
| `apps/studio/vitest.config.ts` | Test configuration (jsdom, path aliases) |
| `apps/studio/src/main.tsx` | React entry point, TanStack Router setup |
| `apps/studio/src/routes/` | All page routes (dashboard, runs, metrics, webhooks, etc.) |
| `apps/studio/src/lib/api.ts` | REST API client, `fetchJson` helper, `ApiError` class |
| `apps/studio/src/lib/sse.ts` | SSE client for real-time run/global event streams |
| `apps/studio/src/lib/formatters.ts` | Duration, bytes, time, percent formatting utilities |
| `apps/studio/src/lib/constants.ts` | Status colors, labels, event type mappings |
| `apps/studio/src/stores/connection.ts` | Zustand store for SSE connection state |
| `apps/studio/src/stores/notifications.ts` | Zustand store for notification management |
| `apps/studio/src/components/trace/TraceGraph.tsx` | @xyflow/react workflow trace graph |
| `apps/studio/src/components/trace/TraceTimeline.tsx` | Timeline view of node executions |
| `apps/studio/src/components/trace/DiffView.tsx` | Side-by-side run comparison |
| `apps/studio/src/components/metrics/` | Recharts-based metrics visualizations |
| `apps/studio/src/components/dashboard/` | Custom dashboard grid, widgets, live feed |
| `apps/studio/src/components/shared/CommandPalette.tsx` | Cmd+K global search |
| `apps/studio/src/components/shared/ErrorBoundary.tsx` | Error boundary with retry |
| `apps/studio/src/components/shared/JsonViewer.tsx` | Collapsible JSON tree viewer |
| `apps/studio/src/types.ts` | All TypeScript types (runs, workflows, metrics, events) |
| `apps/studio/src/__tests__/` | 70 frontend tests (formatters, API, stores, components) |
| `core/runner/src/tracing/` | Backend trace collection and API endpoints |

### SSE Trigger Sources
| File | What to Document |
|------|-----------------|
| `triggers/sse/src/SSETrigger.ts` | Abstract base class (860 lines): connection management, channels, broadcasting, heartbeat, event history/replay, workflow triggering on connect/disconnect/subscribe/unsubscribe |
| `triggers/sse/src/runner/SSEServer.ts` | Concrete trigger: Hono HTTP server, SSE stream endpoints, REST management APIs, Blok Studio integration, Prometheus metrics |
| `triggers/sse/src/index.ts` | App entry point: GlobalOptions, App class instantiation, HMR support (mirrors HTTP trigger pattern) |
| `triggers/sse/src/lib.ts` | Library exports: SSETrigger class + types for package consumers (`@blok/trigger-sse`) |
| `triggers/sse/src/AppRoutes.ts` | Custom Hono routes: welcome page with SSE usage instructions |
| `triggers/sse/src/Nodes.ts` | Node registry: `@blok/api-call`, `@blok/if-else`, `welcome-message` |
| `triggers/sse/src/Workflows.ts` | Workflow registry: imports on-connect, on-subscribe workflows |
| `triggers/sse/src/workflows/notifications/on-connect.ts` | Example workflow: triggered on SSE connect, sends welcome message |
| `triggers/sse/src/workflows/notifications/on-subscribe.ts` | Example workflow: triggered on channel subscribe |
| `triggers/sse/src/nodes/welcome-message/index.ts` | Example node: `defineNode()` pattern, sends SSE event via `ctx.vars._sse_send` |
| `triggers/sse/src/runner/HonoTraceRouterAdapter.ts` | Blok Studio bridge: adapts TraceRouter interface to Hono routes (`/__blok/*`) |
| `triggers/sse/src/runner/metrics/opentelemetry_metrics.ts` | Prometheus metrics handler for `/metrics` endpoint |
| `triggers/sse/src/runner/metrics/opentelemetry_traces.ts` | OpenTelemetry trace setup for distributed tracing |
| `triggers/sse/src/runner/types/Workflows.ts` | Type definition: `Record<string, HelperResponse>` |
| `triggers/sse/src/runner/types/NodeTypes.ts` | Enum of node types (module, runtime.*) |
| `triggers/sse/Dockerfile` | Production container: bun runtime, port 4001, preloads metrics |
| `triggers/sse/Dockerfile.dev` | Development container: node 23-alpine, port 4001, watch mode |
| `triggers/sse/.env.example` | Environment template: PORT=4001, APP_NAME=blok-sse, BLOK_TRACE_ENABLED |
| `triggers/sse/vitest.config.ts` | Test configuration: 90% coverage thresholds, Istanbul provider |
| `packages/cli/src/commands/create/project.ts` | CLI integration: SSE option in trigger selection, trigger-aware port assignment |

> **KEY LEARNINGS for Phase 2.7 (SSE Trigger Documentation):**
>
> **SSE Trigger Architecture (two-layer design):**
> - `SSETrigger` (abstract) handles all SSE protocol logic: connection lifecycle, channels, broadcasting, heartbeat, event history with replay (Last-Event-ID), metadata
> - `SSEServer` (concrete) adds the HTTP layer: Hono server, REST endpoints, Blok Studio, metrics — developers extend this pattern for custom SSE servers
> - Library vs App separation: `lib.ts` exports the abstract class for package consumers; `index.ts` is the runnable App entry point
>
> **SSE Context Data (critical for workflow docs):**
> - `ctx.vars._sse` — `{ clientId, eventType, channel, clientChannels, clientMetadata, timestamp }` — available in all SSE-triggered workflows
> - `ctx.vars._sse_send` — function `(event: string, data: unknown) => void` to send SSE event to the triggering client
> - `ctx.vars._sse_broadcast` — function `(channel: string, event: string, data: unknown) => void` to broadcast to a channel
> - Workflows use `.addTrigger("sse", { events: ["connect"] })` — but `TriggerOpts` only types HTTP fields, so `as any` cast needed until Phase 3.1
>
> **REST Management Endpoints (port 4001):**
> - `GET /events/:channel` — opens SSE stream, subscribes to channel, triggers on-connect + on-subscribe workflows
> - `POST /events/:channel/publish` — publish `{ event, data }` to all clients on a channel
> - `POST /events/broadcast` — broadcast `{ event, data, channel? }` to all or specific channel
> - `GET /clients` — returns `{ activeConnections, totalConnections, uptime, channels }`
> - `GET /channels` — lists active channels with subscriber counts
>
> **Differences from HTTP Trigger:**
> - Port 4001 (HTTP uses 4000)
> - Long-lived connections (vs request-response)
> - Channel-based pub/sub (vs route-based)
> - Workflow triggers on connection events, not HTTP methods
> - SSE-specific context vars (`_sse`, `_sse_send`, `_sse_broadcast`)

---

**Document Version:** 1.3.0
**Created:** 2026-01-29
**Last Updated:** 2026-02-01
**Owner:** Blok Core Team
**Status:** Planning (enriched with runtime + context data flow learnings from E2E validation, Blok Studio source mapping added, SSE trigger source mapping and architecture learnings added)
