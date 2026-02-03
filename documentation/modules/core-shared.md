# Module Reference: Core Shared

> **Package:** `@blokjs/shared`
> **Path:** `core/shared/`
> **Purpose:** Shared types, base classes, and utilities used by all Blok packages

## What It Does

The shared package defines the foundational types that every other package depends on. Most importantly, it defines the **Context** type (the data object that flows through every workflow) and the **NodeBase** class (the base class every node extends).

## Source Directory Structure

```
core/shared/src/
├── index.ts                    # Barrel export of all shared types
├── GlobalError.ts              # Standard error class with code, message, details
├── GlobalLogger.ts             # Logger abstraction (console, structured, custom)
├── Metrics.ts                  # Metrics collection (CPU, memory, duration)
├── NodeBase.ts                 # Base class for all node implementations
├── Trigger.ts                  # Base trigger type
│
├── types/                      # Core type definitions
│   ├── Context.ts              # THE main data flow object
│   ├── RequestContext.ts       # HTTP request shape (body, headers, query, params)
│   ├── ResponseContext.ts      # HTTP response shape (status, body, headers)
│   ├── ConfigContext.ts        # Configuration context
│   ├── EnvContext.ts           # Environment variables context
│   ├── ErrorContext.ts         # Error state context
│   ├── FunctionContext.ts      # Function context (for defineNode API)
│   ├── LoggerContext.ts        # Logger context
│   ├── NodeConfigContext.ts    # Per-node configuration context
│   ├── ParamsDictionary.ts     # URL/route parameter dictionary
│   ├── Step.ts                 # Workflow step type
│   └── VarsContext.ts          # Variables context (node-to-node data passing)
│
└── utils/                      # Utility functions
    ├── CpuUsage.ts             # CPU usage measurement
    ├── Mapper.ts               # Data mapper (transforms between nodes via JSONPath)
    ├── MemoryUsage.ts          # Memory usage measurement
    ├── MetricsBase.ts          # Base metrics class
    ├── Time.ts                 # High-resolution timing utilities
    └── index.ts
```

## Key Types

### Context (the data flow object)
The Context object is passed to every node during workflow execution. It contains:

```typescript
interface Context {
  request: {
    body: unknown;        // Request body / input data
    headers: Record<string, string>;
    query: Record<string, string>;
    params: Record<string, string>;
  };
  response: {
    status: number;
    data: unknown;
    headers: Record<string, string>;
  };
  vars: Record<string, unknown>;  // Variables shared between nodes
  env: Record<string, string>;    // Environment variables
  config: Record<string, unknown>; // Node configuration
  logger: LoggerContext;           // Logging interface
  errors: GlobalError[];           // Error accumulator
  metrics: Metrics;                // Performance metrics
}
```

### NodeBase (node foundation)
```typescript
abstract class NodeBase {
  abstract handle(ctx: Context, inputs: unknown): Promise<IBlokResponse>;
}
```

### GlobalError (error standard)
```typescript
class GlobalError {
  code: number;      // HTTP-like status code
  message: string;   // Human-readable error message
  details?: unknown; // Additional error details
}
```

### Mapper (data transformation)
The Mapper utility transforms data between nodes using JSONPath-like expressions. This is how the workflow JSON `inputs` field maps data from `ctx.request.body` or `ctx.vars` to node inputs.

## What to Document

1. **Context API** — Complete reference for every field in the Context object
2. **Data flow** — How data moves from trigger → node → node → response
3. **Variables (ctx.vars)** — How nodes share data via the vars object
4. **Mapper** — How input mapping works (JSONPath expressions)
5. **GlobalError** — Error handling patterns
6. **Metrics** — How performance data is collected
