# Multi-Language SDKs

Since v0.5, all SDKs reach the runner over **gRPC** — `HttpRuntimeAdapter` and the
`POST /execute` HTTP path were removed together with the `RUNTIME_TRANSPORT=http`
opt-in. SDK processes still expose `GET /health` for orchestrator readiness
probes, but the runner itself only speaks gRPC.

## gRPC Contract

Service: `blok.runtime.v1.NodeRuntime/Execute` (proto schema in
[`core/grpc-proto/`](../core/grpc-proto)). Each SDK serves a Cap'n Proto–style
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

Each SDK registers nodes with a `NodeHandler` interface (language-specific):
- **Go**: `NodeHandler` interface with `Execute(ctx, config) (interface{}, error)`
- **Rust**: `NodeHandler` trait with `async fn execute(&self, ctx, config) -> Result<Value>`
- **Python3**: Function-based handler
- **Java**: `NodeHandler` interface with `execute(Context ctx, Map config)`
- **C#**: `INodeHandler` interface
- **PHP**: `NodeHandler` interface
- **Ruby**: Handler module

User nodes live in `runtimes/{lang}/nodes/` within projects.

## Adding a New SDK Language

1. Implement the `blok.runtime.v1.NodeRuntime/Execute` gRPC service against the proto in `core/grpc-proto/`
2. Decode the binary `ExecuteRequest`, route to the registered node handler by `node.name`, and return an `ExecuteResponse`
3. Bind a `GET /health` HTTP endpoint for orchestrator readiness probes (the CLI's primary check is a TCP-connect against the gRPC port)
4. Register a `GrpcRuntimeAdapter` in `core/runner/src/Configuration.ts` (per-kind block in `initializeRuntimeRegistry`) with the new kind + gRPC port env var
5. Add the `RuntimeKind` value to `core/runner/src/adapters/RuntimeAdapter.ts`
6. Add `runtime.{lang}` to `NodeTypeSchema` in `core/workflow-helper/src/types/StepOpts.ts`
