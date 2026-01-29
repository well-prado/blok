# Module Reference: Advanced Features

> **Purpose:** HMR, caching, cost estimation, schema generation, visualization, profiling

## Hot Module Replacement (`core/runner/src/hmr/`)

### What It Does
Automatically reloads nodes and workflows when source files change during development. Integrated into all trigger types for zero-restart development.

### Source Files
- `FileWatcher.ts` — Monitors file system for changes (241 lines)
- `HotReloadManager.ts` — Orchestrates reload of nodes/workflows/triggers (241 lines)
- `HmrDevConsole.ts` — Dev console UI showing reload status (52 lines)

### Features
- File system watching (recursive directory monitoring)
- Selective reload (only changed modules)
- Trigger integration (all 8 trigger types support HMR)
- Dev console with status indicators
- Configurable debounce and ignore patterns

---

## Node Result Caching (`core/runner/src/cache/`)

### What It Does
Caches node execution results to avoid redundant computation. Supports in-memory and Redis backends with TTL, LRU eviction, and cache invalidation.

### Source Files
- `NodeResultCache.ts` — Full caching implementation (710 lines)

### Features
- TTL-based expiration
- LRU eviction policy
- Cache key generation from inputs
- Per-node cache configuration
- Redis backend for distributed caching
- Cache hit/miss metrics
- Manual invalidation API

---

## Cost Estimation (`core/runner/src/cost/`)

### What It Does
Estimates the cloud infrastructure cost of running workflows based on compute time, memory usage, and cloud provider pricing.

### Source Files
- `CostEstimator.ts` — Cost calculation engine (254 lines)
- `pricing.ts` — Cloud provider pricing data (184 lines)

### Features
- Per-workflow cost estimation
- Per-node cost breakdown
- Multi-cloud pricing (AWS, GCP, Azure)
- Runtime-specific costs (Lambda, Cloud Run, etc.)
- Monthly projection based on execution frequency

---

## GraphQL Schema Generation (`core/runner/src/graphql/`)

### What It Does
Auto-generates GraphQL schemas from workflow definitions, enabling GraphQL API access to Blok workflows.

### Source Files
- `GraphQLSchemaGenerator.ts` — Schema generator (540 lines)

### Features
- Generates types from workflow input/output schemas
- Creates queries and mutations from HTTP workflows
- Supports subscriptions for real-time triggers
- Outputs SDL or executable schema

---

## OpenAPI Generation (`core/runner/src/openapi/`)

### What It Does
Auto-generates OpenAPI 3.0 specifications from HTTP workflow definitions.

### Source Files
- `OpenAPIGenerator.ts` — OpenAPI spec generator (502 lines)

### Features
- Generates paths from workflow triggers
- Maps Zod/JSON schemas to OpenAPI schemas
- Supports request/response examples
- Generates authentication schemes
- Outputs JSON or YAML

---

## Workflow Visualization (`core/runner/src/visualization/`)

### What It Does
Generates visual representations of workflows as DAGs (Directed Acyclic Graphs) showing node dependencies, data flow, and execution order.

### Source Files
- `WorkflowVisualizer.ts` — Workflow graph renderer (569 lines)
- `NodeDependencyGraph.ts` — Node dependency DAG generator (516 lines)

### Features
- Mermaid.js diagram generation
- DOT format output (Graphviz)
- SVG rendering
- Interactive HTML output
- Conditional branch visualization
- Data flow annotations

---

## Performance Profiling (`core/runner/src/monitoring/PerformanceProfiler.ts`)

### What It Does
Profiles workflow execution performance, identifying bottlenecks at the node, adapter, and system level.

### Source File
- `PerformanceProfiler.ts` (309 lines)

### Features
- Per-node execution time tracking
- Memory allocation tracking
- CPU time measurement
- Runtime adapter overhead measurement
- Hot path identification
- Flame graph data export

---

## Runtime Marketplace (`core/runner/src/marketplace/`)

### What It Does
Provides runtime discovery, catalog, auto-scaling, health monitoring, and metrics dashboard for managing runtime adapters at scale.

### Source Files
- `RuntimeCatalog.ts` — Available runtimes catalog (457 lines)
- `RuntimeDiscovery.ts` — Auto-discovers available runtimes (291 lines)
- `RuntimeAutoScaler.ts` — Scales runtimes based on load (484 lines)
- `RuntimeHealthMonitor.ts` — Monitors runtime health (308 lines)
- `RuntimeMetricsDashboard.ts` — Runtime metrics aggregation (414 lines)

---

## Benchmarks (`benchmarks/`)

### Source Files
- `runner-benchmark.mjs` — Runner performance benchmarks (250 lines)
- `memory-check.mjs` — Memory usage analysis (117 lines)

---

## What to Document

1. **HMR setup** — Enabling hot reload in development
2. **Caching configuration** — TTL, LRU, Redis setup
3. **Cost estimation** — Using the CLI and API
4. **GraphQL generation** — Generating and serving GraphQL schemas
5. **OpenAPI generation** — Generating and serving OpenAPI specs
6. **Workflow visualization** — Generating diagrams
7. **Performance profiling** — Identifying bottlenecks
8. **Runtime marketplace** — Discovering and managing runtimes
