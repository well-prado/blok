# Blok Language Agnostic Plan

Yes, and your instinct is correct: the current Python3-specific runner must become “just one runtime plugin”, not the center of the universe. Let’s design an Atomic Runner that is truly language‑agnostic, as straightforward as possible, and compatible with how Blok already works.

---

## 1. What Blok already gives us (constraints we must respect)

Blok is already about nanoservices (“nodes”) that run in isolated runtimes and can be deployed in different architectures (nanoservices, micro, monolith). [20][31]

- Nodes are independent, reusable execution units with their own runtime and lifecycle. [20][31]
- The Runner is responsible for executing nanoservices in an isolated environment, managing resources, retries, error logging, and state. [23]
- Today, runtimes explicitly include Node.js, Bun, and Python 3, with more on the roadmap (C#/.NET, Java, Go, Rust, PHP). [36][30]
- SDKs and docs already assume **multi‑runtime** support and that nodes can be written in multiple languages. [13][36][12]

So conceptually, Blok already wants exactly what you’re asking for: multiple runtimes, composable in workflows. We just need to make the **runner layer** properly language‑agnostic instead of being biased toward Python.

---

## 2. The “bad part”: current Python‑centric runner model

The existing Python runtime uses a dedicated Python runner that:

- Resolves the node implementation (`get_nodes()`) and builds a `NodeBase` instance. [39]
- Applies config onto the node (name, active/stop/set_var/originalConfig). [39]
- Creates a `Context` with id, workflow name/path, request/response, error, logger, config, func, vars, env. [39]
- Calls `await node.process(self.ctx)` and returns `model.data`. [39]

On the TypeScript/Runner side, you currently have a `runtimeResolver` that is **hard‑wired to a Python3 host/port**: [33]

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
``` [33]

This is the main thing we’re going to generalize.

---

## 3. Target: a **runtime‑agnostic Atomic Runner** (concept)

### Core idea

1. **Every node declares a runtime type** (e.g. `nodejs`, `python3`, `go`, `java`, `docker`, `wasm`).
2. The **Atomic Runner**:
   - Reads the node definition and its `runtime` field.
   - Uses a **pluggable runtime registry** to choose how to execute that runtime.
   - Passes a canonical `Context` to the runtime and expects a canonical `Result`.
3. Each runtime implementation (plugin) is responsible for:
   - Translating canonical Context <-> its own language process.
   - Implementing `execute(nodeConfig, context) -> result`.

We do **not** embed languages into one huge process; we delegate to language‑specific workers (processes, containers, or wasm) behind a simple protocol.

This lines up with Blok’s nanoservice/isolated runtime story. [3][20][31]

---

## 4. Straightforward architecture: what we actually build

### 4.1. Canonical execution contract

Define a minimal, language‑agnostic contract between the Atomic Runner and any runtime:

**Request (to runtime)**

```jsonc
{
  "node": {
    "name": "calculate-tax",
    "path": "nodes/calc_tax",
    "runtime": "python3",     // or nodejs, go, java, etc.
    "config": {
      "active": true,
      "stop": false,
      "set_var": false
    }
  },
  "context": {
    "id": "workflow-exec-id",
    "workflow_name": "checkout",
    "workflow_path": "workflows/checkout",
    "request": { /* arbitrary */ },
    "response": { /* arbitrary */ },
    "error": null,
    "logger": null,
    "config": { /* workflow/node cfg */ },
    "func": null,
    "vars": { /* shared vars */ },
    "env": { /* env vars */ }
  }
}
```

This mirrors what the Python runner already creates in its `Context` and `node_resolver`. [39]

**Response (from runtime)**

```jsonc
{
  "success": true,
  "data": { /* business result */ },
  "errors": null,
  "logs": [/* optional */],
  "metrics": {
    "duration_ms": 12,
    "cpu_ms": 3,
    "memory_bytes": 123456
  }
}
```

The Atomic Runner doesn’t care about the language; it only cares about this contract.

---

### 4.2. Pluggable runtime registry (TypeScript, in core/runner)

Replace the current Python‑only `runtimeResolver` with something like:

```ts
type RuntimeKind = "nodejs" | "bun" | "python3" | "go" | "java" | "docker" | "wasm";

interface RuntimeAdapter {
  kind: RuntimeKind;
  execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult>;
}

class RuntimeRegistry {
  private adapters = new Map<RuntimeKind, RuntimeAdapter>();

  register(adapter: RuntimeAdapter) {
    this.adapters.set(adapter.kind, adapter);
  }

  get(kind: RuntimeKind): RuntimeAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`No runtime adapter registered for kind=${kind}`);
    return adapter;
  }
}
```

The existing `runtimeResolver` then becomes a very thin mapping from node config to adapter selection instead of “always Python3”.

Current code: hard‑wired to `RUNTIME_PYTHON3_HOST` and port. [33]  
New code: uses `node.runtime` (Node configuration) to pick adapter and then host/port from runtime‑specific env variables.

---

### 4.3. Concrete runtime plugins (short‑term pragmatic set)

Start with **three first‑class adapters**:

1. **Node.js / Bun adapter** (local process or long‑lived worker)
2. **Python3 adapter** (refactor existing Python runner into this model)
3. **Docker / generic process adapter** (for Go, Java, Rust, PHP, etc. without writing custom protocol per language initially)

#### 4.3.1. Node.js / Bun adapter

You already have Node.js nodes (TypeScript) as a primary runtime. [11][24][34]

- For the dev/open‑source case, we can:
  - Run nodes **in‑process** (current behavior), but still pretend they’re one of many runtimes from the perspective of the Atomic Runner.
  - Or spawn a worker process if isolation is needed.

Adapter outline:

```ts
class NodeJsRuntimeAdapter implements RuntimeAdapter {
  kind: RuntimeKind = "nodejs";

  async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
    // Load Node implementation (likely already done in current runner)
    const impl = await loadNodeImplementation(node);  // your existing loader
    const model = await impl.process(ctx);
    return {
      success: true,
      data: model.data,
      errors: null
    };
  }
}
```

This aligns with how nodes are described and executed today in TypeScript. [11][26]

#### 4.3.2. Python3 adapter (refactor of current runner)

Right now:

- Python `Runner` resolves nodes, builds a `Context`, and calls `await node.process(self.ctx)`. [39]
- TS `runtimeResolver` just knows host and port of the Python runtime. [33]

We refactor into a gRPC/HTTP adapter that:

- Serializes the canonical `node` + `context` into JSON or protobuf.
- Sends it to the Python runtime (which we adjust slightly to accept this shape and return `success/data/errors`).
- Receives the response and returns it to the core runner.

The Python side already has `Runner.run()` that returns `model.data`; you just wrap that in a network API (HTTP or gRPC) that uses the canonical contract. [39]

This turns the Python “weird special‑case” into “just another adapter” and keeps your existing Python assets largely intact.

#### 4.3.3. Docker / generic process adapter (to unlock *any* language)

To support Go, Java, Rust, PHP, etc. **quickly**, we don’t want to build language‑specific SDKs immediately. Instead:

- Define a **simple runtime contract**:
  - Each runtime image exposes a single HTTP/gRPC endpoint (say `/execute`) implementing the canonical contract.
  - The container image knows how to load the node code and run it.

- The Atomic Runner’s Docker adapter:
  - Given a node with `runtime: "docker"` and some metadata (`image`, `command`, port, etc.), ensures the container is running (or uses a pool).
  - Sends the canonical request to the container.
  - Returns the canonical response.

This keeps the Atomic Runner core simple and delegates language complexity to the container.

---

## 5. How this maps to Blok’s existing promises & docs

Blok already claims:

- **Multi‑runtime support**: Node.js, Bun, Python 3 today; more on the roadmap. [36][30]
- Nodes as **independent, reusable components** with containerized execution for isolation. [3][31]
- Ability to invoke nodes from many environments via SDKs. [7][12][22][8]

An Atomic Runner with a **runtime registry + adapters** is a natural implementation of:

- “Multi‑runtime support for logic written in Node.js, Python, Bun, and more.” [13]
- “Runtimes on the roadmap: C#/.NET, Java, Go, Rust, PHP.” [30]
- “Each node is a self‑contained execution unit with its own runtime and lifecycle.” [20]

We’re just making the runner conform to what the docs already describe architecturally.

---

## 6. Step‑by‑step migration plan (minimal disruption)

### Phase 1 – Make the current runner pluggable (no behavior change yet)

1. Introduce `RuntimeRegistry` and `RuntimeAdapter` abstractions in `core/runner`. [23]
2. Wrap current TypeScript execution path into a `NodeJsRuntimeAdapter`.
3. Replace internal calls that directly run nodes with `registry.get(node.runtime).execute(...)`. For now, default `node.runtime = "nodejs"` to avoid breaking existing configs.
4. Keep the Python solution as‑is (still using `runtimeResolver` + host/port). The point is just to route all execution through a uniform internal interface.

### Phase 2 – Normalize Python runtime

1. Keep current Python `Runner` class and `Context`, but:
   - Add an HTTP/gRPC server around it that maps the canonical request to `Runner(node_name, ctx).run()`. [39]
2. Implement `Python3RuntimeAdapter` in TypeScript that:
   - Uses host/port env (`RUNTIME_PYTHON3_HOST`, `RUNTIME_PYTHON3_PORT`) as now. [33]
   - Sends canonical request, receives canonical response.
3. Replace the hard‑coded `runtimeResolver` with a simpler function:
   - Read `node.runtime`.
   - If `python3`, call `Python3RuntimeAdapter`.
   - If not set, default to NodeJS (backwards compatibility).

At this point, Python is **no longer special**: it’s just a runtime adapter.

### Phase 3 – Add Docker / generic process adapter

1. Define a node configuration shape for arbitrary runtimes, e.g.:

   ```jsonc
   {
     "runtime": "docker",
     "runtimeOptions": {
       "image": "my-org/blok-node-go:latest",
       "port": 8080,
       "env": {
         "RUNTIME_LANG": "go"
       }
     }
   }
   ```

2. Implement `DockerRuntimeAdapter`:
   - Ensures the container (for that image) is running (or uses a pool).
   - Sends canonical request to `http://container:port/execute`.
3. For Go/Java/Rust/PHP, document a tiny “runtime skeleton” that:
   - Accepts the canonical JSON.
   - Maps it to local function.
   - Returns canonical JSON.

Now any language that can speak HTTP and parse JSON can be a node runtime.

### Phase 4 – Rich adapters for “core” languages (if needed)

If performance or DX matters:

- Implement dedicated adapters for Go/Java/etc. with better connection pooling, binary protocols (gRPC), etc.
- But this is an optimization; the Docker/generic adapter already unlocks “any language”.

---

## 7. Why this is **straightforward** and not over‑engineered

- **No magic cross‑language VM**: we don’t rely on GraalVM or exotic polyglot runtimes; we use HTTP/gRPC and containers, which the ecosystem already knows.
- **Simple contract**: one request/response shape for all runtimes.
- **Incremental**:
  - Start by wrapping what you already have (NodeJS & Python).
  - Introduce Docker adapter to unlock other languages.
- **Aligns with existing Blok concepts** (nodes, workflows, isolation, containerization, multi‑runtime). [3][20][31][36]

---

## 8. Concrete “next actions” I’d implement in the repo

1. **In `core/runner`**:
   - Introduce `RuntimeRegistry` + `RuntimeAdapter` abstraction. [23]
   - Convert current NodeJS execution path into `NodeJsRuntimeAdapter`.
   - Add a v1 `Python3RuntimeAdapter` that still uses existing env vars and protocol, then refactor Python side to canonical JSON.

2. **In `runtimes/python3`**:
   - Wrap `Runner` class with an HTTP/gRPC API that conforms to the canonical request/response while internally using `Runner(node_name, ctx).run()`. [39]

3. **In docs (`docs/c/core/runner.mdx`)**:
   - Update “Understanding the Runner” to explicitly say the Runner is a **runtime‑agnostic orchestrator** that uses adapters to execute nodes across multiple languages. [23]
   - Add a “Implementing a new runtime” section that explains how to build a runtime image/worker that speaks the canonical contract.

4. **In SDK docs**:
   - Emphasize that from the SDK side nothing changes: they still call `client.nodejs(...)`, `client.python3(...)`, etc. [22][8]
   - Under the hood, these map to different runtime adapters in the Atomic Runner.

---

If you want, next step I can:

- Draft the exact TypeScript interfaces (`RuntimeAdapter`, `ExecutionResult`, `Context` type) and a refactored version of `runtimeResolver` that’s language‑agnostic, using your existing `RunnerNode` structure as shown in `Configuration.ts`. [33]

---
*Exported from Tetrix AI Space*
*Date: 2026-01-27T16:10:39.825Z*