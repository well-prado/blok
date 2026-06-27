Perfect. I have enough. Let me compile the comprehensive brief:

## How it works today

**gRPC Contract (Single Source of Truth):**
- `/Users/wellprado/Projects/Personal/blok/proto/blok/runtime/v1/runtime.proto` (lines 1–303) defines `NodeRuntime` service with three RPCs:
  - `Execute(ExecuteRequest) → ExecuteResponse` — unary RPC, the primary node execution path
  - `ExecuteStream(ExecuteRequest) → stream ExecuteEvent` — optional streaming for live logs/progress
  - `ListNodes() → ListNodesResponse` — node catalog reflection
  - `Health(HealthRequest) → HealthResponse` — wire-compatible with grpc.health.v1
- Request envelope includes: `node` (name/type/version), `inputs` (bytes-encoded JSON), `step` info, `trigger` payload, `state` (previous output + vars + env), `workflow` metadata, `options` (deadline, streaming hint)
- Response carries: `success`, `data` (bytes JSON), optional `content_type`, `error` (structured `NodeError` with code/category/severity), `logs`, `metrics`, `vars_delta`

**SDK Layer (7 Parallel Implementations):**
Each SDK (Go, Rust, Java, C#, PHP, Ruby, Python3) implements the same gRPC contract:
- **Go** (`/sdks/go/grpc_server.go`): `*grpc.Server` wraps a `*NodeRegistry` that stores `NodeHandler` instances keyed by name. `Execute` RPC decodes request, routes to handler, returns response. `DefineNode` creates typed wrappers with automatic JSON Schema reflection (lines 74–76, invokes `reflectSchemaJSON[I,O]()`).
- **Python3** (`/runtimes/python3/server.py`): gRPC servicer (`NodeService`) with async `ExecuteNode` handler. User nodes discovered via `BLOK_NODES_DIR` at boot or explicit `register_node(name, handler)` calls. Nodes extend `NanoService` base with `async def handle(ctx, inputs)` (lines 1–68 in examples).
- **Rust, Java, C#, PHP, Ruby:** Parallel pattern — registry singleton holds handlers by name, each handler implements language-specific interface (trait in Rust, interface in Java/C#/PHP, base class in Ruby).

**Runtime Registration & Startup:**
- `blokctl runtime add <lang>`: reads `${BLOK_REPO}/sdks/{lang}`, copies to project `.blok/runtimes/{lang}`, installs/builds language-specific deps, then wires into `.blok/config.json`:
  - **Compiled languages** (Go/Rust/Java/C#): generates node registry shim at `runtimes/{lang}/nodes/` → copied into SDK build module
    - Go: `cmd/server/register_user_nodes.go` with `func registerUserNodes(registry *blok.NodeRegistry)` calls each node's `Register(registry)` (lines 250–312 in runtime-setup.ts)
    - Rust: `src/user_nodes/mod.rs` with `pub mod` declarations + calls to `{mod}::register(registry)` (lines 335–409)
    - Java/C#: parallel pattern, shim generated pre-build
  - **Dynamic languages** (Python3/Ruby/PHP): `BLOK_NODES_DIR` env var points to `runtimes/{lang}/nodes/`, SDK fs-scans at boot
- `.blok/config.json` → `runtimes.{kind}` entry with: `port`, `grpcPort`, `startCmd` (or `grpcStartCmd` override), `cwd`, `kind`, `version`, `requiredVersion` (semver constraint)
- `supervisord.conf` + `.env.local` auto-generated with `RUNTIME_<KIND>_HOST`, `RUNTIME_<KIND>_GRPC_PORT`, `BLOK_TRANSPORT=grpc`, `BLOK_NODES_DIR` (dynamic langs only)

**Runner Adapter System** (`core/runner/src/adapters/`):
- `RuntimeAdapter` interface (lines 63–94 in RuntimeAdapter.ts) implemented by:
  - `NodeJsRuntimeAdapter` — in-process `module` transport, routes to `GlobalOptions.nodes` map
  - `GrpcRuntimeAdapter` — gRPC transport for all seven sidecar languages
- Configuration boot (`Configuration.ts:71–147`):
  1. `assertGrpcOnlyTransport()` rejects stale `RUNTIME_TRANSPORT=http` or per-kind `RUNTIME_<KIND>_TRANSPORT=http` env vars (lines 17–32 in transport.ts)
  2. Registers `NodeJsRuntimeAdapter` once for in-process "nodejs"
  3. For each of [go, rust, java, csharp, php, ruby, python3]: `buildGrpcAdapter(kind, host, portEnv)` → `GrpcRuntimeAdapter(config)` with host/port from env, default ports (GO=10001, RUST=10002, …, PYTHON3=10007)
  4. `GrpcRuntimeAdapter.startHealthCheck()` begins background TCP+gRPC health probes (optional, configurable via `BLOK_GRPC_HEALTH_INTERVAL_MS`)
- Execution flow (GrpcRuntimeAdapter.execute, lines ~150+ in GrpcRuntimeAdapter.ts):
  1. Encode `ExecuteRequest` via `GrpcCodec.encodeExecuteRequest()` → binary protobuf
  2. Call gRPC `Execute` (or `ExecuteStream` if `stream_logs=true`) with deadline from `ExecuteOptions`
  3. Decode `ExecuteResponse` via `decodeExecuteResponse()` → `ExecutionResult` shape
  4. Map gRPC errors (code/message/details) to `BlokError` via `GrpcErrors.toBlokError()`
  5. Return `{success, data, contentType, errors, logs, metrics, vars}`

**Step Execution & Node Type Resolution** (`core/runner/src/RunnerSteps.ts`, `core/runner/src/Configuration.ts`):
- Workflow step `use: "node-name"` or `use: "type-string"` resolves via three chains:
  1. Check `GlobalOptions.nodes` map → `moduleResolver()` → `NodeJsRuntimeAdapter`
  2. Check disk paths from `NODES_PATH` → `localResolver()` → dynamic import → `NodeJsRuntimeAdapter`
  3. Check `type` prefix (`"runtime.python3"`, etc.) → `runtimeResolver()` → looks up adapter from `RuntimeRegistry` → `GrpcRuntimeAdapter` for that kind
- Each step's `process()` calls the resolved adapter's `execute(node, ctx)` in order, piping `ctx.response = result.data` through

**v2 Persistence** (`core/runner/src/workflow/PersistenceHelper.ts`):
- After step succeeds: `applyStepOutput(ctx, step, result)` stores result via rules:
  - If result has error → no-op (v0.5.1 fix)
  - If `step.ephemeral=true` → no-op (only in `ctx.prev`)
  - If `step.spread=true` AND data is object → shallow-merge into `ctx.state`
  - Else → `ctx.state[step.as ?? step.name] = result.data`
- Cross-runtime vars: node returns `vars_delta` in proto → merged into `ctx.vars`

---

## Seams & Extension Points

1. **Proto Schema Versioning:** `blok.runtime.v1` is additive-only; breaking changes go to `v2`. `buf breaking` enforced in CI. SDKs can skip `ExecuteStream` (return UNIMPLEMENTED). New proto fields auto-flow through `GrpcCodec` via proto-loader (camelCase → keys).

2. **Node Discovery & Registration:**
   - **Dynamic:** `BLOK_NODES_DIR` env var + fs-scan (Python/Ruby/PHP). No build step, but **no type safety** — schema errors caught at runtime.
   - **Compiled:** Codegen shim (`register_user_nodes.go`, `user_nodes/mod.rs`, etc.) + build. Type safety at compile time, **but shim regenerated on every dev-spawn**.

3. **Health Checking:** Background loop in `GrpcHealthChecker` (optional, configurable). Circuit breaker trips on N consecutive failures (default 3, configurable), short-circuits Execute calls with DEPENDENCY error (lines 140–148 in GrpcRuntimeAdapter.ts, plus `checkHealth()` method). Not wired to HTTP `/health` — that's informational only.

4. **Message Size & Codec:**
   - `BLOK_GRPC_MAX_MESSAGE_BYTES` env var (default 16 MB) sets symmetric send/receive limit. **Must match** the SDK's limit (Python `bin/serve.py`, Rust `config.rs` read the same env var) or undersized server rejects large messages with `RESOURCE_EXHAUSTED`.
   - `GrpcCodec` handles bytes↔protobuf translation; Node JSON Schema is lazily reflected into bytes in proto for `ListNodes` response.

5. **Error Mapping Contract:** Every SDK populates `NodeError` the same way (lines 202–234 in proto):
   - Auto-filled by SDK: `node`, `sdk`, `sdk_version`, `runtime_kind`, `at`, `stack`
   - Author supplies: `code` (stable machine id, e.g. "POSTGRES_CONNECT_TIMEOUT"), `category` (enum), `severity` (enum), `message` (1-liner), plus optional `description`, `remediation`, `doc_url`
   - Causality: `causes[]` for error chains (rarely used in practice yet)

6. **Transport Abstraction:** `AdapterTransport` type ("module" | "http" | "grpc") used for log tagging only. gRPC is the sole production transport since v0.5. `transport` field on RuntimeAdapter exposed so operators see at a glance which path a node took.

7. **TLS & mTLS:** `loadTlsConfigForKind(kind)` reads per-kind env vars (`RUNTIME_<KIND>_TLS_*`) with global fallbacks (`BLOK_GRPC_TLS_*`). Strict mode (`BLOK_GRPC_REQUIRE_TLS=true`) enforces TLS on non-loopback hosts at adapter boot (lines 108–112 in Configuration.ts). Loopback exempted (dev).

8. **Streaming Logs (Phase 5, opt-in):** `ExecuteOptions.stream_logs=true` hint tells runner to use `ExecuteStream` instead of unary `Execute`. SDK returns `ExecuteEvent` frames (NodeStarted, LogLine, Progress, PartialResult, final ExecuteResponse). Runner feeds logs to `RunTracker.addLog()` → Studio's SSE `/runs/:id/stream` endpoint. Fallback to unary if SDK returns UNIMPLEMENTED.

---

## Hard Constraints/Invariants

1. **Proto Backward Compatibility:** No field deletions or reordering in `blok.runtime.v1` — only additive changes. Existing SDKs ignore new fields. `buf breaking` enforces this; CI blocks violations.

2. **gRPC Port Convention:** Each language has a fixed default (`10001`–`10007`), overridable via `RUNTIME_<KIND>_GRPC_PORT`. Two runtimes of the same kind **cannot coexist** in one process (single env var per kind). Different kinds can run on different ports on the same host.

3. **Node Name Uniqueness:** Per runtime, node names must be unique. Collisions = last-one-wins on register. No namespace scoping per runtime, but workflow step type is `"runtime.{kind}"` so workflows can mix nodes across runtimes by type.

4. **One Registry Per Runtime:** Each SDK boots a single `NodeRegistry` (Go singleton, Python module-level dict, etc.). User nodes merged into the same registry as built-in nodes at boot. No per-request re-registration; registry is immutable after boot.

5. **Execution is Synchronous (per step):** Each `step.process()` awaits `adapter.execute()`. Timeouts enforced via `ExecuteOptions.deadline_ms` + gRPC deadline (hard cutoff). No per-step async queuing.

6. **Vars are Mutable & Shared:** `ctx.vars` (workflow scope) is thread-unsafe during execution (single-threaded per workflow run). The runner mutates it in-place; step's `vars_delta` is merged back. No isolation per runtime.

7. **Content-Type Override:** Only `content_type` field in `ExecuteResponse` overrides; runner always defaults to `"application/json"`. SDK can return `text/plain`, `application/xml`, etc. The runner passes it through to HTTP response headers.

8. **Error Category Enum Stability:** `ErrorCategory` (VALIDATION, CONFIGURATION, DEPENDENCY, TIMEOUT, PERMISSION, RATE_LIMIT, NOT_FOUND, CONFLICT, CANCELLED, INTERNAL, PROTOCOL, DATA) is stable; authors expected to map their errors into these buckets. New categories would require v2.

9. **Manifest Immutability During Run:** The workflow definition (steps, node types, trigger config) is frozen at run-start. `blokctl runtime add` requires a restart or a running deployment to pick up new runtimes. No hot-reload.

10. **Message Encoding:** Request/response payloads are **always** bytes-encoded JSON inside proto. No direct protobuf objects for business logic; the "native types" are JSON with schemas. This decouples SDKs from proto-specific bindings.

---

## What Must Change for the Vision

### 1. **Node Packaging & Distribution** (Immediate blocker)
- **Today:** Nodes live in-repo (`nodes/`, `runtimes/{lang}/nodes/`). User nodes are discovered at boot (dynamic) or codegen'd (compiled).
- **Vision:** Installable node packages (`npm install @acme/validate-card`, `pip install blok-validate-card`, etc.) that target **any runtime**.
  - **Gap:** No metadata registry or package.json/Cargo.toml convention for declaring node runtime requirements + proto schema.
  - **Required:** 
    - Per-node `blok.node.json` (or equiv) declaring supported runtimes, schema, version, dependencies.
    - CLI command: `blokctl node install @acme/validate-card --runtime go,python3` → downloads + injects into `runtimes/{lang}/nodes/`.
    - Node registry website (npm-like UX) with search, versioning, docs.

### 2. **Multi-Runtime Nodes** (Hard problem)
- **Today:** A node is authored in **one language** (e.g., Go code runs only on `runtime.go`). To run the same logic on Python, you rewrite it.
- **Vision:** A single node package installable into multiple runtimes.
  - **Gap:** Proto schema is shared, but **node business logic is not**. A Go binary can't run Python code; a Python venv can't run Rust.
  - **Realistic paths:**
    1. **WebAssembly:** Compile node logic to `.wasm`, ship as a library with language-specific glue (`go run-node.so`, `python ctypes.load(...)`, etc.). Extreme complexity; cross-language interop nightmare.
    2. **Network-based:** Node itself is a microservice. SDK invokes it over HTTP/gRPC. Adds latency; defeats the purpose of native runtimes.
    3. **Accept the split:** A "multi-runtime node" is really N single-language packages (`@acme/validate-card-go`, `@acme/validate-card-python`) sold as a bundle. The CLI/marketplace treats them as a unit.
  - **Chosen:** Option 3 (realistic short-term). The vision becomes: **node packages are multi-language** in the sense of the *marketplace*, not the *implementation*. One npm package or registry entry describes N implementations.

### 3. **Modular Runtime Lifecycle** (Medium-term)
- **Today:** `blokctl runtime add` is a one-time setup: copy SDK, build, wire config, done.
- **Vision:** Runtimes are add/remove/upgrade like Observability modules (Phase 8).
  - **Gap:** 
    - No versioning of SDKs. A `blokctl runtime add go` always gets the latest from the repo. No way to pin `go 1.20` vs `go 1.24`.
    - No diffing/merging on remove. `blokctl runtime remove go` would need to strip `register_user_nodes.go`, reverse `.env.local` changes, etc. Currently manual.
  - **Required:**
    - SDK versioning: `runtimes.{kind}.version` in `.blok/config.json` pins the exact SDK release.
    - `blokctl runtime upgrade go@1.24` → diffs the old/new SDKs, reapplies user nodes, rebuildss.
    - `blokctl runtime remove` fully reverses the state.

### 4. **Node Authoring Ergonomics** (Studio-dependent)
- **Today:** Node logic is TypeScript (in-process) or language-native (Go/Python/etc.). No visual authoring.
- **Vision:** Studio canvas can **author** nodes, not just workflows. AI can assemble nodes from Markdown specs.
  - **Gap:**
    - Nodes are either code files (Go/Rust/Python) or JS functions with Zod schemas (TypeScript). No JSON-serializable "node template" that an AI can reason about.
    - No ergonomic multi-step node (if-else inside a node, loops, sub-workflows at the node level).
    - Studio can't generate code; it can only edit JSON (workflow definitions).
  - **Required:**
    - A "node definition schema" (JSON-serializable) that captures logic + branching + dependencies without requiring language-specific code.
    - Likely outcome: **Extended workflow format** where a node is a sub-workflow. Then any language can "run" it via the gRPC `Execute` call that accepts a workflow JSON as input.

### 5. **SDK Standardization** (Spec-B ongoing)
- **Today:** Each SDK has its own node definition pattern (Go's `DefineNode`, Python's `@node`, Rust's `TypedNode`, etc.).
- **Vision:** One standard interface + ergonomics across all languages.
  - **Gap:** No binding between schema (JSON) and language types. Rust's `serde_json::json!` is not Pydantic is not Go struct tags.
  - **Required:**
    - Standardize input/output schema reflection (JSON Schema generation from language types).
    - Standardize error handling (every SDK populates `NodeError` the same; already done ✓).
    - Standardize middleware/interceptor pattern.

### 6. **gRPC vs HTTP Tradeoffs** (Already solved for HTTP, needs definition for gRPC)
- **Today:** gRPC is the sole transport (HTTP removed in v0.5). Dev over localhost uses plaintext gRPC.
- **Vision:** Operators confident in gRPC deployment at scale.
  - **Gap:**
    - Load balancing: gRPC requires HTTP/2 + connection pooling. Operators unfamiliar with gRPC LBs might accidentally create bottlenecks.
    - Observability: gRPC spans don't automatically flow into OTel the way HTTP requests do (though the runner emits OTel spans, the SDK side is SDK-specific).
    - Debugging: gRPC binary format not human-readable. `grpcurl` is less accessible than `curl`.
  - **Not a blocker** for the vision, but **documentation needed.**

---

## Risks & Gotchas

1. **Proto Drift:** SDKs are copied from `/sdks/{lang}/proto` into projects at `setup` time. If the canonical proto changes and a project isn't re-run `proto:sync`, the SDK's proto can get stale. **Mitigation:** `blokctl runtime upgrade` should re-sync protos; `buf` check on CI.

2. **Codegen Shim Fragility:** Go/Rust/C#/Java shim regeneration happens on every `blokctl dev` invocation. If a user node has a syntax error, the SDK fails to build **silently** on spawn (the supervisor notices a crash, not the CLI). Compiled errors buried in build logs. **Mitigation:** Pre-validate shim in the CLI before spawning.

3. **Port Collisions:** Each runtime kind has one default gRPC port. If two projects on the same dev machine both add `runtime.go`, they'd both try port 10001. **Mitigation:** `blokctl runtime add --grpc-port=10008` override, but requires manual coordination.

4. **Message Size Mismatch:** `BLOK_GRPC_MAX_MESSAGE_BYTES` must match on client + server. If runner has 32 MB but Python SDK has 16 MB, large requests fail silently with `RESOURCE_EXHAUSTED`. No validation at startup. **Mitigation:** Print env var on adapter boot + SDK boot.

5. **Circuit Breaker Thrashing:** If an SDK crashes and restarts within the health check interval (~10s), the adapter might trip the circuit breaker (default 3 consecutive failures) and mark the runtime UNHEALTHY. Then all subsequent calls fail fast. A restart re-arms the breaker, but there's a gap. **Mitigation:** Tune `BLOK_GRPC_HEALTH_FAILURE_THRESHOLD` per deployment.

6. **Streaming Logs OOM:** `ExecuteStream` with huge log volumes can buffer unbounded in memory. A single node emitting 10MB of logs keeps that in RAM on both client + server. **Mitigation:** Cap `LogLine` volume per request (not yet implemented), or document that streaming is for <1MB log volumes.

7. **Node Name Shadowing:** If a user registers a node `"api-call"` that conflicts with a built-in node, the user's node silently wins. No warning. Workflows authored against built-ins then break when deployed to a project with user nodes. **Mitigation:** Namespace convention (e.g., `@{namespace}/{name}`) enforced by the registry + resolver.

8. **Runtime Availability Assumptions:** The runner assumes all registered runtimes are reachable at boot. If Python SDK is slow to start or network is flaky, the first workflow call fails with a connection timeout (30s default). No backoff/retry at the trigger level. **Mitigation:** `blokctl health` command to validate all runtimes before deploying.

9. **Idempotency Across Runtimes:** If a step runs on `runtime.go` and is cached, a replay/re-run that routes to `runtime.python3` bypasses the Python node entirely (cache hit is type-agnostic). Correct by design for immutable business logic, but **risky if two runtimes have different behavior**. **Mitigation:** Document that cache keys MUST be stable across runtimes, or make cache key include runtime kind.

10. **No Runtime Downgrade:** `blokctl runtime add go@1.24` always upgrades to the latest. Pinning an older SDK version is not exposed. Rolling back to a prior SDK is a manual rm + re-add. **Mitigation:** `blokctl runtime pin go@1.22` CLI command for explicit version locking.

11. **gRPC Keepalive Tuning:** Default keepalive is every 10s (lines 131–135 in Configuration.ts). Long-lived connections (e.g., HTTP keep-alives to the runner) can mask SDK crashes for up to 10s before health check fires. **Mitigation:** Document keepalive tuning; operators should lower `BLOK_GRPC_HEALTH_INTERVAL_MS` in prod (currently ~30s default).

12. **TLS Requires Manual CA Rotation:** `RUNTIME_<KIND>_TLS_CA` points to a PEM file on disk. If the CA expires, operators must manually rotate the file + restart. No in-flight rotation. **Mitigation:** Use a cert-manager or similar to auto-rotate + signal the process (future enhancement).

---

## Summary Table: Runtime Binding

| Aspect | Today | Seam |
|--------|-------|------|
| **Node definition** | Language-specific (Go struct, Python decorator, etc.) | `NodeHandler` interface (gRPC contract) + optional schema reflection |
| **Node discovery** | Fs-scan (`BLOK_NODES_DIR`) or codegen shim | Compiler-generated registration or import at boot |
| **Runtime lifecycle** | One-time `blokctl runtime add`, manual remove | Modular add/upgrade/remove with versioning (Observability-style) |
| **Node distribution** | In-repo only | Package registry + `blokctl node install` (not yet implemented) |
| **Multi-runtime nodes** | Requires complete rewrite per language | Accepted: multi-language *package* (N repos, one marketplace entry) |
| **Schema** | JSON Schema (Zod/struct reflection) | Shared proto contract, but type binding is SDK-specific |
| **Error handling** | Structured `NodeError` (v0.5+) ✓ | Uniform across SDKs ✓ |
| **Observability** | OTel spans (SDK + adapter emit them) | Logs in `ExecuteEvent` frames (streaming) or tail only (unary) |

---

## Files & Line References

**Core Proto Contract:**
- `/proto/blok/runtime/v1/runtime.proto` — canonical (gRPC service, message types, error enum)

**Runtime Adapters:**
- `/core/runner/src/adapters/RuntimeAdapter.ts:63–94` — interface + types
- `/core/runner/src/adapters/grpc/GrpcRuntimeAdapter.ts:1–150` — orchestration
- `/core/runner/src/adapters/transport.ts:1–196` — env var parsing, TLS loading, health intervals

**Configuration & Setup:**
- `/core/runner/src/Configuration.ts:71–147` — adapter registration, gRPC port config
- `/packages/cli/src/services/runtime-setup.ts:1–312` — `setupRuntime`, codegen shims (Go/Rust/Java/C#), `generateXxxNodeRegistry` funcs

**SDK Node Patterns:**
- `/sdks/go/node.go:1–51` — `NodeHandler` interface, `DefineNode` generic
- `/sdks/go/registry.go:1–157` — `NodeRegistry.Register`, `Execute` dispatch
- `/runtimes/python3/core/node_base.py:1–93` — `NodeBase` abstract class
- `/runtimes/python3/runner.py:1–41` — request dispatch loop

**Node Discovery:**
- Dynamic: `/sdks/python3/bin/serve.py` (fs-scan + import)
- Compiled: `/packages/cli/src/services/runtime-setup.ts:250–312` (Go), lines 335–409 (Rust), 431–504 (Java), 529–610 (C#)

**CLI Wiring:**
- `/packages/cli/src/commands/runtime/add.ts:1–120` — picker, toolchain detection, SDK setup
- `/packages/cli/src/commands/runtime/shared.ts` — config I/O, validation