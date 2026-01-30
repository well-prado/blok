# Module Reference: Core Runner

> **Package:** `@blok/runner`
> **Path:** `core/runner/`
> **Purpose:** The workflow execution engine — the heart of Blok

## What It Does

The Runner is the core engine that takes a workflow definition (JSON), resolves each node in sequence, executes them through the appropriate runtime adapter, passes data via the Context object, evaluates conditions, and returns the final response.

## Source Directory Structure

```
core/runner/src/
├── index.ts                    # Main exports (Runner, BlokService, TriggerBase, etc.)
├── Configuration.ts            # Workflow configuration model
├── ConfigurationResolver.ts    # Config resolution logic
├── BlokService.ts              # Core blok abstraction (base class for nodes)
├── BlokResponse.ts      # Response object wrapper
├── Runner.ts                   # Main workflow runner orchestrator
├── RunnerNode.ts               # Individual node execution wrapper
├── RunnerNodeBase.ts           # Base class for runner nodes
├── RunnerSteps.ts              # Step-by-step execution logic
├── RuntimeAdapterNode.ts       # Adapter node for multi-runtime support
├── RuntimeRegistry.ts          # Registry for runtime adapters
├── TriggerBase.ts              # Base class for ALL triggers
├── ResolverBase.ts             # Base resolver for configuration
├── defineNode.ts               # Function-first node definition API
├── NodeMap.ts                  # Node dependency/mapping registry
├── NodeRuntime.ts              # Node runtime lifecycle
├── NodeGrpcClient.ts           # gRPC client for cross-runtime calls
├── NodeGrpcNativeClient.ts     # Native gRPC client variant
├── DefaultLogger.ts            # Default logging implementation
├── LocalStorage.ts             # Local storage utilities
├── MemoryUsage.ts              # Memory tracking
│
├── adapters/                   # Multi-runtime execution adapters
│   ├── RuntimeAdapter.ts       # Abstract interface (RuntimeAdapter, RuntimeKind, ExecutionResult)
│   ├── NodeJsRuntimeAdapter.ts # In-process Node.js/TypeScript execution
│   ├── BunRuntimeAdapter.ts    # Bun runtime adapter
│   ├── Python3RuntimeAdapter.ts# Python 3 via gRPC
│   ├── DockerRuntimeAdapter.ts # Docker container-based execution
│   └── WasmRuntimeAdapter.ts   # WebAssembly execution
│
├── cache/                      # Node result caching
│   ├── NodeResultCache.ts      # In-memory/Redis cache with TTL, LRU, invalidation
│   └── index.ts
│
├── cost/                       # Cloud cost estimation
│   ├── CostEstimator.ts        # Estimates workflow execution costs
│   ├── pricing.ts              # Cloud provider pricing data
│   └── index.ts
│
├── graphql/                    # Schema generation
│   └── GraphQLSchemaGenerator.ts # Auto-generates GraphQL schemas from workflows
│
├── hmr/                        # Hot Module Replacement
│   ├── FileWatcher.ts          # File system watcher (chokidar-like)
│   ├── HotReloadManager.ts     # Orchestrates hot-reload of nodes/workflows
│   ├── HmrDevConsole.ts        # Dev console UI for HMR status
│   └── index.ts
│
├── integrations/               # External service integrations
│   ├── APMIntegration.ts       # Application Performance Monitoring (DataDog, New Relic)
│   ├── AzureMonitorIntegration.ts # Azure Monitor metrics/logs
│   ├── CloudWatchIntegration.ts   # AWS CloudWatch metrics/logs
│   ├── SentryIntegration.ts    # Sentry error tracking
│   └── index.ts
│
├── marketplace/                # Runtime discovery and scaling
│   ├── RuntimeCatalog.ts       # Available runtimes catalog
│   ├── RuntimeDiscovery.ts     # Runtime auto-discovery
│   ├── RuntimeAutoScaler.ts    # Auto-scaling based on load
│   ├── RuntimeHealthMonitor.ts # Runtime health monitoring
│   └── RuntimeMetricsDashboard.ts # Metrics dashboard data
│
├── monitoring/                 # Observability subsystem
│   ├── CircuitBreaker.ts       # Circuit breaker pattern for node failures
│   ├── DistributedTracer.ts    # OpenTelemetry distributed tracing
│   ├── HealthCheck.ts          # Health check endpoint handler
│   ├── PerformanceProfiler.ts  # Workflow performance profiling
│   ├── PrometheusBootstrap.ts  # Prometheus metrics initialization
│   ├── PrometheusMetricsBridge.ts # Bridge between Blok metrics and Prometheus
│   ├── RateLimiter.ts          # Token bucket rate limiter
│   ├── StructuredLogger.ts     # JSON structured logging (ELK/Loki compatible)
│   ├── TracingBootstrap.ts     # OpenTelemetry tracing setup
│   ├── TriggerMetricsCollector.ts # Trigger-specific metrics
│   └── index.ts
│
├── openapi/                    # API spec generation
│   ├── OpenAPIGenerator.ts     # Auto-generates OpenAPI 3.0 specs from workflows
│   └── index.ts
│
├── security/                   # Enterprise security features
│   ├── ABAC.ts                 # Attribute-Based Access Control
│   ├── RBAC.ts                 # Role-Based Access Control
│   ├── AuthMiddleware.ts       # JWT/API key authentication
│   ├── OAuthProvider.ts        # OAuth 2.0 / OIDC provider
│   ├── SecretManager.ts        # Vault, AWS SM, GCP SM, Azure KV integration
│   ├── AuditLogger.ts          # Audit trail logging
│   ├── EncryptionAtRest.ts     # Data encryption at rest (AES-256)
│   ├── PIIDetector.ts          # PII detection and redaction
│   ├── TLSConfig.ts            # TLS/mTLS configuration
│   └── index.ts
│
├── testing/                    # Testing framework
│   ├── TestHarness.ts          # Node and workflow test harness
│   ├── TestLogger.ts           # Test-specific logger (captures logs)
│   ├── WorkflowTestRunner.ts   # Runs workflows in test mode
│   └── index.ts
│
├── visualization/              # Visual tools
│   ├── NodeDependencyGraph.ts  # Generates node dependency DAGs
│   └── WorkflowVisualizer.ts   # Generates workflow visual representations
│
├── types/                      # TypeScript type definitions (18 files)
│   ├── Config.ts, Flow.ts, GlobalOptions.ts, Node.ts, Trigger.ts, etc.
│
└── gen/                        # Generated protobuf code
    └── node_pb.ts
```

## Key APIs

### Runner (main orchestrator)
- **File:** `Runner.ts`
- **Purpose:** Takes a workflow config and context, executes each step in order
- **Used by:** All triggers

### defineNode (function-first API)
- **File:** `defineNode.ts`
- **Purpose:** Modern, declarative way to create nodes with Zod schemas
- **Signature:**
```typescript
defineNode<I, O>({
  name: string;
  description: string;
  input: ZodSchema<I>;
  output: ZodSchema<O>;
  execute: (ctx: Context, input: I) => Promise<O>;
})
```

### TriggerBase (trigger foundation)
- **File:** `TriggerBase.ts`
- **Purpose:** Base class all triggers extend. Provides workflow/node loading, context creation, execution
- **Key methods:** `loadNodes()`, `loadWorkflows()`, `createContext()`, `executeWorkflow()`

### RuntimeRegistry (multi-runtime)
- **File:** `RuntimeRegistry.ts`
- **Purpose:** Registry for runtime adapters. Maps RuntimeKind → RuntimeAdapter
- **Key methods:** `register(adapter)`, `get(kind)`, `has(kind)`, `list()`

### RuntimeAdapter (adapter interface)
- **File:** `adapters/RuntimeAdapter.ts`
- **Types:** `RuntimeKind` = `nodejs | bun | python3 | go | java | rust | php | csharp | docker | wasm`
- **Interface:** `{ kind: RuntimeKind; execute(node, ctx): Promise<ExecutionResult> }`

## Configuration

- **File:** `Configuration.ts`
- **Purpose:** Parses workflow JSON files, resolves node types, and provides the execution plan
- **Key fields:** `nodeTypes()`, `workflowSteps()`, `triggers`

## Tests

- **Unit tests:** `core/runner/__tests__/unit/` (defineNode, CircuitBreaker, HealthCheck, RateLimiter, etc.)
- **Integration tests:** `core/runner/__tests__/integration/` (cross-runtime, Docker, multi-runtime, marketplace)
- **Adapter tests:** `core/runner/src/adapters/__tests__/` (one per adapter)
- **Subsystem tests:** `core/runner/src/__tests__/` (cache, hmr, integrations, openapi, security, testing, visualization)

## Dependencies

- `@blok/shared` (types, base classes)
- `@blok/helper` (workflow builder)
- `@connectrpc/connect` (gRPC)
- `@grpc/grpc-js` (native gRPC)
- `zod` (schema validation)
- `@opentelemetry/api` (tracing)
- `lodash`, `uuid`, `yaml`, `fast-xml-parser`

## What to Document

1. **How the Runner executes a workflow** (step-by-step lifecycle)
2. **defineNode API** (complete reference with examples)
3. **TriggerBase** (how to build custom triggers)
4. **RuntimeRegistry** (how to register and use adapters)
5. **Each adapter** (configuration, limitations, performance)
6. **Each subsystem** (caching, monitoring, security, testing, etc.)
7. **Configuration options** (all env vars, config fields)
