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
│   ├── nanoctl create
│   ├── nanoctl generate (AI)
│   ├── nanoctl dev
│   ├── nanoctl build
│   ├── nanoctl deploy
│   ├── nanoctl migrate
│   ├── nanoctl monitor
│   ├── nanoctl profile
│   ├── nanoctl graph
│   ├── nanoctl cost
│   └── nanoctl marketplace
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
| 1.7 | Nodes | P0 | defineNode.ts, NanoService.ts, NodeBase.ts | - [ ] | **NOTE:** All 28 TS nodes now use `defineNode()`. Document function-first as the standard, class-based as legacy. |
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
| 2.7 | SSE Trigger | P1 | triggers/sse/ | - [ ] |
| 2.8 | Worker Trigger | P1 | triggers/worker/ + 2 adapters | - [ ] |
| 2.9 | Building Custom Triggers | P1 | TriggerBase.ts | - [ ] |

### Phase 3: Multi-Language Runtimes
**Goal:** Full documentation for every language SDK and runtime adapter.

> **KEY LEARNINGS for Phase 3 (Runtime Documentation):**
>
> **3 Adapter Types with different protocols:**
> - **NodeJsRuntimeAdapter** — In-process execution, no serialization
> - **Python3RuntimeAdapter** — gRPC (base64-encoded JSON), sends resolved inputs as `request.body` in context, passes `config.inputs` to Python NanoService `handle()`, extracts `parsedResponse.data`
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

### Phase 7: Advanced Topics & Examples
**Goal:** Deep-dive content and real-world recipes.

| # | Page | Priority | Source Files | Status |
|---|------|----------|-------------|--------|
| 7.1 | HMR / Hot Reload | P2 | hmr/ | - [ ] |
| 7.2 | Node Result Caching | P2 | cache/NodeResultCache.ts | - [ ] |
| 7.3 | Cost Estimation | P2 | cost/CostEstimator.ts | - [ ] |
| 7.4 | GraphQL Generation | P2 | graphql/GraphQLSchemaGenerator.ts | - [ ] |
| 7.5 | OpenAPI Generation | P2 | openapi/OpenAPIGenerator.ts | - [ ] |
| 7.6 | Workflow Visualization | P2 | visualization/ | - [ ] |
| 7.7 | Performance Profiling | P2 | monitoring/PerformanceProfiler.ts | - [ ] |
| 7.8 | Compliance Guides | P2 | docs/compliance/ | - [ ] |
| 7.9 | E-commerce Example | P2 | examples/templates/ecommerce/ | - [ ] |
| 7.10 | Event-Driven Example | P2 | examples/workflows/ | - [ ] |

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
| Phase 7: Advanced | 10 | P2 |
| **Total** | **80 pages** | |

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

---

**Document Version:** 1.1.0
**Created:** 2026-01-29
**Last Updated:** 2026-01-29
**Owner:** Blok Core Team
**Status:** Planning (enriched with runtime + context data flow learnings from E2E validation)
