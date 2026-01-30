# Draft Runner that Fits on Current Blok Runner

Below is a concrete draft that fits into the existing Blok runner, keeps types aligned with current code, and makes the runtime resolution language‑agnostic while still working with the existing Python gRPC setup.

I’ll break it into:

1. Shared `Context` and `RunnerNode` assumptions  
2. `ExecutionResult` and `RuntimeAdapter`  
3. `RuntimeRegistry`  
4. A refactored, language‑agnostic `runtimeResolver` wired into `nodeTypes()`  

All TypeScript snippets are designed to live under `core/runner/src/`. [31]

---

## 1. Context and RunnerNode (reusing existing types)

Blok already defines a `Context` type in `core/shared/src/types/Context.ts` with all the data we need for cross‑runtime execution. [7]

```ts
// core/shared/src/types/Context.ts
type Context = {
  id: string;
  workflow_name?: string;
  workflow_path?: string;
  request: RequestContext;
  response: ResponseContext;
  error: ErrorContext;
  logger: LoggerContext;
  config: ConfigContext;
  func?: FunctionContext;
  vars?: VarsContext;
  env?: EnvContext;
  eventLogger: GlobalLogger | unknown;
  _PRIVATE_: unknown;
};
``` [7]

I’ll assume `RunnerNode` is the same type currently used by `Configuration.nodeResolver`, which passes it to `moduleResolver`, `localResolver`, and `runtimeResolver`. [10][26] This draft does not change the `RunnerNode` shape; it only changes how runtime nodes are created.

---

## 2. ExecutionResult and RuntimeAdapter

We introduce an execution‑result type that represents what any runtime returns back to the Runner, and a `RuntimeAdapter` interface that every language/runtime plugin must implement.

```ts
// core/runner/src/types/ExecutionResult.ts
import type { Context } from "@blok/shared"; // matches where Context is today [7]

export type ExecutionResult = {
  success: boolean;
  data: unknown;
  errors: unknown | null;
  // Optional extra observability fields – can be ignored by adapters that don't support them
  logs?: string[];
  metrics?: {
    duration_ms?: number;
    cpu_ms?: number;
    memory_bytes?: number;
  };
};

export type RuntimeKind =
  | "nodejs"
  | "bun"
  | "python3"
  | "go"
  | "java"
  | "docker"
  | "wasm";

export interface RuntimeAdapter {
  kind: RuntimeKind;

  /**
   * Execute a node of this runtime kind with the given context.
   * The adapter is responsible for talking to the underlying runtime
   * (local process, gRPC, HTTP, container, etc.) and normalizing
   * the result into ExecutionResult.
   */
  execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult>;
}
```

`Context` is reused from `core/shared/src/types/Context.ts`, so all existing node code and metrics plumbing continue to work as they do now. [7][32]

---

## 3. RuntimeRegistry

The registry manages which `RuntimeAdapter` handles which runtime kind.

```ts
// core/runner/src/RuntimeRegistry.ts
import type { RuntimeAdapter, RuntimeKind } from "./types/ExecutionResult";

export class RuntimeRegistry {
  private static instance: RuntimeRegistry | null = null;
  private readonly adapters = new Map<RuntimeKind, RuntimeAdapter>();

  private constructor() {}

  static getInstance(): RuntimeRegistry {
    if (!this.instance) {
      this.instance = new RuntimeRegistry();
    }
    return this.instance;
  }

  register(adapter: RuntimeAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  get(kind: RuntimeKind): RuntimeAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new Error(`No runtime adapter registered for kind='${kind}'`);
    }
    return adapter;
  }
}
```

You can initialize this registry once at startup (e.g. in a small `runtime-registry.bootstrap.ts`) and register your language‑specific adapters there.

---

## 4. Example adapters wired to current code

### 4.1. NodeJS runtime adapter (local execution)

Blok already executes TypeScript/Node nodes locally using `BlokService.run(ctx)` and the `Runner` that iterates through steps. [5][32][29]

A **NodeJS adapter** can simply delegate to the existing node handler instance returned by `moduleResolver` or `localResolver`. [19][25][26]

```ts
// core/runner/src/adapters/NodeJsRuntimeAdapter.ts
import type { RuntimeAdapter, RuntimeKind, ExecutionResult } from "../types/ExecutionResult";
import type { Context } from "@blok/shared"; // [7]
import type { RunnerNode } from "./types"; // whatever file currently holds RunnerNode [10][26]

export class NodeJsRuntimeAdapter implements RuntimeAdapter {
  public readonly kind: RuntimeKind = "nodejs";

  async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
    // Here we assume node is already an instance of BlokService (what moduleResolver/localResolver return) [19][25]
    // i.e., it has a .run(ctx) that returns ResponseContext with success/data/error. [32]
    const nanoService: any = node;

    const response = await nanoService.run(ctx); // BlokService.run(ctx): Promise<ResponseContext> [32]

    return {
      success: response.success,
      data: response.data,
      errors: response.error,
    };
  }
}
```

This adapter is 100% aligned with `BlokService.run(ctx)` in `core/runner/src/BlokService.ts`. [32]

### 4.2. Python3 runtime adapter using existing NodeRuntime

Right now, the `runtimeResolver` creates a `NodeRuntime`, assigns it a host/port from `RUNTIME_PYTHON3_HOST` and `RUNTIME_PYTHON3_PORT`, and maps some node fields before returning it as a `RunnerNode`. [1][17][33]

`NodeRuntime.handle(ctx, inputs)`:

- Creates a context via `createContext(ctx, inputs)`  
- Creates a node request, calls `NodeGrpcNativeClient` on `this.host/this.port`, decodes base64, and returns parsed JSON as the node’s result. [17][20]

We can wrap this in a `Python3RuntimeAdapter` without changing the existing on‑the‑wire protocol:

```ts
// core/runner/src/adapters/Python3RuntimeAdapter.ts
import type { RuntimeAdapter, RuntimeKind, ExecutionResult } from "../types/ExecutionResult";
import type { Context } from "@blok/shared"; // [7]
import NodeRuntime from "./NodeRuntime"; // existing class [17]
import type { RunnerNode } from "./types"; // same RunnerNode as elsewhere [10][26]

export class Python3RuntimeAdapter implements RuntimeAdapter {
  public readonly kind: RuntimeKind = "python3";

  async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
    const host = process.env.RUNTIME_PYTHON3_HOST || "localhost";
    const port =
      process.env.RUNTIME_PYTHON3_PORT !== undefined
        ? Number.parseInt(process.env.RUNTIME_PYTHON3_PORT, 10)
        : 50051;

    const runtime = new NodeRuntime(); // existing NodeRuntime [17]
    runtime.assignHostAndPort(host, port); // existing method [17]

    // NodeRuntime.handle(ctx, inputs) expects "inputs" (the node config) separately. [17]
    // We'll use the full node config as inputs so Python can reconstruct NodeBase + Context like today. [30]
    const nanoResponse = await runtime.handle(ctx, node as any); // handle(ctx, inputs): Promise<IBlokResponse> [17]

    // nanoResponse is BlokResponse, which sets success/error internally [17][32]
    if (nanoResponse.error) {
      return {
        success: false,
        data: {},
        errors: nanoResponse.error,
      };
    }

    return {
      success: true,
      data: nanoResponse.data,
      errors: null,
    };
  }
}
```

This adapter reuses `NodeRuntime` exactly as in the current `runtimeResolver`, but instead of returning a mutated `NodeRuntime` **as** a `RunnerNode`, it turns Python execution into a pluggable runtime call that returns `ExecutionResult`. [1][17][33]

---

## 5. Refactored language‑agnostic runtimeResolver

Now we can replace the **Python‑specific** `runtimeResolver` in `core/runner/src/Configuration.ts` with a **generic runtime resolver** that:

- Looks at `node.runtime` (or `node.type`, depending on how you want to encode it).
- Uses `RuntimeRegistry` to select a `RuntimeAdapter`.
- Returns a **proxy RunnerNode** whose `.run(ctx)` calls the adapter under the hood.

Current `runtimeResolver` (Python‑specific): [1][26]

```ts
async runtimeResolver(node: RunnerNode): Promise<RunnerNode> {
  const host = process.env.RUNTIME_PYTHON3_HOST || "localhost";
  const port =
    process.env.RUNTIME_PYTHON3_PORT !== undefined ? Number.parseInt(process.env.RUNTIME_PYTHON3_PORT) : 50051;

  const runtime = new NodeRuntime();
  runtime.assignHostAndPort(host, port);
  (runtime as unknown as RunnerNode).node = node.node;
  runtime.name = node.name;
  runtime.active = node.active !== undefined ? node.active : true;
  runtime.stop = node.stop !== undefined ? node.stop : false;
  runtime.set_var = node.set_var !== undefined ? node.set_var : false;

  return runtime as unknown as RunnerNode;
}
``` [1][33]

New resolver (runtime‑agnostic):

```ts
// core/runner/src/Configuration.ts
import { RuntimeRegistry } from "./RuntimeRegistry";
import type { RuntimeKind } from "./types/ExecutionResult";
import type { Context } from "@blok/shared"; // [7]
import type { RunnerNode } from "./types"; // existing RunnerNode [10][26]

protected async runtimeResolver(node: RunnerNode): Promise<RunnerNode> {
  // Decide which runtime this node uses.
  // For backward compatibility you can derive this from node.type or a new node.runtime field.
  const runtimeKind: RuntimeKind =
    (node as any).runtime || // preferred field if present
    (node.type === "runtime.python3" ? "python3" : "nodejs"); // legacy mapping [26]

  const registry = RuntimeRegistry.getInstance();
  const adapter = registry.get(runtimeKind);

  // Create a lightweight proxy node that implements the BlokService interface
  // expected by the rest of the runner, but delegates execution to the adapter.
  class RuntimeProxyNode {
    name = node.name;
    originalConfig = node; // preserve config for logging in BlokService.run if needed [32]

    async run(ctx: Context) {
      const result = await adapter.execute(node, ctx);

      // Normalize back to ResponseContext shape expected by Runner/steps. [5][32]
      return {
        success: result.success,
        data: result.data,
        error: result.errors,
      };
    }
  }

  return new (RuntimeProxyNode as any)() as RunnerNode;
}
```

This still returns a `RunnerNode`, so all upstream code that calls `nodeResolver(step)` and then passes the node into the `Runner` continues to work unchanged. [8][9][5][29]

---

## 6. Integrating with nodeTypes()

To wire this into the current configuration flow, we keep `module` and `local` resolvers as they are and use `runtimeResolver` for anything that is meant to be executed via an external/runtime adapter.

Current `nodeTypes()` implementation: [26]

```ts
protected nodeTypes(): NodeResolverTypes {
  return {
    module: {
      resolver: async (node: RunnerNode, opts: GlobalOptions) => await this.moduleResolver(node, opts),
    },
    local: {
      resolver: async (node: RunnerNode, opts: GlobalOptions) => await this.localResolver(node),
    },
    "runtime.python3": {
      resolver: async (node: RunnerNode, opts: GlobalOptions) => await this.runtimeResolver(node),
    },
  };
}
``` [26]

Refactored `nodeTypes()`:

```ts
// core/runner/src/Configuration.ts
protected nodeTypes(): NodeResolverTypes {
  return {
    module: {
      resolver: async (node: RunnerNode, opts: GlobalOptions) =>
        await this.moduleResolver(node, opts), // unchanged [25][26]
    },
    local: {
      resolver: async (node: RunnerNode, opts: GlobalOptions) =>
        await this.localResolver(node), // unchanged [19][26]
    },
    // Generic runtime node (backwards compat: type === "runtime.python3" implies runtimeKind === "python3")
    "runtime.python3": {
      resolver: async (node: RunnerNode, opts: GlobalOptions) =>
        await this.runtimeResolver(node), // now uses RuntimeRegistry + adapters [1][26]
    },
    // Future‑proof: you can introduce new node types like "runtime.nodejs", "runtime.go", etc.
    "runtime.nodejs": {
      resolver: async (node: RunnerNode, opts: GlobalOptions) =>
        await this.runtimeResolver(node),
    },
    "runtime.go": {
      resolver: async (node: RunnerNode, opts: GlobalOptions) =>
        await this.runtimeResolver(node),
    },
  };
}
```

`nodeResolver()` still just picks the right resolver based on `node.type` and throws if the type is unknown. [10]

```ts
protected async nodeResolver(node: RunnerNode): Promise<RunnerNode> {
  const node_types = this.nodeTypes();
  if (node_types[node.type]) {
    return await node_types[node.type].resolver(node, this.globalOptions as GlobalOptions);
  }

  throw new Error(`Node type ${node.type} not found`);
}
``` [10]

---

## 7. How you’d actually use this

1. On startup:
   - Register adapters in `RuntimeRegistry`:

     ```ts
     import { RuntimeRegistry } from "./RuntimeRegistry";
     import { NodeJsRuntimeAdapter } from "./adapters/NodeJsRuntimeAdapter";
     import { Python3RuntimeAdapter } from "./adapters/Python3RuntimeAdapter";

     const registry = RuntimeRegistry.getInstance();
     registry.register(new NodeJsRuntimeAdapter());
     registry.register(new Python3RuntimeAdapter());
     ```

2. Node definitions:
   - For Python nodes, keep `type: "runtime.python3"` so existing configs stay valid. [26]
   - Optionally add `runtime: "python3"` to be explicit in the future.

3. As you add Go/Java/etc.:
   - Implement a `GoRuntimeAdapter` or a generic `DockerRuntimeAdapter`.
   - Add `node.type = "runtime.go"` (or `runtime.docker`) and map it in `nodeTypes()` as shown above. [26]

This gives you a **language‑agnostic Atomic Runner** without breaking the current Python gRPC integration or the local NodeJS execution path, and all of it is wired tightly to the real code structure you already have (`Context`, `Runner`, `Configuration`, `NodeRuntime`). [5][7][10][17][26][32]

---
*Exported from Tetrix AI Space*
*Date: 2026-01-27T16:10:44.158Z*