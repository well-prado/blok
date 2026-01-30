# Blok Studio: Real-Time Workflow Trace UI — Feature Roadmap

> **Vision:** Build a Trigger.dev-quality, real-time workflow execution tracing UI that gives developers full visibility into every workflow run, node-by-node, with live streaming, detailed inspection, and beautiful UX — all launchable from the Blok CLI.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Competitive Landscape & Inspiration](#competitive-landscape--inspiration)
3. [Architecture Decisions](#architecture-decisions)
4. [Phase 1: Backend — Run Tracking & Event System](#phase-1-backend--run-tracking--event-system)
5. [Phase 2: Trace API — HTTP & SSE Endpoints](#phase-2-trace-api--http--sse-endpoints)
6. [Phase 3: Frontend — Blok Studio App](#phase-3-frontend--blok-studio-app)
7. [Phase 4: CLI Integration — `nanoctl trace`](#phase-4-cli-integration--nanoctl-trace)
8. [Phase 5: Advanced Features — Trigger.dev-Level Polish](#phase-5-advanced-features--triggerddev-level-polish)
9. [Phase 6: Persistence & Scale](#phase-6-persistence--scale)
10. [Technical Specifications](#technical-specifications)
11. [Timeline & Milestones](#timeline--milestones)
12. [Success Metrics](#success-metrics)
13. [Appendix: Research & Inspiration](#appendix-research--inspiration)

---

## Executive Summary

### What We're Building

**Blok Studio** — a standalone, browser-based developer tool that provides real-time visibility into workflow executions. Think of it as a combination of:

- **Trigger.dev's Run View** — Live trace timeline with hierarchical spans, auto-instrumented OpenTelemetry
- **n8n's Execution Inspector** — Click into any node to see inputs/outputs/errors
- **Temporal's Event History** — Complete, replayable event log of every execution
- **Prisma Studio's Simplicity** — Launched with a single CLI command, zero configuration

### Why This Matters

1. **Debugging is painful today** — Developers rely on `console.log` and terminal output. No visual trace.
2. **Multi-language workflows are opaque** — When a chain crosses NodeJS → Go → Python → Rust, there's no unified view of what happened.
3. **Trigger testing is blind** — Cron, Queue, Worker, and Webhook triggers execute without visibility.
4. **Competitive gap** — Every major workflow platform (Trigger.dev, Temporal, Inngest, n8n, Dagster) has a trace UI. Blok doesn't.

### What Already Exists in Blok

The codebase has excellent hooks for instrumentation:

- **OpenTelemetry** — `DistributedTracer` with workflow/node span creation (`core/runner/src/monitoring/DistributedTracer.ts`)
- **Prometheus Metrics** — `PrometheusMetricsBridge` with execution counters, duration histograms, percentiles (`core/runner/src/monitoring/PrometheusMetricsBridge.ts`)
- **Structured Logging** — `StructuredLogger` with JSON output and trace context correlation (`core/runner/src/monitoring/StructuredLogger.ts`)
- **Monitoring Stack** — Prometheus, Grafana, Loki, Tempo all configured (`infra/metrics/`)
- **Health/Rate/Circuit** — HealthCheck, RateLimiter, CircuitBreaker built into TriggerBase
- **HTTP Trigger** — Already has OTel tracing with `tracer.startActiveSpan()` per workflow

What's **missing** is a developer-facing UI that consumes this data in real-time.

---

## Competitive Landscape & Inspiration

### Trigger.dev (Primary Inspiration)

| Feature | Details |
|---------|---------|
| **Architecture** | Remix (React) + Express + PostgreSQL + Prisma + Redis |
| **Real-time** | Electric SQL (HTTP-based PostgreSQL sync) for live run updates |
| **Tracing** | OpenTelemetry-powered spans with auto-instrumentation |
| **Frontend Hooks** | `@trigger.dev/react-hooks` with `useRealtimeRun`, `useRealtimeRunsWithTag` |
| **Key UX** | Live run page shows trace timeline as execution happens; hierarchical span view; auto-correlated logs from subtasks |
| **Unique** | Pending spans (OTel doesn't support natively — they extended it); Public Access Tokens for frontend subscriptions |

**What to adopt:** Trace timeline layout, span hierarchy, live status updates, OpenTelemetry-first approach.

### Temporal.io

| Feature | Details |
|---------|---------|
| **Event History** | Complete event log with every state transition, input/output payloads |
| **Web UI** | Compact/timeline view, JSON payload inspector, workflow graph visualization |
| **Key UX** | Every workflow has a complete audit trail; searchable by workflow ID, type, status |

**What to adopt:** Event history completeness, payload inspection panel, search/filter patterns.

### Inngest

| Feature | Details |
|---------|---------|
| **Step Functions** | Each step is individually traceable with its own retry/timeout |
| **Dashboard** | Function-centric view with step timeline, event history |
| **Key UX** | Clean step-by-step visualization, event-driven architecture visibility |

**What to adopt:** Step-centric timeline, clean event → function → step hierarchy.

### n8n

| Feature | Details |
|---------|---------|
| **Execution View** | Click any node to inspect input/output data, timing |
| **Key UX** | Same visual canvas for building and debugging; replay single nodes |
| **Limitation** | Real-time visualization only works for manually triggered workflows (community requested for server-side triggers) |

**What to adopt:** Node-level input/output inspection, single-step replay concept.

### Dagster

| Feature | Details |
|---------|---------|
| **Gantt Chart** | Parallel execution visualization with time-aligned bars |
| **Asset Lineage** | Data flow tracking across the entire pipeline |
| **Key UX** | Rich metadata, branch deployments for testing |

**What to adopt:** Gantt-style parallel execution visualization, metadata richness.

### Windmill

| Feature | Details |
|---------|---------|
| **Real-time Panel** | Logs + Result + Metrics in split pane during execution |
| **DAG Compilation** | Workflows compiled to DAG at submission; each node executes in isolation |
| **Key UX** | Tight feedback loop — see logs, JSON output, and memory metrics live |

**What to adopt:** Split-pane design (logs + result + metrics), memory/CPU metrics per node.

---

## Architecture Decisions

### Decision 1: Frontend Framework

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **TanStack Start** | Vite-powered, SSR optional, SPA mode, type-safe routing, full TanStack ecosystem | RC status (late 2025), smaller community, docs still maturing | **Recommended** |
| **Vite + React SPA** | Simple, mature, no SSR overhead, fast dev server | No server functions, manual routing setup | Good fallback |
| **Next.js** | Mature, large ecosystem, RSC | Vendor concerns (Vercel), heavier, opinionated | Over-engineered for dev tool |
| **Remix** | What Trigger.dev uses, full-stack | Migration to React Router v7, uncertain future | Risky bet |

**Decision:** **TanStack Start in SPA mode** — It's built on Vite (fast), supports SPA mode for dev tools that don't need SSR, integrates perfectly with TanStack Query (real-time data) and TanStack Table (run lists). The SPA can be bundled and served by the Blok CLI without a separate server.

### Decision 2: Real-time Communication

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **SSE (Server-Sent Events)** | Unidirectional (perfect for traces), auto-reconnect, HTTP-native, simple | No bidirectional, 6 connection limit per domain | **Primary** |
| **WebSocket** | Bidirectional, low latency | Requires separate server, more complex | For future bidirectional features |
| **Polling** | Simplest, works everywhere | High latency, wasteful | Fallback only |

**Decision:** **SSE as primary** — Trace data flows one direction (server → client). SSE auto-reconnects on network drops, works with standard HTTP infrastructure, and is simpler to implement than WebSockets. Add WebSocket support later if we need bidirectional features (pause/cancel from UI).

### Decision 3: Workflow Graph Visualization

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **React Flow (xyflow)** | Production-ready, customizable nodes/edges, zoom/pan, minimap, TypeScript | Commercial license for some features | **Recommended** |
| **Dagre + D3** | Full control, lightweight | More code, no built-in interaction | For custom layouts |
| **ELK.js** | Best auto-layout algorithm | Complex API, larger bundle | Optional layout engine |

**Decision:** **React Flow (xyflow)** with Dagre layout — React Flow provides the interactive canvas (zoom, pan, select), while Dagre handles automatic DAG layout. Custom node components render real-time status (pending/running/completed/failed).

### Decision 4: Trace Data Storage

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **In-memory (v1)** | Zero setup, fast, dev-only | Lost on restart, limited retention | **Phase 1** |
| **SQLite** | File-based, no server, persistent | Single-writer, limited concurrency | **Phase 2** |
| **PostgreSQL** | Full ACID, scalable, what Trigger.dev uses | Requires running database | **Phase 3** |

**Decision:** **Start in-memory, graduate to SQLite, then PostgreSQL** — For local development, in-memory is perfect. SQLite adds persistence without infrastructure. PostgreSQL for production/cloud deployments.

### Decision 5: UI Component Library

**Decision:** **shadcn/ui + Tailwind CSS + Radix UI primitives** — This is the modern standard for developer tools. shadcn/ui components are copy-paste (no dependency), Tailwind for styling, Radix for accessibility.

---

## Phase 1: Backend — Run Tracking & Event System

### Objective

Instrument the Blok runner to emit structured execution events without changing existing workflow behavior. All events are stored in-memory and emitted via an EventEmitter for downstream consumers (API, SSE).

### 1.1 Core Types

**Location:** `core/runner/src/tracing/types.ts`

```typescript
// === Run Lifecycle ===

export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface WorkflowRun {
  id: string;                    // UUID
  workflowName: string;          // e.g. "countries"
  workflowPath: string;          // e.g. "workflows/json/countries.json"
  triggerType: string;           // "http" | "grpc" | "cron" | "queue" | "worker" | ...
  triggerSummary: string;        // e.g. "GET /countries" or "cron: */5 * * * *"
  status: WorkflowRunStatus;
  startedAt: number;             // ms timestamp
  finishedAt?: number;
  durationMs?: number;
  error?: {
    message: string;
    code?: string;
    stack?: string;
  };
  tags?: string[];               // User-defined tags
  metadata?: Record<string, unknown>; // Custom metadata
  nodeCount: number;             // Total nodes in workflow
  completedNodes: number;        // Nodes finished so far
}

// === Node Lifecycle ===

export type NodeRunStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface NodeRun {
  id: string;                    // UUID
  runId: string;                 // Parent WorkflowRun.id
  nodeName: string;              // e.g. "fetch-user"
  nodeType: string;              // "module" | "local" | "runtime.go" | ...
  runtimeKind?: string;          // "nodejs" | "go" | "python3" | ...
  status: NodeRunStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  inputs?: unknown;              // Resolved inputs (sanitized)
  outputs?: unknown;             // Node output data (sanitized)
  error?: {
    message: string;
    code?: string;
    stack?: string;
  };
  parentNodeId?: string;         // For nested/flow nodes
  depth: number;                 // Nesting depth (0 = top-level)
  stepIndex: number;             // Order in workflow
  metrics?: {
    duration_ms?: number;
    cpu_ms?: number;
    memory_bytes?: number;
  };
}

// === Events ===

export type RunEventType =
  | "RUN_STARTED"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "NODE_STARTED"
  | "NODE_COMPLETED"
  | "NODE_FAILED"
  | "NODE_SKIPPED"
  | "VARS_UPDATED"
  | "LOG_ENTRY";

export interface RunEvent {
  id: string;                    // Event UUID
  type: RunEventType;
  runId: string;
  workflowName: string;
  timestamp: number;
  nodeName?: string;
  nodeId?: string;
  payload?: unknown;             // Event-specific data
}

// === Log Entry ===

export interface LogEntry {
  id: string;
  runId: string;
  nodeId?: string;
  nodeName?: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}
```

### 1.2 RunTracker — In-Memory Event Store

**Location:** `core/runner/src/tracing/RunTracker.ts`

```typescript
import { EventEmitter } from "events";

class RunTracker extends EventEmitter {
  private runs: Map<string, WorkflowRun> = new Map();
  private nodeRuns: Map<string, NodeRun[]> = new Map();  // runId → NodeRun[]
  private events: Map<string, RunEvent[]> = new Map();   // runId → RunEvent[]
  private logs: Map<string, LogEntry[]> = new Map();     // runId → LogEntry[]
  private maxRuns: number = 1000;                        // Retention limit

  // Singleton
  static getInstance(): RunTracker;

  // === Workflow Lifecycle ===
  startRun(opts: Omit<WorkflowRun, "id" | "status" | "startedAt" | "completedNodes">): WorkflowRun;
  completeRun(runId: string, data?: unknown): void;
  failRun(runId: string, error: Error): void;

  // === Node Lifecycle ===
  startNode(runId: string, opts: Omit<NodeRun, "id" | "status" | "startedAt">): NodeRun;
  completeNode(nodeRunId: string, outputs?: unknown, metrics?: NodeRun["metrics"]): void;
  failNode(nodeRunId: string, error: Error): void;
  skipNode(nodeRunId: string, reason?: string): void;

  // === Logging ===
  addLog(entry: Omit<LogEntry, "id" | "timestamp">): void;

  // === Queries ===
  getRun(runId: string): WorkflowRun | undefined;
  getRuns(opts?: { workflow?: string; status?: WorkflowRunStatus; limit?: number; offset?: number }): WorkflowRun[];
  getNodeRuns(runId: string): NodeRun[];
  getEvents(runId: string, since?: number): RunEvent[];
  getLogs(runId: string, nodeId?: string): LogEntry[];

  // === Metadata ===
  getWorkflowSummaries(): WorkflowSummary[];  // Aggregated stats per workflow

  // === Cleanup ===
  private evictOldRuns(): void;  // Keep only maxRuns
}
```

### 1.3 Instrumentation Points

**A. TriggerBase — Workflow-Level Tracking**

Hook into `TriggerBase.run()` to wrap workflow execution:

```typescript
// Before workflow execution
const run = tracker.startRun({
  workflowName: ctx.workflow_name,
  workflowPath: ctx.workflow_path,
  triggerType: this.triggerType,           // "http", "grpc", "cron", etc.
  triggerSummary: this.buildTriggerSummary(ctx),
  nodeCount: steps.length,
});
ctx._traceRunId = run.id;  // Attach to context for downstream use

// After workflow execution (success)
tracker.completeRun(run.id);

// After workflow execution (failure)
tracker.failRun(run.id, error);
```

**B. RunnerSteps — Node-Level Tracking**

Hook into `runSteps()` to wrap each step:

```typescript
// Before each step.process(ctx)
const nodeRun = tracker.startNode(ctx._traceRunId, {
  nodeName: step.name,
  nodeType: step.type,
  runtimeKind: step.runtimeKind,
  inputs: sanitize(ctx.config[step.name]?.inputs),
  depth: deep,
  stepIndex: index,
});

// After step success
tracker.completeNode(nodeRun.id, sanitize(ctx.response.data), step.metrics);

// After step failure
tracker.failNode(nodeRun.id, error);
```

**C. Runtime Adapters — Cross-Language Tracking**

Wrap adapter `execute()` calls to capture runtime-specific metrics:

```typescript
// In HttpRuntimeAdapter.execute()
const nodeRun = tracker.getActiveNode(ctx._traceRunId, node.name);
// ... execution ...
tracker.completeNode(nodeRun.id, result.data, result.metrics);
```

**D. Log Integration**

Bridge `StructuredLogger` to RunTracker:

```typescript
// In StructuredLogger transport
if (ctx._traceRunId) {
  tracker.addLog({
    runId: ctx._traceRunId,
    nodeId: ctx._traceNodeId,
    level: entry.level,
    message: entry.message,
    data: entry.fields,
  });
}
```

### Implementation Tasks

- [ ] Create `core/runner/src/tracing/types.ts` — All type definitions
- [ ] Create `core/runner/src/tracing/RunTracker.ts` — In-memory event store with EventEmitter
- [ ] Create `core/runner/src/tracing/sanitize.ts` — Input/output sanitization (PII, size limits)
- [ ] Instrument `TriggerBase.ts` — Workflow-level run start/complete/fail
- [ ] Instrument `RunnerSteps.ts` — Node-level start/complete/fail/skip
- [ ] Instrument `RuntimeAdapterNode.ts` — Runtime-specific metrics capture
- [ ] Bridge `StructuredLogger.ts` → RunTracker for log correlation
- [ ] Add `_traceRunId` and `_traceNodeId` to Context type (internal fields)
- [ ] Export RunTracker from `core/runner/src/index.ts`
- [ ] Unit tests for RunTracker (50+ test cases)
- [ ] Unit tests for instrumentation hooks (non-regression)
- [ ] Ensure zero overhead when no listeners attached (no-op fast path)

### Success Criteria

- Zero breaking changes to existing workflows
- < 1ms overhead per node execution when tracking enabled
- All trigger types emit events (HTTP, gRPC, Cron, Queue, Worker, WebSocket, SSE, Webhook)
- Events correctly correlate across multi-language runtime chains

---

## Phase 2: Trace API — HTTP & SSE Endpoints

### Objective

Expose RunTracker data via REST and SSE endpoints under a reserved path prefix (`/__blok`), directly in the existing HTTP trigger server.

### 2.1 API Design

**Base path:** `/__blok` (reserved, never conflicts with workflow routes)

#### REST Endpoints

```
GET  /__blok/workflows
     → WorkflowSummary[]
     Summary of all known workflows with run statistics

GET  /__blok/workflows/:name
     → WorkflowDetail
     Workflow definition + aggregated metrics

GET  /__blok/workflows/:name/runs
     → { runs: WorkflowRun[], total: number, page: number }
     Paginated runs for a workflow
     Query: ?status=running|completed|failed&limit=50&offset=0

GET  /__blok/runs
     → { runs: WorkflowRun[], total: number, page: number }
     All runs across all workflows
     Query: ?status=...&workflow=...&trigger=...&limit=50&offset=0&sort=desc

GET  /__blok/runs/:runId
     → { run: WorkflowRun, nodes: NodeRun[], logs: LogEntry[] }
     Full run detail with all node runs and logs

GET  /__blok/runs/:runId/events
     → RunEvent[]
     All events for a run (for completed runs)
     Query: ?since=<timestamp> for incremental fetch
```

#### SSE Endpoints

```
GET  /__blok/runs/:runId/stream
     → SSE stream of RunEvent objects
     Content-Type: text/event-stream
     Events: RUN_STARTED, NODE_STARTED, NODE_COMPLETED, NODE_FAILED,
             RUN_COMPLETED, RUN_FAILED, VARS_UPDATED, LOG_ENTRY
     Auto-closes when run finishes

GET  /__blok/stream
     → SSE stream of ALL RunEvents (global feed)
     Content-Type: text/event-stream
     For the dashboard "live" view
     Query: ?workflows=countries,db-manager (filter by workflow name)
```

#### Utility Endpoints

```
GET  /__blok/health
     → { status: "ok", version: string, uptime: number, activeRuns: number }

GET  /__blok/config
     → { workflows: string[], triggers: string[], runtimes: string[] }
     Discovery endpoint for the UI

DELETE /__blok/runs
     → { deleted: number }
     Clear all run history (dev convenience)
```

### 2.2 SSE Event Format

```
event: NODE_STARTED
id: evt_abc123
data: {"type":"NODE_STARTED","runId":"run_xyz","nodeName":"fetch-user","nodeType":"module","timestamp":1706572800000}

event: NODE_COMPLETED
id: evt_abc124
data: {"type":"NODE_COMPLETED","runId":"run_xyz","nodeName":"fetch-user","durationMs":42,"timestamp":1706572800042}

event: LOG_ENTRY
id: evt_abc125
data: {"type":"LOG_ENTRY","runId":"run_xyz","nodeName":"fetch-user","level":"info","message":"User found","timestamp":1706572800030}
```

Each SSE event includes:
- `event:` — Event type (for `EventSource` filtering)
- `id:` — Unique event ID (for reconnection with `Last-Event-ID`)
- `data:` — JSON payload

### 2.3 Response Types

```typescript
interface WorkflowSummary {
  name: string;
  path: string;
  triggerTypes: string[];       // ["http", "cron"]
  totalRuns: number;
  recentRuns: number;           // Last 24h
  lastRunAt?: number;
  lastRunStatus?: WorkflowRunStatus;
  errorRate: number;            // 0.0 - 1.0
  avgDurationMs: number;
  p95DurationMs: number;
}

interface WorkflowDetail extends WorkflowSummary {
  definition: unknown;           // Raw workflow JSON
  nodeNames: string[];           // All node names in workflow
  runtimes: string[];            // Runtime kinds used
}
```

### Implementation Tasks

- [ ] Create `core/runner/src/tracing/TraceRouter.ts` — Express router for `/__blok/*`
- [ ] Implement REST endpoints (workflows, runs, events)
- [ ] Implement SSE endpoint with EventSource-compatible streaming
- [ ] Add `Last-Event-ID` support for SSE reconnection
- [ ] Add CORS headers for cross-origin access (UI on different port)
- [ ] Add request ID tracking for API calls
- [ ] Register `TraceRouter` in `HttpTrigger.ts` (before workflow routes)
- [ ] Register `TraceRouter` in `GrpcTrigger.ts` (HTTP sidecar)
- [ ] Add pagination, filtering, and sorting to list endpoints
- [ ] Integration tests for all endpoints
- [ ] SSE connection management (cleanup on disconnect, heartbeat)
- [ ] Rate limiting on trace API (prevent abuse)
- [ ] Input/output payload size limiting (configurable, default 10KB)

### Success Criteria

- All endpoints return correct data within 10ms (in-memory)
- SSE events arrive within 5ms of emission
- SSE auto-reconnection works correctly (client receives missed events via `Last-Event-ID`)
- Zero impact on workflow execution performance
- CORS properly configured for local development

---

## Phase 3: Frontend — Blok Studio App

### Objective

Build a standalone React application (`apps/studio`) that consumes the `/__blok` API to provide a beautiful, real-time workflow tracing experience.

### 3.1 Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Framework** | TanStack Start (SPA mode) | Vite-powered, type-safe routing, TanStack ecosystem |
| **Routing** | TanStack Router | File-based, type-safe params, nested layouts |
| **Data Fetching** | TanStack Query | Auto-refetch, caching, SSE integration |
| **Tables** | TanStack Table | Sortable, filterable, virtualized run lists |
| **Virtualization** | TanStack Virtual | Handle 10,000+ events without lag |
| **Graph** | React Flow (xyflow) + Dagre | Interactive workflow DAG with auto-layout |
| **Components** | shadcn/ui | Copy-paste, Radix-based, accessible |
| **Styling** | Tailwind CSS | Utility-first, consistent design system |
| **Icons** | Lucide React | Consistent, tree-shakeable |
| **State** | Zustand | Lightweight global state (active connections, preferences) |
| **Charts** | Recharts or Tremor | Metrics visualization |

### 3.2 App Structure

```
apps/studio/
├── app/
│   ├── routes/
│   │   ├── __root.tsx              # Root layout (sidebar + header)
│   │   ├── index.tsx               # Dashboard (workflow list)
│   │   ├── workflows/
│   │   │   ├── $name.tsx           # Workflow detail (runs table)
│   │   │   └── $name.definition.tsx # Workflow JSON viewer
│   │   ├── runs/
│   │   │   └── $runId.tsx          # Run trace view (main feature)
│   │   └── settings.tsx            # Studio preferences
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx         # Navigation sidebar
│   │   │   ├── Header.tsx          # Top bar with breadcrumbs
│   │   │   └── StatusBar.tsx       # Bottom bar (connection status)
│   │   ├── dashboard/
│   │   │   ├── WorkflowCard.tsx    # Workflow summary card
│   │   │   ├── LiveFeed.tsx        # Global event feed
│   │   │   └── StatsOverview.tsx   # Aggregate metrics
│   │   ├── runs/
│   │   │   ├── RunsTable.tsx       # Paginated runs table
│   │   │   ├── RunStatusBadge.tsx  # Status pill component
│   │   │   └── RunFilters.tsx      # Filter/search bar
│   │   ├── trace/
│   │   │   ├── TraceTimeline.tsx   # Waterfall timeline (main)
│   │   │   ├── TraceGraph.tsx      # React Flow DAG view
│   │   │   ├── NodeDetail.tsx      # Node inspection panel
│   │   │   ├── EventLog.tsx        # Chronological event list
│   │   │   ├── LogViewer.tsx       # Structured log viewer
│   │   │   ├── PayloadInspector.tsx # JSON input/output viewer
│   │   │   └── MetricsPanel.tsx    # Node metrics (duration, CPU, memory)
│   │   └── shared/
│   │       ├── JsonViewer.tsx      # Pretty JSON with syntax highlighting
│   │       ├── DurationBadge.tsx   # "42ms" formatted badge
│   │       ├── RelativeTime.tsx    # "2 seconds ago" component
│   │       └── EmptyState.tsx      # Empty state illustrations
│   ├── hooks/
│   │   ├── useTraceStream.ts       # SSE connection for run events
│   │   ├── useGlobalStream.ts      # SSE connection for all events
│   │   ├── useWorkflows.ts         # TanStack Query for workflow list
│   │   ├── useRuns.ts              # TanStack Query for runs
│   │   ├── useRunDetail.ts         # TanStack Query for single run
│   │   └── useKeyboardNav.ts       # Keyboard navigation
│   ├── lib/
│   │   ├── api.ts                  # API client (fetch wrapper)
│   │   ├── sse.ts                  # SSE client with reconnection
│   │   ├── graph-layout.ts         # Dagre layout for React Flow
│   │   ├── formatters.ts           # Duration, bytes, date formatting
│   │   └── constants.ts            # Status colors, event types
│   └── stores/
│       ├── connection.ts           # SSE connection state (Zustand)
│       └── preferences.ts          # Theme, layout preferences
├── public/
│   └── favicon.svg
├── app.config.ts                   # TanStack Start config (SPA mode)
├── package.json
├── tailwind.config.ts
└── tsconfig.json
```

### 3.3 Page Designs

#### Page 1: Dashboard (`/`)

```
┌─────────────────────────────────────────────────────────────┐
│  🔲 Blok Studio           [🔴 2 running]  [⚙️ Settings]   │
├──────────┬──────────────────────────────────────────────────┤
│          │                                                  │
│ Workflows│  📊 Overview                                    │
│          │  ┌─────────┐ ┌─────────┐ ┌─────────┐          │
│ > All    │  │ Total   │ │ Active  │ │ Errors  │          │
│   HTTP   │  │   147   │ │    2    │ │   3.2%  │          │
│   Cron   │  └─────────┘ └─────────┘ └─────────┘          │
│   Queue  │                                                  │
│   Worker │  Workflows                      [🔍 Search...]  │
│          │  ┌──────────────────────────────────────────┐   │
│          │  │ countries        HTTP  ●  2ms   0% err   │   │
│ Live Feed│  │ db-manager       HTTP  ●  45ms  1.2% err │   │
│          │  │ sync-users       Cron  ●  120ms 0% err   │   │
│ ● run_a  │  │ process-orders   Queue ○  —     —        │   │
│ ● run_b  │  │ generate-report  Worker○  —     —        │   │
│          │  └──────────────────────────────────────────┘   │
│          │                                                  │
└──────────┴──────────────────────────────────────────────────┘
```

- **Left sidebar:** Workflow list grouped by trigger type + live event feed
- **Main area:** Aggregate stats + workflow cards with last run status, avg duration, error rate
- **Live indicators:** Green dots for active workflows, real-time run count

#### Page 2: Workflow Detail (`/workflows/:name`)

```
┌─────────────────────────────────────────────────────────────┐
│  ← Back    countries                    [▶ Trigger Run]     │
├──────────────────────────────────────────────────────────────┤
│  [Runs]  [Definition]  [Metrics]                            │
├──────────────────────────────────────────────────────────────┤
│  Filters: [Status ▼] [Trigger ▼] [Date range ▼] [🔍]      │
│                                                              │
│  ┌────┬───────────┬────────┬──────────┬──────────┬────────┐│
│  │ #  │ Status    │ Trigger│ Duration │ Started  │ Nodes  ││
│  ├────┼───────────┼────────┼──────────┼──────────┼────────┤│
│  │ 1  │ ● Running │ GET /  │ 2.1s...  │ 2s ago   │ 3/5   ││
│  │ 2  │ ✓ Done    │ GET /  │ 42ms     │ 1m ago   │ 5/5   ││
│  │ 3  │ ✗ Failed  │ POST / │ 156ms    │ 5m ago   │ 3/5   ││
│  │ 4  │ ✓ Done    │ GET /  │ 38ms     │ 10m ago  │ 5/5   ││
│  └────┴───────────┴────────┴──────────┴──────────┴────────┘│
│                                          [← 1 2 3 ... →]   │
└─────────────────────────────────────────────────────────────┘
```

- **Tabs:** Runs (default), Definition (JSON viewer), Metrics (charts)
- **Runs table:** Sortable, filterable, click to open trace view
- **Live updates:** Running workflows update in real-time

#### Page 3: Run Trace View (`/runs/:runId`) — THE MAIN FEATURE

```
┌─────────────────────────────────────────────────────────────┐
│  ← countries    Run run_abc123    ● Running   2.1s elapsed  │
│  Trigger: GET /countries   Started: 2026-01-29 10:42:15     │
├──────────────────────────────────────────────────────────────┤
│  [Timeline]  [Graph]  [Logs]  [Events]                      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ── Timeline ─────────────────────────────── Detail ──────  │
│  │                                      │                   │
│  │ ▼ Run: countries           2.1s...   │ fetch-user        │
│  │   ├─ ● validate-input      3ms  ✓   │                   │
│  │   ├─ ● fetch-user          38ms ✓   │ Status: ✓ Done    │
│  │   │    └─ db-query          35ms     │ Duration: 38ms    │
│  │   ├─ ● transform-data      2ms  ✓   │ Runtime: nodejs   │
│  │   ├─ ◐ call-go-service     ...  ⟳   │                   │
│  │   │    └─ go-handler        ...      │ ── Input ──────   │
│  │   └─ ○ format-response     —   ○    │ {                 │
│  │                                      │   "userId": "abc" │
│  │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━    │ }                 │
│  │  0ms   10ms   20ms   30ms   40ms     │                   │
│  │                                      │ ── Output ─────   │
│  │                                      │ {                 │
│  │                                      │   "user": {       │
│  │                                      │     "name": "..."│
│  │                                      │   }               │
│  │                                      │ }                 │
│  │                                      │                   │
│  │                                      │ ── Metrics ─────  │
│  │                                      │ CPU: 2ms          │
│  │                                      │ Memory: 1.2MB     │
│  │                                      │                   │
│  └──────────────────────────────────────┘                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Timeline View (Default Tab):**
- **Left panel:** Waterfall timeline showing node execution
  - Horizontal bars represent duration
  - Color coding: green (completed), blue (running), red (failed), gray (pending)
  - Nested bars for sub-steps (flow nodes, runtime adapter calls)
  - Time scale at bottom with zoom
  - Live animation for running nodes (pulsing indicator)
- **Right panel:** Detail inspector for selected node
  - Status, duration, runtime kind
  - Input payload (collapsible JSON viewer)
  - Output payload (collapsible JSON viewer)
  - Runtime metrics (duration, CPU, memory)
  - Error details with stack trace (if failed)
  - Logs specific to this node

**Graph View (Alt Tab):**
- React Flow DAG showing workflow structure
- Nodes colored by status (live updates)
- Click node to inspect in detail panel
- Edges show data flow direction
- Minimap for large workflows
- Auto-layout via Dagre (top-to-bottom)

**Logs View:**
- Unified log stream across all nodes
- Filter by level (debug/info/warn/error)
- Filter by node name
- Syntax-highlighted JSON in log entries
- Timestamp + relative time

**Events View:**
- Raw chronological event list
- Useful for debugging the trace system itself
- Event type badges with color coding

### 3.4 Real-Time Data Flow

```
┌─────────────┐     SSE Stream      ┌──────────────────────┐
│ Blok Runner  │ ──────────────────→ │   Blok Studio App    │
│              │   /__blok/runs/     │                      │
│ RunTracker   │   :runId/stream     │ useTraceStream()     │
│   ↓ emit     │                     │   ↓                  │
│ EventEmitter │     REST APIs       │ TanStack Query cache │
│              │ ←──────────────── → │   ↓                  │
└─────────────┘   /__blok/runs/*     │ React components     │
                                     │   ↓                  │
                                     │ DOM updates          │
                                     └──────────────────────┘
```

1. **Initial load:** TanStack Query fetches run data via REST (`GET /__blok/runs/:runId`)
2. **Live updates:** `useTraceStream()` opens SSE to `/__blok/runs/:runId/stream`
3. **Event processing:** Each SSE event updates the TanStack Query cache
4. **React renders:** Only changed components re-render (React Flow nodes, timeline bars)
5. **Completion:** SSE connection auto-closes when run finishes; data stays in cache

### 3.5 Keyboard Navigation

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate between nodes in timeline |
| `Enter` | Open node detail panel |
| `Escape` | Close detail panel |
| `1` / `2` / `3` / `4` | Switch tabs (Timeline/Graph/Logs/Events) |
| `Cmd+K` | Quick search (workflow/run) |
| `R` | Refresh data |
| `L` | Toggle live mode |

### Implementation Tasks

**Phase 3A: Project Setup**
- [ ] Initialize TanStack Start project in `apps/studio/`
- [ ] Configure SPA mode in `app.config.ts`
- [ ] Set up Tailwind CSS + shadcn/ui
- [ ] Configure TanStack Router with file-based routing
- [ ] Set up TanStack Query provider
- [ ] Create API client (`lib/api.ts`) with configurable base URL
- [ ] Create SSE client (`lib/sse.ts`) with auto-reconnection

**Phase 3B: Layout & Navigation**
- [ ] Build root layout with sidebar and header
- [ ] Create sidebar navigation with workflow grouping
- [ ] Add breadcrumb navigation
- [ ] Add connection status indicator (StatusBar)
- [ ] Add dark mode support (dev tools should default dark)
- [ ] Responsive layout for different screen sizes

**Phase 3C: Dashboard Page**
- [ ] Workflow list with cards/table view
- [ ] Aggregate stats (total runs, active, error rate)
- [ ] Live event feed in sidebar
- [ ] Search and filter workflows
- [ ] Trigger type grouping/filtering

**Phase 3D: Workflow Detail Page**
- [ ] Runs table with TanStack Table (sort, filter, paginate)
- [ ] Run status badges with color coding
- [ ] Definition tab with JSON viewer
- [ ] Metrics tab with charts (Recharts)
- [ ] "Trigger Run" button (for HTTP workflows)

**Phase 3E: Run Trace View — Timeline**
- [ ] Waterfall timeline component with horizontal bars
- [ ] Time scale with zoom (mouse wheel / pinch)
- [ ] Node status color coding (pending/running/completed/failed)
- [ ] Nested node visualization (indentation + connecting lines)
- [ ] Live animation for running nodes (pulsing, growing bar)
- [ ] Click-to-select with detail panel

**Phase 3F: Run Trace View — Detail Panel**
- [ ] Node metadata (name, type, runtime, duration)
- [ ] Input payload viewer (collapsible JSON with syntax highlighting)
- [ ] Output payload viewer
- [ ] Error display with stack trace
- [ ] Runtime metrics (CPU, memory, duration)
- [ ] Node-specific log viewer
- [ ] Copy-to-clipboard for payloads

**Phase 3G: Run Trace View — Graph**
- [ ] React Flow integration with custom node components
- [ ] Dagre auto-layout (top-to-bottom)
- [ ] Node status color coding (live updates)
- [ ] Click node to select in detail panel
- [ ] Minimap for large workflows
- [ ] Edge animations for data flow

**Phase 3H: Run Trace View — Logs & Events**
- [ ] Unified log stream (virtualized for performance)
- [ ] Log level filtering (debug/info/warn/error)
- [ ] Log node filtering
- [ ] JSON syntax highlighting in log entries
- [ ] Raw event list view
- [ ] Auto-scroll to latest (toggleable)

**Phase 3I: Real-Time Integration**
- [ ] `useTraceStream` hook — SSE for individual run
- [ ] `useGlobalStream` hook — SSE for dashboard feed
- [ ] TanStack Query cache invalidation on SSE events
- [ ] Optimistic UI updates for node status changes
- [ ] Connection state management (Zustand)
- [ ] Graceful reconnection with visual indicator

**Phase 3J: Polish**
- [ ] Keyboard navigation implementation
- [ ] Quick search (Cmd+K) dialog
- [ ] Empty states with helpful illustrations
- [ ] Loading skeletons for all data views
- [ ] Error boundary with retry
- [ ] Performance optimization (memoization, virtualization)
- [ ] Accessibility audit (ARIA labels, focus management)

### Success Criteria

- Dashboard loads in < 500ms
- Run trace view renders 100-node workflow in < 200ms
- Live node updates appear within 50ms of SSE event
- Smooth 60fps animations during workflow execution
- Works with all trigger types (HTTP, gRPC, Cron, Queue, Worker, WebSocket, SSE, Webhook)
- Dark mode by default with light mode option

---

## Phase 4: CLI Integration — `nanoctl trace`

### Objective

Add a `nanoctl trace` (or `nanoctl studio`) command that launches Blok Studio with zero configuration.

### 4.1 Command Design

```bash
# Launch Studio UI in browser
nanoctl trace

# With custom options
nanoctl trace --port 5555 --url http://localhost:4000

# Open directly to a specific workflow
nanoctl trace --workflow countries

# Open directly to a specific run
nanoctl trace --run run_abc123
```

### 4.2 Implementation

**Location:** `packages/cli/src/commands/trace/`

```typescript
import { Command, OptionValues } from "commander";
import { spawn } from "child_process";
import open from "open";

const trace = new Command("trace")
  .alias("studio")
  .description("Open Blok Studio — real-time workflow trace UI")
  .option("--port <port>", "Studio UI port", "5555")
  .option("--url <url>", "Blok backend URL", "http://localhost:4000")
  .option("--workflow <name>", "Open specific workflow")
  .option("--run <id>", "Open specific run")
  .option("--no-open", "Don't auto-open browser")
  .action(async (options: OptionValues) => {
    await startStudio(options);
  });
```

### 4.3 `startStudio` Behavior

1. **Verify backend is running:**
   - Ping `${baseUrl}/__blok/health`
   - If not reachable, display helpful message:
     ```
     Blok backend not found at http://localhost:4000
     Start it first: npm run dev
     ```

2. **Start Studio dev server:**
   - Option A (Development): Run `pnpm dev` in `apps/studio/`
   - Option B (Production): Serve pre-built static assets via Express
   - Pass `BLOK_BASE_URL` environment variable

3. **Open browser:**
   - Auto-open `http://localhost:5555`
   - With `--workflow`: open `http://localhost:5555/workflows/countries`
   - With `--run`: open `http://localhost:5555/runs/run_abc123`

4. **Display status:**
   ```
   Blok Studio running at http://localhost:5555
   Connected to Blok backend at http://localhost:4000
   Press Ctrl+C to stop
   ```

### 4.4 Pre-Built Asset Serving

For production/installed CLI, bundle the Studio app as static assets:

```typescript
// In CLI package
import express from "express";
import path from "path";

function serveStudio(port: number, blokUrl: string) {
  const app = express();
  const staticDir = path.resolve(__dirname, "../studio-dist");

  // Inject runtime config
  app.get("/__config", (req, res) => {
    res.json({ blokBaseUrl: blokUrl });
  });

  // Serve SPA
  app.use(express.static(staticDir));
  app.get("*", (req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });

  app.listen(port);
}
```

### Implementation Tasks

- [ ] Create `packages/cli/src/commands/trace/index.ts` — Command registration
- [ ] Create `packages/cli/src/commands/trace/startStudio.ts` — Studio launcher
- [ ] Add health check verification before launch
- [ ] Add browser auto-open (cross-platform)
- [ ] Add pre-built static asset serving mode
- [ ] Build script to bundle Studio into CLI package
- [ ] Register command in `packages/cli/src/index.ts`
- [ ] Add analytics tracking for trace command usage
- [ ] Integration tests for CLI command

---

## Phase 5: Advanced Features — Trigger.dev-Level Polish

### 5.1 Run Replay & Re-trigger

**Capability:** Re-execute a workflow with the same inputs from a previous run.

```typescript
// API
POST /__blok/runs/:runId/replay
     → { newRunId: string }
     Re-triggers the workflow with the original request context
```

**UI:** "Replay" button on completed/failed run pages.

### 5.2 Request Builder

**Capability:** Manually trigger HTTP workflows from the Studio UI.

- Form-based request builder (method, path, headers, body)
- Pre-fill from workflow definition
- JSON editor with validation
- Response preview
- Save as template for quick re-triggering

### 5.3 Diff View

**Capability:** Compare two runs side-by-side.

- Select two runs of the same workflow
- Side-by-side timeline comparison
- Highlighted differences in node outputs
- Duration comparison bars

### 5.4 Search & Quick Open

**Capability:** Global search across workflows, runs, and events.

- `Cmd+K` command palette
- Search by: workflow name, run ID, error message, node name
- Recent items
- Fuzzy matching

### 5.5 Alerts & Notifications

**Capability:** Browser notifications for run completions/failures.

- Desktop notifications via Notification API
- Sound alerts (optional)
- Toast notifications in-app
- Configurable per workflow

### 5.6 Run Tags & Metadata

**Capability:** User-defined tags on runs for filtering and organization.

- Tag runs via API or context
- Filter runs by tag
- Tag-based views in dashboard
- Auto-tagging (environment, branch, trigger type)

### 5.7 Metrics Dashboard

**Capability:** Aggregate metrics visualization.

- Workflow execution trends (last 24h, 7d, 30d)
- Error rate over time
- Latency percentiles (p50, p95, p99)
- Node-level performance breakdown
- Runtime comparison (NodeJS vs Go vs Python duration)

### 5.8 AI-Assisted Debugging (Future)

**Capability:** AI analysis of failed runs.

- "Explain this error" button on failed runs
- Sends run trace + error to LLM
- Returns human-readable diagnosis
- Suggests fixes based on codebase context

### Implementation Tasks (Prioritized)

**P1 — High Impact:**
- [ ] Run replay/re-trigger
- [ ] Request builder for HTTP workflows
- [ ] Global search (Cmd+K)
- [ ] Desktop notifications

**P2 — Medium Impact:**
- [ ] Diff view for run comparison
- [ ] Run tags and metadata
- [ ] Metrics dashboard with charts

**P3 — Low Priority / Future:**
- [ ] AI-assisted debugging
- [ ] Custom dashboards
- [ ] Export traces (JSON, CSV)
- [ ] Webhook notifications

---

## Phase 6: Persistence & Scale

### 6.1 SQLite Storage (Local Persistence)

**When:** After in-memory proves the concept.

```typescript
// Replace in-memory Maps with better-sqlite3
import Database from "better-sqlite3";

class SqliteRunStore implements RunStore {
  private db: Database.Database;

  constructor(path: string = ".blok/trace.db") {
    this.db = new Database(path);
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (...);
      CREATE TABLE IF NOT EXISTS node_runs (...);
      CREATE TABLE IF NOT EXISTS run_events (...);
      CREATE TABLE IF NOT EXISTS log_entries (...);
      CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs(workflow_name);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status);
      CREATE INDEX IF NOT EXISTS idx_nodes_run ON node_runs(run_id);
      CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id);
    `);
  }
}
```

**Benefits:**
- Runs persist across restarts
- Full-text search on logs/events
- No external dependencies
- Configurable retention (auto-delete after N days)

### 6.2 PostgreSQL Storage (Production)

**When:** For cloud/team deployments.

- Use existing Prisma setup from the framework
- Schema: `blok_workflow_runs`, `blok_node_runs`, `blok_run_events`, `blok_log_entries`
- Connection via `BLOK_TRACE_DATABASE_URL`
- Migrations managed via Prisma

### 6.3 Storage Abstraction

```typescript
interface RunStore {
  // Writes
  createRun(run: WorkflowRun): Promise<void>;
  updateRun(runId: string, updates: Partial<WorkflowRun>): Promise<void>;
  createNodeRun(nodeRun: NodeRun): Promise<void>;
  updateNodeRun(nodeRunId: string, updates: Partial<NodeRun>): Promise<void>;
  addEvent(event: RunEvent): Promise<void>;
  addLog(entry: LogEntry): Promise<void>;

  // Reads
  getRun(runId: string): Promise<WorkflowRun | null>;
  getRuns(query: RunQuery): Promise<PaginatedResult<WorkflowRun>>;
  getNodeRuns(runId: string): Promise<NodeRun[]>;
  getEvents(runId: string, since?: number): Promise<RunEvent[]>;
  getLogs(runId: string, nodeId?: string): Promise<LogEntry[]>;

  // Aggregations
  getWorkflowSummaries(): Promise<WorkflowSummary[]>;

  // Cleanup
  deleteRunsBefore(timestamp: number): Promise<number>;
}

// Implementations
class InMemoryRunStore implements RunStore { ... }
class SqliteRunStore implements RunStore { ... }
class PostgresRunStore implements RunStore { ... }
```

### Implementation Tasks

- [ ] Define `RunStore` interface
- [ ] Implement `InMemoryRunStore` (Phase 1 default)
- [ ] Implement `SqliteRunStore` with better-sqlite3
- [ ] Implement `PostgresRunStore` with Prisma
- [ ] Add `BLOK_TRACE_STORE` env var (`memory` | `sqlite` | `postgres`)
- [ ] Add data retention configuration
- [ ] Add migration system for SQLite/Postgres schemas
- [ ] Performance benchmarks for each storage backend

---

## Technical Specifications

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BLOK_TRACE_ENABLED` | `true` | Enable/disable run tracking |
| `BLOK_TRACE_STORE` | `memory` | Storage backend: `memory`, `sqlite`, `postgres` |
| `BLOK_TRACE_SQLITE_PATH` | `.blok/trace.db` | SQLite database file path |
| `BLOK_TRACE_DATABASE_URL` | — | PostgreSQL connection string |
| `BLOK_TRACE_MAX_RUNS` | `1000` | Max runs in memory before eviction |
| `BLOK_TRACE_RETENTION_DAYS` | `7` | Auto-delete runs older than N days |
| `BLOK_TRACE_PAYLOAD_MAX_KB` | `10` | Max payload size to capture (KB) |
| `BLOK_TRACE_SANITIZE_FIELDS` | `password,secret,token,key` | Fields to redact from payloads |
| `BLOK_STUDIO_PORT` | `5555` | Studio UI server port |

### Performance Requirements

| Metric | Target |
|--------|--------|
| Tracking overhead per node | < 1ms |
| SSE event delivery latency | < 10ms |
| REST API response time (in-memory) | < 5ms |
| REST API response time (SQLite) | < 20ms |
| Studio initial page load | < 500ms |
| Timeline render (100 nodes) | < 200ms |
| Live update render | < 50ms |
| Memory overhead per tracked run | < 50KB |

### Browser Compatibility

| Browser | Version |
|---------|---------|
| Chrome | 90+ |
| Firefox | 90+ |
| Safari | 15+ |
| Edge | 90+ |

### Security

- Trace API only available in development mode by default
- Production: opt-in via `BLOK_TRACE_ENABLED=true`
- Payload sanitization for sensitive fields
- No authentication required (local dev tool)
- Future: Auth middleware for production deployments

---

## Timeline & Milestones

### Phase 1: Backend — Run Tracking (2-3 weeks)

**Milestone:** Workflows emit structured events during execution.

**Deliverables:**
- RunTracker with in-memory store
- Instrumentation in TriggerBase, RunnerSteps, RuntimeAdapterNode
- Log correlation
- 50+ unit tests

### Phase 2: Trace API (1-2 weeks)

**Milestone:** HTTP and SSE endpoints serve trace data.

**Deliverables:**
- REST API for workflows, runs, events, logs
- SSE streaming for live runs
- CORS and security headers
- Integration tests

### Phase 3: Frontend — Blok Studio (4-6 weeks)

**Milestone:** Full trace UI with timeline, graph, and live updates.

**Deliverables:**
- TanStack Start SPA
- Dashboard, workflow detail, run trace pages
- Waterfall timeline + React Flow graph
- Node detail panel with payload inspection
- Real-time SSE integration
- Dark mode, keyboard navigation

### Phase 4: CLI Integration (1 week)

**Milestone:** `nanoctl trace` launches Studio.

**Deliverables:**
- CLI command with options
- Backend health check
- Browser auto-open
- Pre-built asset serving

### Phase 5: Advanced Features (3-4 weeks, ongoing)

**Milestone:** Feature parity with Trigger.dev's core trace UX.

**Deliverables:**
- Run replay
- Request builder
- Global search
- Metrics dashboard
- Desktop notifications

### Phase 6: Persistence (2-3 weeks)

**Milestone:** Traces persist across restarts.

**Deliverables:**
- RunStore interface
- SQLite implementation
- PostgreSQL implementation
- Data retention/cleanup

### Total Estimated Scope: 13-19 weeks

---

## Success Metrics

### Developer Experience

- Developer can see a workflow running in real-time within 5 minutes of setup
- 90%+ of debugging sessions start in Blok Studio (not terminal logs)
- < 30 seconds to find the failing node in a failed workflow
- Works with all 8 runtime languages (NodeJS, Python, Go, Java, Rust, C#, PHP, Ruby)

### Technical Excellence

- Zero breaking changes to existing workflows
- < 1ms tracking overhead per node
- < 50ms live update latency
- 99.9% event delivery reliability (no dropped events)
- 60fps animations during live execution

### Adoption

- 80%+ of Blok developers use Studio during development
- 95%+ satisfaction score on trace UI usability
- 50%+ reduction in debugging time
- Community contributions to Studio (themes, plugins)

### Competitive Position

- Feature parity with Trigger.dev's run view
- Superior multi-language runtime visibility
- Best-in-class DX for workflow orchestration frameworks

---

## Appendix: Research & Inspiration

### A. Trigger.dev Technical Details

- **Dashboard:** Remix (React) + Express + PostgreSQL + Prisma + Redis
- **Real-time:** Electric SQL for HTTP-based PostgreSQL sync
- **Tracing:** OpenTelemetry with custom pending span support
- **Frontend:** React hooks (`useRealtimeRun`, `useRealtimeRunsWithTag`)
- **Features:** Live trace timeline, auto-instrumented spans, log correlation, run metadata, public access tokens

Sources:
- [Trigger.dev - How it works](https://trigger.dev/docs/how-it-works)
- [Trigger.dev - Observability & Monitoring](https://trigger.dev/product/observability-and-monitoring)
- [Trigger.dev - Refreshed Run Timeline](https://trigger.dev/changelog/run-page-timeline)
- [Trigger.dev - Realtime API](https://trigger.dev/product/realtime)
- [Trigger.dev - React Hooks](https://trigger.dev/docs/frontend/react-hooks/realtime)
- [Trigger.dev - GitHub](https://github.com/triggerdotdev/trigger.dev)

### B. Platform Comparison Matrix

| Feature | Trigger.dev | Temporal | Inngest | n8n | Dagster | Windmill | Blok Studio (Target) |
|---------|------------|----------|---------|-----|---------|----------|---------------------|
| Live execution view | ✅ | ✅ | ✅ | ⚠️ Manual only | ✅ | ✅ | ✅ |
| Span/trace timeline | ✅ OTel | ✅ Events | ✅ Steps | ❌ | ✅ Gantt | ✅ | ✅ Waterfall + Gantt |
| DAG/graph view | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ React Flow |
| Input/output inspection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Multi-language support | ❌ TS only | ✅ 4 langs | ❌ TS only | ❌ | ❌ Python | ✅ 8 langs | ✅ 8 langs |
| CLI launch | ❌ Cloud | ❌ Server | ❌ Cloud | ❌ Docker | ❌ Server | ❌ Server | ✅ `nanoctl trace` |
| Self-hosted | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| OpenTelemetry native | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

### C. Technology Stack Summary

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend Framework | TanStack Start (SPA) | 1.x RC |
| Routing | TanStack Router | 1.x |
| Data Fetching | TanStack Query | 5.x |
| Tables | TanStack Table | 8.x |
| Virtualization | TanStack Virtual | 3.x |
| Graph | React Flow (xyflow) | 12.x |
| Graph Layout | Dagre | 0.8.x |
| UI Components | shadcn/ui | latest |
| Styling | Tailwind CSS | 4.x |
| Icons | Lucide React | latest |
| State | Zustand | 5.x |
| Charts | Recharts | 2.x |

### D. Key Design Principles

1. **Zero Config** — Works out of the box with `nanoctl trace`
2. **Non-Intrusive** — Tracking adds < 1ms overhead; no workflow changes needed
3. **Real-Time First** — SSE streaming, live animations, instant feedback
4. **Multi-Language Aware** — Treats NodeJS, Go, Python, Rust, Java, C#, PHP, Ruby equally
5. **Developer-Grade** — Dark mode, keyboard shortcuts, fast, no auth for local dev
6. **Progressive Enhancement** — In-memory → SQLite → PostgreSQL as needs grow
7. **Open Source** — Part of the Blok framework, MIT licensed

### E. SSE vs WebSocket Decision Rationale

For workflow trace streaming, **SSE is the correct choice** because:

1. **Unidirectional data flow** — Trace events flow from server → client only
2. **Auto-reconnection** — Built into the EventSource API; handles network drops gracefully
3. **HTTP-native** — Works with existing Express setup, no WebSocket server needed
4. **Event ID tracking** — `Last-Event-ID` header enables catching up on missed events
5. **Simpler** — Less code, fewer failure modes, easier to debug
6. **Corporate network friendly** — SSE uses standard HTTP; WebSockets often get blocked by proxies

WebSocket should be added later **only if** bidirectional features are needed (e.g., pause/cancel from UI, interactive debugging).

Sources:
- [Real-Time UI Updates with SSE](https://www.codingwithmuhib.com/blogs/real-time-ui-updates-with-sse-simpler-than-websockets)
- [SSE, WebSockets, or Polling? - DEV Community](https://dev.to/itaybenami/sse-websockets-or-polling-build-a-real-time-stock-app-with-react-and-hono-1h1g)
- [Real-Time Web Apps in 2025](https://www.debutinfotech.com/blog/real-time-web-apps)

### F. React Flow for Workflow Visualization

React Flow (xyflow) is the industry standard for node-based UIs in React:

- Used by Stripe, OpenAI, and hundreds of workflow tools
- Supports custom nodes, edges, handles
- Built-in zoom, pan, minimap, controls
- Works with Dagre, ELK.js, and D3 Hierarchy for auto-layout
- TypeScript-first with full type safety
- Playground launched May 2025 for experimenting with layouts

Sources:
- [React Flow](https://reactflow.dev)
- [xyflow](https://xyflow.com)
- [React Flow Playground](https://xyflow.com/labs/react-flow-playground)

### G. TanStack Start for SPA Developer Tools

TanStack Start in SPA mode is ideal for developer tools:

- Built on Vite (fast dev server, HMR)
- SPA mode eliminates SSR complexity (unnecessary for dev tools)
- Type-safe routing with TanStack Router
- TanStack Query for efficient data fetching with SSE integration
- Client-first architecture matches dev tool patterns
- Can be bundled as static assets for CLI distribution

Sources:
- [TanStack Start Overview](https://tanstack.com/start/latest/docs/framework/react/overview)
- [TanStack Start SPA Mode](https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode)
- [TanStack Start v1 - InfoQ](https://www.infoq.com/news/2025/11/tanstack-start-v1/)
- [TanStack Start Deep Dive - Pedro Martins](https://nikuscs.com/blog/06-tanstack-start-deep-dive/)

---

**Document Version:** 1.0.0
**Created:** 2026-01-29
**Last Updated:** 2026-01-29
**Owner:** Blok Core Team
**Status:** Planning
