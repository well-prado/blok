# @blokjs/lsp-server

## 2.3.0

### Minor Changes

- Selectable JavaScript execution runtimes (ADR 0016, #942) and Elixir hardening (#943).

  - New package **`@blokjs/runtime-worker`**: one persistent gRPC worker per JavaScript
    engine serving the canonical runtime contract, with the identical entry running under
    Node.js, Bun and Deno (floor 2.7.5). `runtime.nodejs`, `runtime.bun` and `runtime.deno`
    resolve through the single runtime registry: in-process when the orchestrator host is
    the selected engine, otherwise the worker — never a cross-engine fallback, never a
    process per step. Bounded concurrency with deterministic overload, deadlines and
    cancellation, claim-check (`blob-v1`), structured errors, runtime capability manifest,
    and `capabilityManifest.runtimes` enforced at boot.
  - `blokctl dev` spawns and health-probes the worker for the project's JavaScript target
    with least-privilege Deno permissions derived from declared capabilities, and now
    supervises every sidecar kind with bounded restart-with-backoff.
  - Scaffolds gain per-target `start`/`test`/`worker:start` commands, a portable
    `node:test` registry test, a supervised worker program and a pinned engine layer in the
    Dockerfile; the packed-consumer gate imports every artifact under Node.js, Bun and Deno.
  - Elixir sidecar: BEAM failure-mode test suite, startup-validated configuration (message
    size, keepalive, connections, TLS/mTLS, admission bounds), telemetry events, load
    profile, and a fix for spurious `RUNTIME_OVERLOADED` under load.
  - macOS workspace filesystem watcher fix (capabilities) and CI hardening.

## 2.2.1

### Patch Changes

- Fix the workspace filesystem watcher on macOS: kqueue's directory self-event was turned into a bogus path and consumed the bounded watch budget before the real per-file event (#991). Lockstep 2.2.1 for every package.

## 2.2.0

### Minor Changes

- Lockstep 2.2.0 release alongside the new runtime sidecars (no package-local changes).

## 0.2.0

### Minor Changes

- Initial public release of Blok packages.

  This release includes:

  - Core packages: @blokjs/shared, @blokjs/helper, @blokjs/runner
  - Node packages: @blokjs/api-call, @blokjs/if-else, @blokjs/react
  - Trigger packages: pubsub, queue, webhook, websocket, worker, cron, grpc
  - CLI tool: blokctl
  - Editor support: @blokjs/lsp-server, @blokjs/syntax
