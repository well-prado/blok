# Multi-Language SDKs

Since v0.5, all SDKs reach the runner over **gRPC** — `HttpRuntimeAdapter` and the
`POST /execute` HTTP path were removed together with the `RUNTIME_TRANSPORT=http`
opt-in. SDK processes still expose `GET /health` for orchestrator readiness
probes, but the runner itself only speaks gRPC.

## gRPC Contract

Service: `blok.runtime.v1.NodeRuntime/Execute`. The canonical proto schema is
[`proto/blok/runtime/v1/runtime.proto`](../proto/blok/runtime/v1/runtime.proto);
every SDK + the runner keep a copy at their own path, kept in lock-step by
`bun run proto:sync` (and gated by `proto:check` in CI — edit the canonical file
only). Each SDK serves a Cap'n Proto–style
binary `ExecuteRequest` and returns an `ExecuteResponse` carrying the same
fields as the legacy HTTP `ExecutionResult` (`success`, `data`, `errors`,
`logs`, `metrics`, `vars`).

**GET /health** → `{ "status": "healthy" }` (informational; the CLI uses a
TCP-connect probe against the gRPC port, not this endpoint).

## Default gRPC Ports

Go: 10001, Rust: 10002, Java: 10003, C#: 10004, PHP: 10005, Ruby: 10006, Python3: 10007.

Convention: gRPC port = legacy HTTP port + 1000.

## Cross-runtime E2E + CI gate

[`tests/e2e/cross-runtime/`](../tests/e2e/cross-runtime) proves all 7 runtimes
serve the gRPC contract and a single chain threads `ctx` through every language.
Two ways to run it:

- **Docker (CI):** `docker compose -f tests/e2e/cross-runtime/docker-compose.yml up -d --build`
  then `BLOK_E2E_REQUIRE_ALL=1 bun tests/e2e/cross-runtime/spec-b-typed-e2e.ts`.
  The compose builds each SDK in gRPC mode on its convention port (10001–10007).
- **Host toolchains:** `bash tests/e2e/cross-runtime/run-spec-b-e2e.sh` (boots on
  2000x to avoid clashing with a local dev stack; runs against whatever is up).

The `.github/workflows/cross-runtime.yml` job runs the Docker path on every PR
to `main` with `BLOK_E2E_REQUIRE_ALL=1` — a broken runtime build fails the gate
instead of silently dropping out of the matrix.

## SDK Node Pattern

Each SDK registers nodes with a language-specific handler interface:
- **Go**: `NodeHandler` interface with `Execute(ctx, config) (interface{}, error)`
- **Rust**: `NodeHandler` trait with `async fn execute(&self, ctx, config) -> Result<Value>`
- **Python3**: `@node` decorator on functions with Pydantic model type hints; auto-discovered from `BLOK_NODES_DIR`
- **Java**: `NodeHandler` interface with `execute(Context ctx, Map config)`
- **C#**: `INodeHandler` interface
- **PHP**: `NodeHandler` interface
- **Ruby**: Handler module

User nodes live in `runtimes/{lang}/nodes/` within projects, registered into the same runtime as the built-in nodes — no manual wiring. The CLI handles every language by one of two models:

- **Dynamic (`BLOK_NODES_DIR` fs-scan at boot):** **Python** (`@node` decorator), **Ruby** (subclass `Blok::Node::NodeHandler`, discovered via a `self.inherited` registry in `lib/blok/node/discovery.rb`), **PHP** (`implements NodeHandler`, globbed + `require_once` in `bin/serve.php`). The CLI sets `BLOK_NODES_DIR` to `runtimes/<lang>/nodes/` on dev-spawn + in supervisord.
- **Compiled (codegen a registration shim before the build):** **Go** (`func Register(registry)` → `cmd/server/register_user_nodes.go`), **Rust** (`pub fn register(registry)` → `src/user_nodes/mod.rs`), **C#** (`: INodeHandler` → `UserNodeRegistry.cs`), **Java** (`implements NodeHandler` → `UserNodeRegistry.java`). `generateXxxNodeRegistry` (in `packages/cli/src/services/runtime-setup.ts`) copies each node's sources into the build module + generates the shim, regenerated on every `blokctl dev`. Go/Rust/C# recompile on boot (`go run`/`cargo run`/`dotnet run`); Java boots a prebuilt jar so dev runs `mvn package` after codegen. Each SDK ships a committed no-op default shim so the pristine SDK compiles in CI with zero user nodes.

## Adding a New SDK Language

1. Implement the `blok.runtime.v1.NodeRuntime/Execute` gRPC service against the canonical proto `proto/blok/runtime/v1/runtime.proto` (add your SDK's copy path to `scripts/sync-proto.ts` so `proto:sync`/`proto:check` keep it in lock-step)
2. Decode the binary `ExecuteRequest`, route to the registered node handler by `node.name`, and return an `ExecuteResponse`
3. Bind a `GET /health` HTTP endpoint for orchestrator readiness probes (the CLI's primary check is a TCP-connect against the gRPC port)
4. Register a `GrpcRuntimeAdapter` in `core/runner/src/Configuration.ts` (per-kind block in `initializeRuntimeRegistry`) with the new kind + gRPC port env var
5. Add the `RuntimeKind` value to `core/runner/src/adapters/RuntimeAdapter.ts`
6. Add `runtime.{lang}` to `NodeTypeSchema` in `core/workflow-helper/src/types/StepOpts.ts`
