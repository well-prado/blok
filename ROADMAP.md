# Blok Framework Roadmap 2026

> **Vision:** Transform Blok into the most powerful, developer-friendly, truly language-agnostic workflow orchestration framework

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Phase 1: Foundation - Language-Agnostic Atomic Runner](#phase-1-foundation---language-agnostic-atomic-runner)
3. [Phase 2: Modern Developer Experience - Function-First Architecture](#phase-2-modern-developer-experience---function-first-architecture)
4. [Phase 3: Scalability - Universal Trigger System](#phase-3-scalability---universal-trigger-system)
5. [Phase 4: Intelligence - AI-Powered Code Generation](#phase-4-intelligence---ai-powered-code-generation)
6. [Phase 5: Enterprise - Multi-Language Runtime Ecosystem](#phase-5-enterprise---multi-language-runtime-ecosystem)
7. [Phase 6: Enterprise Protocol - gRPC Migration for All SDKs](#phase-6-enterprise-protocol---grpc-migration-for-all-sdks)
8. [Technical Debt & Infrastructure](#technical-debt--infrastructure)
9. [Timeline & Milestones](#timeline--milestones)

---

## Executive Summary

Blok is evolving from a TypeScript/Python-centric workflow framework into a **truly language-agnostic, enterprise-grade orchestration platform**. This roadmap outlines the strategic initiatives to achieve:

- **Language Agnosticism**: Run nodes in any language (Go, Java, Rust, PHP, C#, Ruby, etc.)
- **Modern DX**: Function-first, Zod-native node development (no more class boilerplate)
- **Universal Triggers**: HTTP, gRPC, queues, pub/sub, workers, cron, webhooks
- **AI-First Development**: Claude-powered node and workflow generation
- **Enterprise Scale**: Production-ready observability, performance, and reliability

---

## Phase 1: Foundation - Language-Agnostic Atomic Runner

### Objective
Make the runner truly runtime-agnostic by replacing the Python-specific `runtimeResolver` with a pluggable adapter system.

### Current State
- ❌ Runner is tightly coupled to Python3 via `RUNTIME_PYTHON3_HOST` and `RUNTIME_PYTHON3_PORT`
- ❌ Adding new languages requires modifying core runner code
- ✅ `NodeRuntime` exists but is Python-only
- ✅ gRPC protocol defined (`proto/node.proto`)

### Target Architecture

#### 1.1 Runtime Adapter Interface
**Location:** `core/runner/src/adapters/`

```typescript
interface RuntimeAdapter {
  kind: RuntimeKind;
  execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult>;
}

type RuntimeKind =
  | "nodejs"
  | "bun"
  | "python3"
  | "go"
  | "java"
  | "rust"
  | "php"
  | "csharp"
  | "docker"
  | "wasm";

type ExecutionResult = {
  success: boolean;
  data: unknown;
  errors: unknown | null;
  logs?: string[];
  metrics?: {
    duration_ms?: number;
    cpu_ms?: number;
    memory_bytes?: number;
  };
};
```

#### 1.2 Runtime Registry
**Location:** `core/runner/src/RuntimeRegistry.ts`

```typescript
class RuntimeRegistry {
  private adapters = new Map<RuntimeKind, RuntimeAdapter>();

  register(adapter: RuntimeAdapter): void;
  get(kind: RuntimeKind): RuntimeAdapter;
}
```

#### 1.3 Built-in Adapters

**A. NodeJS Runtime Adapter**
- Executes TypeScript/JavaScript nodes in-process
- Uses existing `BlokService.run(ctx)` integration
- Zero breaking changes to current Node.js nodes

**B. Python3 Runtime Adapter**
- Refactors `NodeRuntime` to implement `RuntimeAdapter`
- Keeps gRPC protocol but normalizes interface
- Maintains backward compatibility with existing Python nodes

**C. Docker/Generic Process Adapter**
- Universal adapter for any containerized runtime
- Implements canonical HTTP/gRPC contract
- Enables Go, Java, Rust, PHP without custom adapters

### Implementation Tasks

**Phase 1A: Core Abstractions (Week 1-2)**
- [ ] Create `RuntimeAdapter` interface and types
- [ ] Implement `RuntimeRegistry` singleton
- [ ] Define canonical `ExecutionResult` structure
- [ ] Add `runtime` field to `RunnerNode` type
- [ ] Update `Context` type for cross-language serialization

**Phase 1B: NodeJS Adapter (Week 2-3)**
- [ ] Implement `NodeJsRuntimeAdapter`
- [ ] Wrap existing `moduleResolver` and `localResolver` logic
- [ ] Ensure backward compatibility with all existing nodes
- [ ] Add unit tests for adapter
- [ ] Document adapter pattern

**Phase 1C: Python3 Adapter (Week 3-4)**
- [ ] Refactor `NodeRuntime` into `Python3RuntimeAdapter`
- [ ] Maintain existing gRPC protocol
- [ ] Normalize response to `ExecutionResult` format
- [ ] Update `runtimeResolver` to use registry
- [ ] Add integration tests

**Phase 1D: Docker Adapter (Week 5-6)**
- [ ] Implement `DockerRuntimeAdapter`
- [ ] Define container runtime contract (HTTP/gRPC endpoints)
- [ ] Create example Docker runtime images (Go, Java)
- [ ] Add container lifecycle management (pools, health checks)
- [ ] Document how to build custom runtime containers

**Phase 1E: Configuration & Migration (Week 6-7)**
- [ ] Update `Configuration.nodeTypes()` to be runtime-agnostic
- [ ] Add `runtime` field to workflow JSON schema
- [ ] Create migration guide for existing workflows
- [ ] Update CLI to support runtime selection
- [ ] Add runtime validation to workflow builder

**Phase 1F: Documentation & Examples (Week 7-8)**
- [ ] Write "Implementing a Custom Runtime" guide
- [ ] Create sample runtimes for each language
- [ ] Update architecture documentation
- [ ] Add troubleshooting guide for runtime issues
- [ ] Create video tutorials for runtime development

**Phase 1G: HTTP Runtime Adapters — Native SDK Support (Week 8-9)**
- [x] Implement `HttpRuntimeAdapter` for pre-existing SDK containers (Go, Rust, Java, C#, PHP, Ruby)
- [x] Register 6 HTTP adapters from env vars (`RUNTIME_{LANG}_HOST` / `RUNTIME_{LANG}_PORT`)
- [x] Add `runtime.go`, `runtime.rust`, `runtime.java`, `runtime.csharp`, `runtime.php`, `runtime.ruby` to `nodeTypes()`
- [x] Parse runtime kind from `type` string in `runtimeResolver()` (e.g., `"runtime.go"` → `"go"`)
- [x] Update cross-runtime-chain workflow to use native types (no more `runtime-bridge` workaround)
- [x] Unit tests for HttpRuntimeAdapter (35 tests passing)
- [x] Export `HttpRuntimeAdapter` and `HttpRuntimeAdapterOptions` from runner index
- [x] E2E validation: all 8 runtimes chain correctly via `ctx.vars` (NodeJS → Go → Rust → Java → C# → PHP → Ruby → Python3 — PASS)
- [x] `ctx.vars` data flow pattern validated: each step reads from previous step's vars, not `ctx.response.data`
- [x] Python3RuntimeAdapter improved: sends resolved inputs as `request.body`, extracts `parsedResponse.data`, passes `config.inputs` to Python BlokService
- [x] Chain-init and chain-verify nodes store/read from `ctx.vars` directly

### Success Metrics
- ✅ Zero breaking changes to existing workflows
- ✅ New runtime can be added in < 1 day
- ✅ All existing Python nodes work unchanged
- ✅ Node execution overhead < 5ms per runtime call
- ✅ 90%+ test coverage on adapters

### Dependencies
- Protocol Buffer definitions stable
- Context serialization strategy defined
- Docker registry for runtime images

---

## Phase 2: Modern Developer Experience - Function-First Architecture

### Objective
Replace class-based node development with modern, Elysia-style function + Zod schema pattern.

### Current State
- ❌ Nodes require class inheritance (`extends BlokService<T>`)
- ❌ Duplicate schema definitions (JSON Schema + TypeScript types)
- ❌ Verbose boilerplate (`constructor`, `handle`, `BlokResponse`)
- ❌ AI models struggle to generate correct class patterns
- ✅ Zod v4 already in dependencies
- ✅ Context type well-defined

### Target Architecture

#### 2.1 DefineNode API
**Location:** `core/nodes/defineNode.ts`

```typescript
import { z } from "zod";
import { Context } from "@blok/shared";

const MyNode = defineNode({
  name: "fetch-user",
  description: "Fetches user by ID from database",

  input: z.object({
    userId: z.string().uuid(),
  }),

  output: z.object({
    user: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string().email(),
    }),
  }),

  async execute(ctx: Context, input) {
    // Type-safe input automatically inferred
    const user = await db.users.findById(input.userId);

    // Store for downstream nodes
    ctx.vars["current-user"] = user;

    // Type-safe output automatically validated
    return { user };
  },
});
```

#### 2.2 Backward Compatibility Layer
```typescript
// defineNode wraps function into BlokService-compatible instance
class FunctionNode extends BlokService<I> {
  async handle(ctx: Context, rawInputs: I): Promise<IBlokResponse> {
    // 1. Validate input with Zod
    const parsed = def.input.parse(rawInputs);

    // 2. Execute function
    const result = await def.execute(ctx, parsed);

    // 3. Validate output with Zod
    const parsedOutput = def.output.parse(result);

    // 4. Return standard response
    response.setSuccess(parsedOutput);
  }
}
```

### Implementation Tasks

**Phase 2A: Core defineNode API (Week 1-2)** ✅
- [x] Create `FnNodeDefinition<I, O>` interface
- [x] Implement `defineNode<I, O>()` helper
- [x] Add `FunctionNode` wrapper class
- [x] Implement Zod input/output validation
- [x] Add `GlobalError` mapping for Zod errors
- [x] Write comprehensive unit tests
- [x] Add `contentType` support to `FnNodeDefinition` (e.g. `"text/html"`, `"application/pdf"`)

**Phase 2B: CLI Template Updates (Week 2-3)** ✅
- [x] Create new functional node template
- [ ] Add `--style=function|class` flag to `blokctl create node`
- [ ] Update `NodeFileWriter` to support both templates
- [x] Default to function-first for new projects
- [ ] Add migration script for class → function conversion

**Phase 2C: AI Generation Prompts (Week 3-4)**
- [ ] Implement `createFnNodeSystemPrompt` (from docs)
- [ ] Update `generate ai-node` to use function-first
- [ ] Add examples to prompt library
- [ ] Create validation for AI-generated schemas
- [ ] Add feedback loop for prompt refinement

**Phase 2D: Node Migration (Week 4-6)** ✅
- [x] Convert `@blok/api-call` to function-first
- [x] Convert `@blok/if-else` to function-first
- [x] Convert HTTP example nodes to function-first (all 25 nodes migrated)
- [ ] Create migration guide for node authors
- [ ] Add deprecation warnings to class-based pattern

**Phase 2E: Documentation & Best Practices (Week 6-7)**
- [ ] Write "Function-First Node Development" guide
- [ ] Create Zod schema cookbook
- [ ] Document context usage patterns
- [ ] Add examples for common use cases
- [ ] Record video tutorial series

**Phase 2F: Community Adoption (Week 7-8)**
- [ ] Publish migration guide
- [ ] Host community workshop
- [ ] Create template repository
- [ ] Add community showcase
- [ ] Collect feedback and iterate

**Phase 2G: Full Node Migration to Function-First** ✅
All 28 TypeScript nodes migrated from class-based (`extends BlokService<T>`) to function-first (`defineNode()`) pattern:

| Batch | Nodes | Status |
|-------|-------|--------|
| 0 - Infrastructure | `contentType` support in `defineNode`, react@1.0.0 fix | ✅ |
| 1 - CLI Templates | `templates/node`, `templates/node-ui` | ✅ |
| 2 - Core Nodes | `chain-init`, `chain-verify`, `runtime-bridge`, `Nodes.ts` registration fix | ✅ |
| 3 - Simple Nodes | `DirectoryManager`, `FileManager`, `ErrorNode`, `MapperNode`, `Base64ToPDF` | ✅ |
| 4 - Medium Nodes | `SaveImageBase64`, `ArrayMap`, `MemoryStorage`, `OpenAI`, `QueryGenerator` | ✅ |
| 5 - UI Nodes | `WorkflowUI`, `DashboardGeneratorUI`, `DatabaseUI`, `WeatherUI`, `ImageCaptureUI`, `FeedbackUI` | ✅ |
| 6 - Complex Nodes | `MongoQuery`, `PostgresQuery`, `MastraAgent`, `MultipleQueryGenerator`, `DashboardChartsGenerator` | ✅ |

Key changes:
- `Nodes.ts` updated: removed `new` keyword (defineNode returns instances, not classes)
- `triggers/http/package.json` updated: `api-call` and `if-else` switched to `workspace:*`
- `groupBy` and `runJs` extracted as standalone functions (from class methods)
- `contentType` field added to `FnNodeDefinition` interface for non-JSON responses

### Success Metrics
- ✅ 100% backward compatibility maintained
- ✅ Node LoC reduced by 60%+ vs class pattern
- ✅ AI generation success rate > 95%
- ✅ Developer satisfaction score > 8/10
- ✅ 50+ community-contributed function-first nodes

### Dependencies
- Zod v4 integration stable
- Context type finalized
- Documentation site ready

---

## Phase 3: Scalability - Universal Trigger System

### Objective
Expand from HTTP + gRPC to support queues, pub/sub, workers, cron, webhooks, and custom triggers.

### Current State
- ✅ HTTP trigger (Hono + @hono/node-server)
- ✅ gRPC trigger (Connect RPC)
- ✅ SSE trigger (Server-Sent Events) — complete project template with Hono server, real-time streaming, channel management, Blok Studio integration, CLI support
- ❌ Queue triggers (Kafka, RabbitMQ, SQS, etc.)
- ❌ Pub/sub triggers (Redis, NATS, etc.)
- ❌ Worker triggers (Temporal, Inngest-like)
- ❌ Cron triggers (scheduled workflows)
- ❌ Webhook triggers (GitHub, Stripe, etc.)

### Target Architecture

#### 3.1 Trigger Schema Extensions
**Location:** `core/workflow-helper/src/types/TriggerOpts.ts`

```typescript
export const TriggersSchema = z.enum([
  "http",
  "grpc",
  "manual",
  "cron",
  "queue",
  "pubsub",
  "worker",
  "webhook",
  "sse",
  "websocket",
]);

export const TriggerOptsSchema = z.union([
  // HTTP
  z.object({
    type: z.literal("http"),
    method: z.string(),
    path: z.string(),
    accept: z.string().optional(),
  }),

  // gRPC
  z.object({
    type: z.literal("grpc"),
    service: z.string(),
    method: z.string(),
  }),

  // Queue (Kafka, RabbitMQ, SQS, etc.)
  z.object({
    type: z.literal("queue"),
    provider: z.enum(["kafka", "rabbitmq", "sqs", "redis", "beanstalk"]),
    topic: z.string(),
    subscription: z.string().optional(),
    consumerGroup: z.string().optional(),
    ack: z.boolean().optional(),
    deadLetterQueue: z.string().optional(),
  }),

  // Pub/Sub (Redis, NATS, Google Pub/Sub, etc.)
  z.object({
    type: z.literal("pubsub"),
    provider: z.enum(["redis", "nats", "google", "aws", "azure"]),
    channel: z.string(),
    pattern: z.string().optional(),
  }),

  // Worker (long-running background jobs)
  z.object({
    type: z.literal("worker"),
    queue: z.string(),
    concurrency: z.number().optional(),
    timeout: z.number().optional(),
    retries: z.number().optional(),
  }),

  // Cron (scheduled workflows)
  z.object({
    type: z.literal("cron"),
    schedule: z.string(), // cron expression
    timezone: z.string().optional(),
  }),

  // Webhook (event-driven from external services)
  z.object({
    type: z.literal("webhook"),
    source: z.string(), // github, stripe, shopify, etc.
    events: z.array(z.string()),
    secret: z.string().optional(),
  }),
]);
```

#### 3.2 TriggerBase Pattern
All triggers extend `TriggerBase` and follow the same pattern:

```typescript
class QueueTrigger extends TriggerBase {
  private nodeMap: GlobalOptions;

  constructor() {
    super();
    this.loadNodes();
    this.loadWorkflows();
  }

  async startConsumer() {
    // 1. Connect to queue
    // 2. Subscribe to messages
    // 3. For each message:
    for (const workflowModel of this.nodeMap.workflows) {
      const trigger = Object.keys(workflowModel.trigger)[0];
      if (trigger !== "queue") continue;

      const config = workflowModel.trigger[trigger] as QueueTriggerOpts;

      // Match on topic/subscription
      if (config.topic !== message.topic) continue;

      // Create context
      const ctx = this.createContext(undefined, workflowModel.path);
      ctx.request = {
        body: message.body,
        headers: message.headers || {},
        query: {},
        params: {},
      };

      // Execute workflow
      await this.executeWorkflow(ctx, workflowModel);

      // Ack/nack based on ctx.response
      if (ctx.response.success) {
        await message.ack();
      } else {
        await message.nack();
      }
    }
  }
}
```

### Implementation Tasks

**Phase 3A: Queue Triggers (Week 1-3)**
- [ ] Design queue trigger configuration schema
- [ ] Implement Kafka adapter
- [ ] Implement RabbitMQ adapter
- [ ] Implement AWS SQS adapter
- [ ] Implement Redis Queue adapter
- [ ] Add dead letter queue support
- [ ] Add consumer group management
- [ ] Write integration tests
- [ ] Create example workflows
- [ ] Document queue trigger usage

**Phase 3B: Pub/Sub Triggers (Week 4-5)**
- [ ] Design pub/sub trigger configuration schema
- [ ] Implement Redis Pub/Sub adapter
- [ ] Implement NATS adapter
- [ ] Implement Google Cloud Pub/Sub adapter
- [ ] Add pattern-based subscriptions
- [ ] Add fanout/broadcast support
- [ ] Write integration tests
- [ ] Create example workflows
- [ ] Document pub/sub trigger usage

**Phase 3C: Worker Triggers (Week 6-7)**
- [ ] Design worker trigger configuration schema
- [ ] Implement worker pool management
- [ ] Add concurrency controls
- [ ] Add timeout handling
- [ ] Add retry logic with exponential backoff
- [ ] Add job scheduling (delay, priority)
- [ ] Create worker dashboard UI
- [ ] Write integration tests
- [ ] Document worker trigger usage

**Phase 3D: Cron Triggers (Week 8-9)**
- [ ] Design cron trigger configuration schema
- [ ] Implement cron scheduler (node-cron)
- [ ] Add timezone support
- [ ] Add overlapping execution controls
- [ ] Add schedule validation
- [ ] Create cron expression builder UI
- [ ] Write integration tests
- [ ] Document cron trigger usage

**Phase 3E: Webhook Triggers (Week 10-11)**
- [ ] Design webhook trigger configuration schema
- [ ] Implement webhook verification (HMAC, JWT)
- [ ] Add GitHub webhook support
- [ ] Add Stripe webhook support
- [ ] Add Shopify webhook support
- [ ] Add generic webhook handler
- [ ] Create webhook testing tools
- [ ] Write integration tests
- [ ] Document webhook trigger usage

**Phase 3F: Real-time Triggers (Week 12-13)**
- [ ] Implement WebSocket trigger
- [x] Implement SSE (Server-Sent Events) trigger
- [x] Add connection management (SSE)
- [ ] Add authentication/authorization
- [x] Add room/channel support (SSE)
- [ ] Create real-time dashboard
- [x] Write integration tests (SSE — 49 tests passing)
- [ ] Document real-time trigger usage

> **Phase 3F — SSE Trigger Template (Completed)**
>
> The SSE trigger is now a complete, runnable project template — on par with the HTTP trigger — so that `blokctl create project --trigger sse` produces a working project.
>
> **Architecture:**
> - `SSETrigger` (abstract base, 860 lines) — connection management, channels, broadcasting, heartbeat, event history/replay, workflow triggering on connect/disconnect/subscribe/unsubscribe
> - `SSEServer` (concrete trigger) — extends `SSETrigger`, adds Hono HTTP server with SSE stream endpoints, REST management APIs, Blok Studio integration, Prometheus metrics
> - App entry point (`src/index.ts`) mirrors the HTTP trigger pattern with `GlobalOptions`, `App` class, and HMR support
>
> **Endpoints (port 4001):**
> - `GET /events/:channel` — SSE stream (opens connection, subscribes to channel)
> - `POST /events/:channel/publish` — publish event to a channel
> - `POST /events/broadcast` — broadcast to all connected clients
> - `GET /clients` — connection stats (active connections, total, uptime)
> - `GET /channels` — list active channels with client counts
> - `GET /health-check` — health check
> - `GET /metrics` — Prometheus metrics
> - `/__blok/*` — Blok Studio trace routes
>
> **Example workflows & nodes:**
> - `on-connect` workflow — triggered when a client connects, sends welcome message
> - `on-subscribe` workflow — triggered when a client subscribes to a channel
> - `welcome-message` node — `defineNode()` pattern, sends SSE event via `ctx.vars._sse_send`
>
> **SSE context data (available in workflows):**
> - `ctx.vars._sse` — `{ clientId, eventType, channel, clientChannels, clientMetadata, timestamp }`
> - `ctx.vars._sse_send` — function to send SSE event to the triggering client
> - `ctx.vars._sse_broadcast` — function to broadcast SSE event to a channel
>
> **CLI integration:**
> - `blokctl create project --trigger sse` added to project creation wizard
> - Trigger-aware port assignment (HTTP: 4000, SSE: 4001)
> - Full non-interactive mode support
>
> **Infrastructure:**
> - Docker support (`Dockerfile` + `Dockerfile.dev`)
> - `.env.example` with SSE-specific configuration
> - `vitest.config.ts` with 90% coverage thresholds
> - 49 tests passing across connection management, channels, broadcasting, heartbeat, and event history
>
> **Known limitation:** `TriggerOpts` in `@blok/helper` only defines HTTP fields — SSE trigger options require `as any` cast. Fix planned in Phase 3.1 (discriminated union types per trigger kind).

**Phase 3G: AI-Powered Trigger Generation (Week 14)**
- [ ] Implement trigger generation prompt (from docs)
- [ ] Add trigger validation
- [ ] Create trigger templates
- [ ] Add trigger discovery CLI
- [ ] Document AI trigger generation

**Phase 3H: Trigger Monitoring & Observability (Week 15-16)**
- [ ] Add trigger-specific metrics
- [ ] Implement trigger health checks
- [ ] Add trigger rate limiting
- [ ] Add trigger circuit breakers
- [ ] Create trigger monitoring dashboard
- [ ] Add trigger alerting
- [ ] Document trigger operations

### Success Metrics
- ✅ Support 10+ trigger types
- ✅ Trigger registration < 10 lines of code
- ✅ Event-to-execution latency < 100ms (p99)
- ✅ 99.99% message delivery guarantee
- ✅ Hot-reload trigger configurations
- ✅ Zero-downtime trigger deployments

### Dependencies
- Runtime adapters stable
- Context serialization optimized
- Message broker integrations tested

---

## Phase 4: Intelligence - AI-Powered Code Generation

### Objective
Make Blok the most AI-friendly workflow framework by enabling Claude to generate perfect nodes, workflows, and triggers.

### Current State
- ✅ Basic `generate ai-node` command exists
- ✅ OpenAI integration in CLI
- ❌ Prompts not optimized for current architecture
- ❌ No workflow generation
- ❌ No trigger generation
- ❌ No validation or feedback loops

### Target Architecture

#### 4.1 AI Generation System
**Location:** `packages/cli/src/commands/generate/ai/`

```
ai/
├── prompts/
│   ├── node-function-first.prompt.ts     (from new-version-docs)
│   ├── workflow-typescript.prompt.ts     (from new-version-docs)
│   ├── trigger-system.prompt.ts          (from new-version-docs)
│   └── runtime-adapter.prompt.ts         (new)
├── validators/
│   ├── node.validator.ts
│   ├── workflow.validator.ts
│   └── trigger.validator.ts
├── generators/
│   ├── NodeGenerator.ts
│   ├── WorkflowGenerator.ts
│   └── TriggerGenerator.ts
└── index.ts
```

#### 4.2 Enhanced Generation Commands

```bash
# Node generation (function-first)
blokctl generate ai-node "Fetch user from PostgreSQL by ID"
blokctl generate ai-node "Send email via SendGrid with template"

# Workflow generation (TypeScript structure)
blokctl generate ai-workflow "User registration with email verification"
blokctl generate ai-workflow "E-commerce checkout flow with payment"

# Trigger generation (any type)
blokctl generate ai-trigger "Kafka consumer for user-events topic"
blokctl generate ai-trigger "Cron job to sync data every hour"

# Runtime adapter generation
blokctl generate ai-runtime "Go HTTP runtime adapter"
blokctl generate ai-runtime "Rust gRPC runtime adapter"
```

#### 4.3 System Prompts
Based on documents in `new-version-docs/`:

**A. Function-First Node Prompt**
- Uses `defineNode` API
- Generates Zod schemas (input + output)
- Implements type-safe `execute()` function
- Includes Context usage patterns
- Handles errors properly

**B. Workflow TypeScript Structure Prompt**
- Generates `WorkflowConfig` objects
- Uses correct trigger configuration
- Implements conditional routing with `@blok/if-else`
- Uses proper `ctx` references in conditions
- Follows HTTP/gRPC workflow patterns

**C. Trigger System Prompt**
- Extends `TriggerBase` correctly
- Implements `loadNodes()` and `loadWorkflows()`
- Reads `workflowModel.trigger` properly
- Creates context with `this.createContext()`
- Maps events to workflows
- Handles responses correctly

### Implementation Tasks

**Phase 4A: Prompt Engineering (Week 1-2)**
- [ ] Convert all prompts from `new-version-docs/` to CLI format
- [ ] Add prompt versioning system
- [ ] Create prompt testing framework
- [ ] Add prompt analytics (success rate, tokens, latency)
- [ ] Document prompt engineering guidelines

**Phase 4B: Node Generation Enhancement (Week 2-3)**
- [ ] Implement function-first node generation
- [ ] Add Zod schema validation
- [ ] Add context usage examples
- [ ] Add error handling patterns
- [ ] Add multi-step generation (planning → implementation)
- [ ] Add code review feedback loop

**Phase 4C: Workflow Generation (Week 3-5)**
- [ ] Implement workflow structure generation
- [ ] Add conditional routing generation
- [ ] Add node configuration generation
- [ ] Add workflow validation
- [ ] Add workflow testing generation
- [ ] Add workflow documentation generation

**Phase 4D: Trigger Generation (Week 5-6)**
- [ ] Implement trigger class generation
- [ ] Add trigger configuration generation
- [ ] Add trigger bootstrap generation
- [ ] Add trigger validation
- [ ] Add trigger testing generation

**Phase 4E: Runtime Adapter Generation (Week 6-7)**
- [ ] Implement runtime adapter generation
- [ ] Add language-specific code generation
- [ ] Add Docker configuration generation
- [ ] Add protocol implementation generation
- [ ] Add adapter validation

**Phase 4F: Validation & Feedback (Week 7-8)**
- [ ] Implement AST-based code validation
- [ ] Add TypeScript compilation checks
- [ ] Add Zod schema validation
- [ ] Add runtime testing
- [ ] Add feedback loop to improve prompts
- [ ] Add human-in-the-loop approval

**Phase 4G: IDE Integration (Week 9-10)**
- [ ] Create VS Code extension
- [ ] Add inline AI generation
- [ ] Add code completion
- [ ] Add refactoring suggestions
- [ ] Add hover documentation
- [ ] Add diagnostic warnings

**Phase 4H: Knowledge Base (Week 10-11)**
- [ ] Build vector database of examples
- [ ] Add semantic search for patterns
- [ ] Add RAG for context-aware generation
- [ ] Add learning from user edits
- [ ] Add community knowledge sharing

### Success Metrics
- ✅ 95%+ AI generation success rate (compiles + runs)
- ✅ 90%+ developer acceptance rate (no major edits)
- ✅ < 30 seconds average generation time
- ✅ 80%+ reduction in boilerplate code
- ✅ 500+ AI-generated nodes in production

### Dependencies
- Function-first architecture implemented
- Trigger system complete
- Validation framework ready

---

## Phase 5: Enterprise - Multi-Language Runtime Ecosystem

### Objective
Complete the vision of true language agnosticism with production-ready runtimes for all major languages.

### Current State
- ✅ Node.js runtime (in-process)
- ✅ Python 3 runtime (HTTP SDK — migrated from gRPC)
- ✅ Go runtime (HTTP SDK)
- ✅ Java runtime (HTTP SDK)
- ✅ Rust runtime (HTTP SDK)
- ✅ PHP runtime (HTTP SDK)
- ✅ C# / .NET runtime (HTTP SDK)
- ✅ Ruby runtime (HTTP SDK)
- ❌ Elixir runtime

### Target Architecture

#### 5.1 Language Runtime Parity Matrix

| Language | In-Process | gRPC | HTTP | Docker | WASM | Status |
|----------|-----------|------|------|--------|------|--------|
| Node.js  | ✅ | ✅ | ✅ | ✅ | 🔄 | Production |
| Bun      | ✅ | ✅ | ✅ | ✅ | ❌ | Beta |
| Python 3 | ❌ | ❌ | ✅ | ✅ | ❌ | Production (HTTP SDK) |
| Go       | ❌ | ❌ | ✅ | ✅ | 🔄 | Production (HTTP SDK) |
| Java     | ❌ | ❌ | ✅ | ✅ | ❌ | Production (HTTP SDK) |
| Rust     | ❌ | 🔄 | ✅ | ✅ | ✅ | Production (HTTP SDK, optional gRPC) |
| C# / .NET| ❌ | ❌ | ✅ | ✅ | ❌ | Production (HTTP SDK) |
| PHP      | ❌ | ❌ | ✅ | ✅ | ❌ | Production (HTTP SDK) |
| Ruby     | ❌ | ❌ | ✅ | ✅ | ❌ | Production (HTTP SDK) |
| Elixir   | ❌ | ❌ | 🔄 | 🔄 | ❌ | Future |

#### 5.2 Runtime SDK Structure

Each language gets a standardized SDK:

```
runtimes/
├── nodejs/           (existing @blok/*)
├── bun/              (existing, minimal changes)
├── python3/          (existing runtimes/python3)
├── go/
│   ├── core/
│   │   ├── blok.go
│   │   ├── context.go
│   │   ├── node.go
│   │   └── response.go
│   ├── server/
│   │   ├── grpc.go
│   │   └── http.go
│   ├── nodes/
│   │   └── examples/
│   └── go.mod
├── java/
│   ├── core/
│   │   ├── Blok.java
│   │   ├── Context.java
│   │   ├── Node.java
│   │   └── Response.java
│   ├── server/
│   │   ├── GrpcServer.java
│   │   └── HttpServer.java
│   ├── nodes/
│   │   └── examples/
│   └── pom.xml
├── rust/
│   ├── src/
│   │   ├── lib.rs
│   │   ├── blok.rs
│   │   ├── context.rs
│   │   ├── node.rs
│   │   └── response.rs
│   ├── server/
│   │   ├── grpc.rs
│   │   └── http.rs
│   ├── nodes/
│   │   └── examples/
│   └── Cargo.toml
└── [php, csharp, ruby, elixir]/
```

#### 5.3 Runtime Protocol Standardization

**Universal Node Interface:**
```protobuf
// proto/node.proto (universal)
service NodeService {
  rpc Execute(NodeRequest) returns (NodeResponse);
  rpc Validate(NodeRequest) returns (ValidationResponse);
  rpc Health(HealthRequest) returns (HealthResponse);
}

message NodeRequest {
  string node_name = 1;
  string node_path = 2;
  Context context = 3;
  map<string, bytes> config = 4;
}

message NodeResponse {
  bool success = 1;
  bytes data = 2;
  repeated Error errors = 3;
  Metrics metrics = 4;
}
```

### Implementation Tasks

**Phase 5A: Go Runtime (Week 1-4)**
- [ ] Create Go core SDK (`blok-go`)
- [ ] Implement Context mapping
- [ ] Implement Node base
- [ ] Create gRPC server
- [ ] Create HTTP server
- [ ] Add example nodes
- [ ] Add testing framework
- [ ] Write documentation
- [ ] Publish to Go pkg registry

**Phase 5B: Java Runtime (Week 5-8)**
- [ ] Create Java core SDK (`blok-java`)
- [ ] Implement Context mapping (POJOs)
- [ ] Implement Node base class
- [ ] Create gRPC server (grpc-java)
- [ ] Create HTTP server (Spring Boot)
- [ ] Add example nodes
- [ ] Add testing framework
- [ ] Write documentation
- [ ] Publish to Maven Central

**Phase 5C: Rust Runtime (Week 9-12)**
- [ ] Create Rust core SDK (`blok-rs`)
- [ ] Implement Context mapping (serde)
- [ ] Implement Node trait
- [ ] Create gRPC server (tonic)
- [ ] Create HTTP server (axum)
- [ ] Add WASM support (wasmtime)
- [ ] Add example nodes
- [ ] Add testing framework
- [ ] Write documentation
- [ ] Publish to crates.io

**Phase 5D: C# / .NET Runtime (Week 13-16)**
- [ ] Create .NET core SDK (`Blok.Core`)
- [ ] Implement Context mapping
- [ ] Implement Node base class
- [ ] Create gRPC server (Grpc.Net)
- [ ] Create HTTP server (ASP.NET)
- [ ] Add example nodes
- [ ] Add testing framework
- [ ] Write documentation
- [ ] Publish to NuGet

**Phase 5E: PHP Runtime (Week 17-19)**
- [ ] Create PHP core SDK (`blok-php`)
- [ ] Implement Context mapping (arrays/objects)
- [ ] Implement Node base class
- [ ] Create HTTP server (PSR-7/PSR-15)
- [ ] Add example nodes
- [ ] Add testing framework (PHPUnit)
- [ ] Write documentation
- [ ] Publish to Packagist

**Phase 5F: Ruby Runtime (Week 20-22)**
- [ ] Create Ruby core SDK (`blok-ruby`)
- [ ] Implement Context mapping (hashes)
- [ ] Implement Node base class
- [ ] Create HTTP server (Rack/Sinatra)
- [ ] Add example nodes
- [ ] Add testing framework (RSpec)
- [ ] Write documentation
- [ ] Publish to RubyGems

**Phase 5G: Cross-Language Integration Tests (Week 23-24)**
- [ ] Create polyglot workflows (Node → Python → Go)
- [ ] Test all language combinations
- [ ] Benchmark performance across languages
- [ ] Test error propagation
- [ ] Test context serialization
- [ ] Stress test runtime adapters
- [ ] Document performance characteristics

**Phase 5H: Runtime Marketplace (Week 25-26)**
- [ ] Create runtime registry/marketplace
- [ ] Add runtime versioning
- [ ] Add runtime discovery
- [ ] Add runtime metrics dashboard
- [ ] Add runtime health monitoring
- [ ] Add runtime auto-scaling
- [ ] Document runtime operations

### Success Metrics
- ✅ 7+ languages in production
- ✅ < 10ms overhead per runtime hop
- ✅ 99.9% cross-language compatibility
- ✅ 1000+ community-contributed nodes across languages
- ✅ < 1 hour to add new language runtime

### Dependencies
- Runtime adapter architecture stable
- Protocol buffers finalized
- Docker infrastructure ready

---

## Phase 6: Enterprise Protocol - gRPC Migration for All SDKs

### Objective
Migrate all language SDK runtimes from HTTP to gRPC as the primary inter-service communication protocol, delivering enterprise-grade performance, streaming, and formal contract enforcement across the entire runtime ecosystem.

### Rationale

HTTP served as the pragmatic choice for rapid SDK development — every language has HTTP built in, debugging is trivial, and the SDK pattern is uniform. With all 7 SDKs now production-ready on HTTP, the foundation is stable enough to layer gRPC on top for enterprise workloads that demand:

1. **Binary serialization** — Protobuf is 3-10x smaller on the wire than JSON for structured data
2. **HTTP/2 multiplexing** — Single TCP connection handles thousands of concurrent RPCs
3. **Bidirectional streaming** — Nodes can stream partial results (LLM token streaming, large dataset processing)
4. **Formal schema contracts** — Proto files give compile-time type safety across all 7+ languages
5. **Deadline propagation** — Native timeout cascading across service boundaries
6. **Code generation** — Auto-generated clients and servers from a single `.proto` source of truth

### Current State
- ✅ All 7 SDKs running on HTTP (`POST /execute`, `GET /health`)
- ✅ gRPC trigger system exists (`triggers/grpc/`) for external workflow invocation
- ✅ Rust SDK has optional gRPC server (`ENABLE_GRPC=false` by default)
- ✅ Proto definitions exist (`core/runner/proto/node.proto`)
- ✅ Legacy Python3 gRPC adapter available as reference implementation
- ❌ No SDK-to-runner gRPC communication in production

### Target Architecture

#### 6.1 Unified Proto Service Definition

```protobuf
// proto/runtime.proto (v2 — universal)
syntax = "proto3";
package blok.runtime.v2;

service RuntimeService {
  // Unary — standard node execution
  rpc Execute(ExecuteRequest) returns (ExecuteResponse);

  // Server streaming — progressive results (LLM tokens, batch processing)
  rpc ExecuteStream(ExecuteRequest) returns (stream ExecuteResponse);

  // Health checking
  rpc Health(HealthRequest) returns (HealthResponse);

  // Node discovery
  rpc ListNodes(ListNodesRequest) returns (ListNodesResponse);
}

message ExecuteRequest {
  string node_name = 1;
  Context context = 2;
  map<string, bytes> config = 3;
}

message ExecuteResponse {
  bool success = 1;
  bytes data = 2;                    // JSON-encoded response data
  repeated Error errors = 3;
  Metrics metrics = 4;
  map<string, bytes> vars = 5;      // Updated ctx.vars
  bool is_partial = 6;              // true for streaming chunks
}

message Context {
  string id = 1;
  string workflow_name = 2;
  string workflow_path = 3;
  Request request = 4;
  Response response = 5;
  map<string, bytes> vars = 6;
  map<string, string> env = 7;
}

message Metrics {
  double duration_ms = 1;
  double cpu_ms = 2;
  int64 memory_bytes = 3;
}
```

#### 6.2 GrpcRuntimeAdapter

```typescript
// New adapter alongside HttpRuntimeAdapter
class GrpcRuntimeAdapter implements RuntimeAdapter {
  kind: RuntimeKind;
  private client: RuntimeServiceClient;
  private transport: GrpcTransport;

  async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
    const request = this.buildExecuteRequest(node, ctx);
    const response = await this.client.execute(request, {
      deadline: Date.now() + this.timeoutMs,
    });
    return this.parseExecuteResponse(response);
  }

  async executeStream(node: RunnerNode, ctx: Context): AsyncIterable<ExecutionResult> {
    const request = this.buildExecuteRequest(node, ctx);
    for await (const chunk of this.client.executeStream(request)) {
      yield this.parseExecuteResponse(chunk);
    }
  }
}
```

#### 6.3 Dual-Protocol SDK Pattern

Each SDK will support both HTTP and gRPC, with a configuration switch:

```
SDK Container
├── HTTP server (:8080)     — Always available (backward compat, debugging)
├── gRPC server (:50051)    — Enabled via ENABLE_GRPC=true
└── Shared node registry    — Same nodes serve both protocols
```

### Implementation Tasks

**Phase 6A: Proto v2 Design & Code Generation (Future)**
- [ ] Design `runtime.proto` v2 with streaming support
- [ ] Set up proto code generation for all 7 languages (Go, Rust, Java, C#, PHP, Ruby, Python)
- [ ] Create shared proto package/module per language
- [ ] Add proto linting and breaking-change detection (buf)
- [ ] Document proto evolution policy

**Phase 6B: GrpcRuntimeAdapter in Runner (Future)**
- [ ] Implement `GrpcRuntimeAdapter` in TypeScript runner
- [ ] Support unary and server-streaming RPCs
- [ ] Add deadline/timeout propagation
- [ ] Add connection pooling and keepalive
- [ ] Add fallback to HTTP on gRPC failure (graceful degradation)
- [ ] Update `Configuration.ts` to support protocol selection per runtime
- [ ] Unit tests for adapter

**Phase 6C: Go SDK gRPC Server (Future)**
- [ ] Add gRPC server to Go SDK (using `google.golang.org/grpc`)
- [ ] Dual-listen on HTTP (:8080) and gRPC (:50051)
- [ ] Share node registry between both servers
- [ ] Add streaming support for compatible nodes
- [ ] Integration tests

**Phase 6D: Rust SDK gRPC Server (Future)**
- [ ] Promote existing optional gRPC server to production-ready
- [ ] Update to proto v2 service definition
- [ ] Add streaming support (tonic streaming)
- [ ] Integration tests

**Phase 6E: Java SDK gRPC Server (Future)**
- [ ] Add gRPC server to Java SDK (using `grpc-java` or `armeria`)
- [ ] Dual-listen on HTTP and gRPC
- [ ] Add streaming support
- [ ] Integration tests

**Phase 6F: C# SDK gRPC Server (Future)**
- [ ] Add gRPC server to C# SDK (using `Grpc.AspNetCore`)
- [ ] Dual-listen via ASP.NET Kestrel (HTTP + gRPC on same port or separate)
- [ ] Add streaming support
- [ ] Integration tests

**Phase 6G: PHP SDK gRPC Server (Future)**
- [ ] Evaluate PHP gRPC options (`grpc` PECL extension, `spiral/roadrunner`)
- [ ] Add gRPC server to PHP SDK
- [ ] Integration tests

**Phase 6H: Ruby SDK gRPC Server (Future)**
- [ ] Add gRPC server to Ruby SDK (using `grpc` gem)
- [ ] Dual-listen on HTTP and gRPC
- [ ] Integration tests

**Phase 6I: Python3 SDK gRPC Server (Future)**
- [ ] Add gRPC server to Python3 SDK (using `grpcio`)
- [ ] Dual-listen on HTTP and gRPC
- [ ] Add streaming support
- [ ] Integration tests

**Phase 6J: Cross-Runtime gRPC Integration Tests (Future)**
- [ ] Update cross-runtime chain test to run over gRPC
- [ ] Benchmark gRPC vs HTTP latency per runtime
- [ ] Benchmark gRPC vs HTTP throughput under load
- [ ] Test streaming across runtimes
- [ ] Test deadline propagation across chain
- [ ] Test graceful fallback to HTTP
- [ ] Document performance characteristics

### Success Metrics
- ✅ All 7 SDKs support dual-protocol (HTTP + gRPC)
- ✅ < 1ms overhead per gRPC runtime hop (vs ~2ms HTTP)
- ✅ Streaming support for LLM and batch nodes
- ✅ Proto schema enforced at compile time across all languages
- ✅ Zero breaking changes — HTTP remains the default, gRPC is opt-in
- ✅ Graceful degradation: gRPC failure falls back to HTTP automatically

### Dependencies
- All HTTP SDKs stable and production-tested
- Proto v2 design reviewed and approved
- gRPC infrastructure (load balancers, health checks) validated
- Streaming use cases identified and prioritized

---

## Blok Studio — Real-Time Workflow Trace UI

### Objective
Provide a built-in, developer-facing web UI for real-time workflow observability — trace inspection, performance metrics, run comparison, and operational dashboards — without requiring external tooling.

### Current State ✅ Complete
Blok Studio is a production-ready React SPA (`apps/studio/`) that connects to the runner's trace API via a Vite proxy and SSE streams.

### Architecture
- **Frontend:** React 19, TypeScript, Vite 6, TanStack Router/Query/Table, Zustand, Tailwind CSS v4
- **Visualization:** @xyflow/react (trace graphs), Recharts (metrics charts)
- **Data:** REST API at `/__blok/*`, SSE streams for real-time updates
- **Dev server:** `localhost:5555`, proxies API to backend at `localhost:4000`

### Implementation Status

**Phase 1: Real-Time Tracing System (Backend)** ✅
- [x] Trace collection middleware in runner (`RunnerSteps.ts`)
- [x] REST API: `/health`, `/config`, `/workflows`, `/runs`, `/runs/:id`, `/search`, `/metrics`
- [x] SSE streaming: per-run events (`/runs/:id/stream`) and global feed (`/stream`)
- [x] Run replay (`POST /runs/:id/replay`)
- [x] Run diff comparison (`GET /runs/diff?a=...&b=...`)
- [x] Export (JSON/CSV), tagging, webhook management
- [x] PII sanitization with configurable payload size limiting (`BLOK_TRACE_PAYLOAD_MAX_KB`)

**Phase 2: SSE & Event Architecture** ✅
- [x] `EventSource`-based SSE client with reconnect logic
- [x] Global event stream for dashboard live feed
- [x] Per-run event stream for trace detail page
- [x] Zustand stores for connection state and notifications

**Phase 3: Studio Frontend App** ✅
- [x] Vite + React 19 + TanStack Router SPA
- [x] Dashboard with workflow cards, stats overview, live feed
- [x] Runs list with status filters, search, virtualized table
- [x] Run detail page with trace graph, timeline, node detail panel
- [x] JSON viewer, log viewer, event log, request builder
- [x] Command palette (Cmd+K) for global search
- [x] Notification system with toast UI

**Phase 4: Advanced Features** ✅
- [x] Run diff view (side-by-side comparison)
- [x] AI error explanation (`POST /runs/:id/explain`)
- [x] Metrics dashboard: execution timeline, duration distribution, node performance, workflow breakdown
- [x] Custom dashboards with draggable widget grid
- [x] Webhook management UI (create, delete, configure events)
- [x] Tag management for runs

**Phase 5: Quality & Polish** ✅
- [x] Fix all 49 Biome lint errors across 16 source files
- [x] Use semantic `<dialog>` elements for modals
- [x] ErrorBoundary component with retry, wrapping root layout
- [x] Accessibility: ARIA labels on icon buttons, `aria-hidden` on decorative elements, `aria-expanded` on collapsibles, dialog roles
- [x] Keyboard navigation support in command palette and modals

**Phase 6: Frontend Tests** ✅
- [x] Vitest + Testing Library + jsdom test infrastructure
- [x] 70 tests across 4 test files (formatters, API client, Zustand stores, React components)
- [x] TypeScript compiles cleanly, Biome lint passes
- [x] Test scripts added to `package.json` (`test`, `test:dev`)

### Pages & Routes

| Route | Description |
|-------|-------------|
| `/` | Dashboard — workflow cards, stats, live feed |
| `/runs/` | All runs — filterable, searchable, virtualized table |
| `/runs/:runId` | Run detail — trace graph, timeline, node detail, logs |
| `/runs/diff` | Run comparison — side-by-side diff view |
| `/workflows/:name` | Workflow detail — run history, configuration |
| `/metrics` | Performance analytics — charts, distributions, breakdowns |
| `/dashboards` | Custom dashboards — draggable widget grid |
| `/webhooks` | Webhook management — create, configure, delete |

### Success Metrics
- ✅ Zero external dependencies for trace observability
- ✅ Real-time updates via SSE (< 100ms event-to-render)
- ✅ 70 frontend tests passing
- ✅ Zero Biome lint errors
- ✅ Accessible UI (ARIA, keyboard navigation, semantic HTML)
- ✅ Full TypeScript strict mode compliance

---

## Technical Debt & Infrastructure

### Developer Experience

**DX-1: Hot Reload & HMR**
- [ ] Implement hot module replacement for nodes
- [ ] Add workflow hot-reload
- [ ] Add trigger hot-reload
- [ ] Add zero-downtime deployments
- [ ] Add automatic dependency watching

**DX-2: Enhanced CLI**
- [ ] Add interactive TUI for monitoring
- [x] Add workflow visualization (Blok Studio — trace graph, metrics charts)
- [ ] Add node dependency graph
- [ ] Add performance profiling
- [ ] Add cost estimation

**DX-3: IDE Integration**
- [ ] VS Code extension with debugging
- [ ] IntelliJ IDEA plugin
- [ ] Vim/Neovim plugin
- [ ] Language server protocol (LSP)
- [ ] Syntax highlighting for all languages

### Testing & Quality

**QA-1: Testing Framework**
- [ ] Unit testing utilities for nodes
- [ ] Integration testing for workflows
- [ ] End-to-end testing for triggers
- [ ] Load testing framework
- [ ] Chaos testing framework

**QA-2: Type Safety**
- [ ] Strict TypeScript across all packages
- [ ] Zod schemas for all configurations
- [ ] Runtime type validation
- [ ] GraphQL schema generation
- [ ] OpenAPI schema generation

**QA-3: Code Quality**
- [ ] Increase test coverage to 90%+
- [ ] Add mutation testing
- [ ] Add security scanning (Snyk, Dependabot)
- [ ] Add license compliance checking
- [ ] Add performance regression testing

### Performance & Scalability

**PERF-1: Optimization**
- [ ] Profile and optimize hot paths
- [ ] Reduce context serialization overhead
- [ ] Implement node result caching
- [ ] Add connection pooling for all runtimes
- [ ] Optimize Docker image sizes

**PERF-2: Observability**
- [ ] Add distributed tracing (OpenTelemetry)
- [ ] Add structured logging
- [ ] Add custom metrics
- [ ] Add APM integration (DataDog, New Relic)
- [ ] Add error tracking (Sentry)

**PERF-3: Scalability**
- [ ] Horizontal scaling for triggers
- [ ] Vertical scaling for runtimes
- [ ] Auto-scaling based on load
- [ ] Multi-region deployments
- [ ] Edge deployment support

### Documentation

**DOC-1: Content**
- [ ] Complete API reference (TypeDoc)
- [ ] Interactive tutorials
- [ ] Video course
- [ ] Architecture deep-dives
- [ ] Migration guides

**DOC-2: Examples**
- [ ] 100+ workflow examples
- [ ] Industry-specific templates (e-commerce, fintech, healthcare)
- [ ] Integration examples (Stripe, AWS, GCP, Azure)
- [ ] Performance benchmarks
- [ ] Best practices guide

**DOC-3: Community**
- [ ] Discord server
- [ ] Stack Overflow tag
- [ ] Monthly webinars
- [ ] Blog with case studies
- [ ] Podcast interviews

### Security

**SEC-1: Authentication & Authorization**
- [ ] Built-in auth middleware
- [ ] OAuth 2.0 / OIDC support
- [ ] API key management
- [ ] Role-based access control (RBAC)
- [x] Attribute-based access control (ABAC)

**SEC-2: Data Protection**
- [ ] Encryption at rest
- [ ] Encryption in transit (TLS)
- [ ] Secret management integration (Vault, AWS Secrets Manager)
- [ ] PII detection and masking
- [ ] Audit logging

**SEC-3: Compliance**
- [ ] SOC 2 compliance
- [ ] GDPR compliance toolkit
- [ ] HIPAA compliance toolkit
- [ ] ISO 27001 documentation
- [ ] Security hardening guide

### Infrastructure

**INFRA-1: Deployment**
- [ ] Kubernetes Helm charts
- [ ] Docker Compose templates
- [ ] Terraform modules
- [ ] CloudFormation templates
- [ ] ARM templates (Azure)

**INFRA-2: CI/CD**
- [ ] GitHub Actions workflows
- [ ] GitLab CI templates
- [ ] Jenkins pipelines
- [ ] CircleCI configuration
- [ ] Travis CI configuration

**INFRA-3: Monitoring**
- [ ] Prometheus exporters
- [ ] Grafana dashboards
- [ ] ELK stack integration
- [ ] CloudWatch integration
- [ ] Azure Monitor integration

---

## Timeline & Milestones

### 2026 Q1 (Jan - Mar): Foundation
**Milestone: Language-Agnostic Core + Blok Studio**
- ✅ Runtime adapter system complete
- ✅ NodeJS + Python adapters production-ready
- ✅ Docker adapter beta
- ✅ Migration path documented
- ✅ Blok Studio trace UI complete (6 phases, 70 frontend tests)

**Deliverables:**
- Runtime adapter architecture
- NodeJS runtime adapter
- Python3 runtime adapter refactored
- Docker/generic adapter
- Migration guide
- Blok Studio — real-time trace UI with dashboard, metrics, run diff, custom dashboards, webhooks

### 2026 Q2 (Apr - Jun): Modern DX
**Milestone: Function-First Architecture**
- ✅ defineNode API stable
- ✅ AI generation optimized
- ✅ 50+ function-first nodes in ecosystem
- ✅ Developer satisfaction > 8/10

**Deliverables:**
- defineNode API and documentation
- Function-first CLI templates
- AI node generation prompts
- Node migration toolkit
- Video tutorials

### 2026 Q3 (Jul - Sep): Universal Triggers
**Milestone: Production-Ready Trigger Ecosystem**
- ✅ SSE trigger (Server-Sent Events) — **completed early** (full project template, CLI integration, 49 tests)
- ✅ Queue triggers (Kafka, RabbitMQ, SQS, Redis)
- ✅ Pub/sub triggers (Redis, NATS, Google)
- ✅ Worker triggers with scheduling
- ✅ Cron triggers with timezone support
- ✅ Webhook triggers (GitHub, Stripe, Shopify)

**Deliverables:**
- SSE trigger template (complete — `blokctl create project --trigger sse`)
- Queue trigger implementations
- Pub/sub trigger implementations
- Worker trigger with dashboard
- Cron trigger with builder UI
- Webhook trigger with verification
- Trigger monitoring dashboard

### 2026 Q4 (Oct - Dec): AI-First & Multi-Language
**Milestone: AI-Powered Everything + 5+ Languages**
- ✅ AI generation success rate > 95%
- ✅ Go runtime production
- ✅ Java runtime production
- ✅ Rust runtime production
- ✅ 1000+ nodes across languages

**Deliverables:**
- Enhanced AI generation system
- Workflow generation
- Trigger generation
- Runtime adapter generation
- Go runtime SDK
- Java runtime SDK
- Rust runtime SDK
- Cross-language integration tests

### 2027 Q1 (Jan - Mar): Enterprise & Ecosystem
**Milestone: Enterprise-Ready Platform**
- ✅ 7+ languages supported
- ✅ SOC 2 compliant
- ✅ 99.99% uptime SLA
- ✅ 10,000+ active workflows
- ✅ Fortune 500 customers

**Deliverables:**
- C# / .NET runtime
- PHP runtime
- Ruby runtime
- Enterprise security features
- Multi-region deployment
- Runtime marketplace
- Enterprise support

### 2027 Q2-Q3 (Apr - Sep): Enterprise Protocol - gRPC Migration
**Milestone: Dual-Protocol Runtime Ecosystem**
- ✅ Proto v2 service definition finalized
- ✅ GrpcRuntimeAdapter in runner with fallback to HTTP
- ✅ All 7 SDKs support gRPC alongside HTTP
- ✅ Streaming support for LLM and batch nodes
- ✅ gRPC benchmarks show < 1ms per runtime hop

**Deliverables:**
- `runtime.proto` v2 with streaming, health, and node discovery RPCs
- GrpcRuntimeAdapter with deadline propagation and connection pooling
- gRPC servers in Go, Rust, Java, C#, PHP, Ruby, Python3 SDKs
- Dual-protocol Docker containers (HTTP :8080 + gRPC :50051)
- gRPC vs HTTP benchmark suite
- Cross-runtime gRPC chain E2E tests
- Enterprise deployment guide (gRPC load balancing, TLS)

---

## Success Metrics (Overall)

### Technical Excellence
- ✅ Zero breaking changes to existing workflows
- ✅ 90%+ test coverage
- ✅ < 5ms runtime adapter overhead
- ✅ 99.99% uptime
- ✅ < 100ms p99 latency

### Developer Happiness
- ✅ 95%+ AI generation success rate
- ✅ 80%+ reduction in boilerplate code
- ✅ < 5 minutes to create first workflow
- ✅ 9/10 developer satisfaction
- ✅ 50% faster development vs alternatives

### Ecosystem Growth
- ✅ 10+ languages supported
- ✅ 10+ trigger types
- ✅ 1000+ community nodes
- ✅ 10,000+ active developers
- ✅ 100+ enterprise customers

### Business Impact
- ✅ 1M+ workflow executions/month
- ✅ 10x reduction in infrastructure costs
- ✅ 5x faster time-to-market
- ✅ 99.9% fewer production incidents
- ✅ $10M+ ARR

---

## Appendix: Architecture Diagrams

### A. Runtime Adapter Architecture (Current — HTTP)
```
┌───────────────────────────────────────────────────────────────┐
│                    Workflow Orchestrator                       │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                   RuntimeRegistry                       │  │
│  │  ┌─────────────────────────────────────────────────┐   │  │
│  │  │ NodeJS | Go | Rust | Java | C# | PHP | Ruby | Py│   │  │
│  │  └─────────────────────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
     │              │         │        │       │      │      │
     ▼              ▼         ▼        ▼       ▼      ▼      ▼
┌──────────┐  ┌──────────────────────────────────────────────────┐
│  NodeJS  │  │              HttpRuntimeAdapter                   │
│ In-Proc  │  │  (Go | Rust | Java | C# | PHP | Ruby | Python3) │
│ Adapter  │  │         POST /execute, GET /health               │
└──────────┘  └──────────────────────────────────────────────────┘
     │              │         │        │       │      │      │
     ▼              ▼         ▼        ▼       ▼      ▼      ▼
┌──────────┐  ┌──────┐ ┌──────┐ ┌──────┐ ┌────┐ ┌────┐ ┌──────┐
│ TS Nodes │  │ Go   │ │ Rust │ │ Java │ │ C# │ │PHP │ │Ruby  │ ...
│  Local   │  │ :9001│ │ :9002│ │ :9003│ │9004│ │9005│ │:9006 │
└──────────┘  └──────┘ └──────┘ └──────┘ └────┘ └────┘ └──────┘
```

### A2. Runtime Adapter Architecture (Future — Dual Protocol)
```
┌───────────────────────────────────────────────────────────────┐
│                    Workflow Orchestrator                       │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                   RuntimeRegistry                       │  │
│  │  Protocol selection: HTTP (default) | gRPC (opt-in)    │  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
     │              │                    │
     ▼              ▼                    ▼
┌──────────┐  ┌──────────────┐    ┌──────────────┐
│  NodeJS  │  │  HttpRuntime │    │  GrpcRuntime │
│ In-Proc  │  │   Adapter    │    │   Adapter    │
│ Adapter  │  │ POST /execute│    │ rpc Execute  │
└──────────┘  └──────────────┘    └──────────────┘
                    │                    │
                    ▼                    ▼
              ┌──────────────────────────────┐
              │        SDK Container          │
              │  HTTP :8080  |  gRPC :50051   │
              │     Shared Node Registry      │
              └──────────────────────────────┘
```

### B. Trigger System Architecture
```
┌──────────────────────────────────────────────────┐
│              External Events                      │
│  HTTP │ gRPC │ Queue │ Pub/Sub │ Cron │ Webhook  │
└──────────────────────────────────────────────────┘
         │      │       │        │       │
         ▼      ▼       ▼        ▼       ▼
┌──────────────────────────────────────────────────┐
│              TriggerBase (Core)                   │
│  • loadNodes()     • createContext()              │
│  • loadWorkflows() • executeWorkflow()            │
└──────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│            Workflow Execution Engine              │
│  Context → Runner → Nodes → Response              │
└──────────────────────────────────────────────────┘
```

### C. Function-First Node Pattern
```
┌────────────────────────────────────────┐
│         defineNode<I, O>()             │
│  ┌──────────────────────────────────┐  │
│  │ input: ZodSchema<I>              │  │
│  │ output: ZodSchema<O>             │  │
│  │ execute(ctx, input) → output     │  │
│  └──────────────────────────────────┘  │
└────────────────────────────────────────┘
              │
              ▼ (wraps into)
┌────────────────────────────────────────┐
│    FunctionNode extends BlokService    │
│  • handle(ctx, inputs)                 │
│  • Input validation (Zod)              │
│  • Output validation (Zod)             │
│  • Error → GlobalError mapping         │
└────────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────┐
│      Backward Compatible with          │
│   Existing Runner & NodeMap            │
└────────────────────────────────────────┘
```

---

**Document Version:** 1.4.0
**Last Updated:** 2026-01-30
**Next Review:** 2026-04-27
**Owner:** Blok Core Team
**Status:** 🟢 Active Development
