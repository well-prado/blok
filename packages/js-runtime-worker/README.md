# @blokjs/runtime-worker

The persistent JavaScript/TypeScript execution worker for [Blok](https://github.com/well-prado/blok).

One long-lived process per JavaScript engine, serving the canonical
`blok.runtime.v1` gRPC contract — the same contract the eleven language SDKs
serve and the same client the runner dials. The identical build runs under
**Node.js, Bun, and Deno**.

See [ADR 0016](../../docs/architecture/adr-0016-javascript-runtimes.md) for the
host/target separation and the worker lifecycle rules, and
[docs/d/cli/runtimes.mdx](../../docs/d/cli/runtimes.mdx) for the user-facing
selection guide.

## Why it exists

The engine hosting the Blok orchestrator and the engine executing a JavaScript
node are different axes. When they match, steps run in-process with zero
overhead. When they don't — a `node`-target project hosted by Bun, or any
`deno` target — the step runs here instead. Nothing is spawned per step, ever.

## Running it

```bash
# Node.js
GRPC_PORT=10012 node node_modules/@blokjs/runtime-worker/dist/bin.js

# Bun
GRPC_PORT=10013 bun node_modules/@blokjs/runtime-worker/dist/bin.js

# Deno — least privilege: one port, read the project, read env
GRPC_PORT=10014 deno run \
  --allow-net=127.0.0.1:10014 --allow-read=. --allow-env \
  --node-modules-dir=manual node_modules/@blokjs/runtime-worker/dist/bin.js
```

`blokctl dev` does this for you when the project's target differs from the
orchestrator host.

**Minimum engine versions:** Node.js 20, Bun 1.1, **Deno 2.7.5**. The Deno floor is
not cosmetic — before 2.7.5 its Node-compat HTTP/2 server binds the port but never
completes a gRPC connection, so the worker looks alive and answers nothing.

| Environment variable | Default | What it does |
| --- | --- | --- |
| `GRPC_PORT` | 10012 / 10013 / 10014 per engine | Port the worker binds |
| `HOST` | `127.0.0.1` | Bind address |
| `BLOK_WORKER_NODES` | auto-detected | Project node module (`dist/Nodes.js` under Node.js; `src/Nodes.ts` under Bun/Deno) |
| `BLOK_WORKER_BUILTINS` | `1` | `0` serves only the project's nodes |
| `BLOK_WORKER_MAX_CONCURRENCY` | `64` | In-flight executions before queueing |
| `BLOK_WORKER_MAX_QUEUE` | `256` | Queued executions before `WORKER_OVERLOADED` |
| `BLOK_GRPC_MAX_MESSAGE_BYTES` | 16 MiB | Message ceiling; must match the runner's |
| `BLOK_BLOB_DIR` | unset | Shared claim-check directory; enables `blob-v1` |
| `BLOK_DENO_ALLOW_ALL` | unset | `1` → `--allow-all`, diagnosed; never a production default |

Flags: `--print-manifest` prints the runtime capability manifest;
`--print-permissions` prints the effects the loaded nodes declare and the Deno
flags derived from them.

## What it guarantees

- **One process, N executions.** Bounded concurrency with a bounded queue; over
  both, a deterministic retryable `WORKER_OVERLOADED` error rather than an
  unbounded backlog.
- **Cancellation and deadlines.** The earlier of the gRPC deadline and the
  per-call `options.deadline_ms` aborts `ctx.signal`; a node that ignores it
  still gets a `NODE_DEADLINE_EXCEEDED` (`TIMEOUT`) envelope.
- **Graceful drain.** `SIGTERM` flips readiness to `NOT_SERVING`, drains
  in-flight calls, then exits.
- **A narrow boundary.** Only resolved inputs and the documented projection
  cross it: `ctx.request`, `ctx.env`, `ctx.logger`, `ctx.signal`. Accumulated
  workflow state does not. `ctx.publish` writes travel back as `vars_delta`.
- **Real reflection.** `ListNodes` returns draft-7 JSON Schema derived from each
  node's Zod contract plus its capability manifest, and carries the worker's own
  runtime capability manifest in the `blok-runtime-manifest` metadata header.

## Programmatic use

```ts
import { startWorker } from "@blokjs/runtime-worker";

const worker = await startWorker({ port: 10013, nodesModule: "./src/Nodes.ts" });
// …
await worker.shutdown();
```

## Built-in conformance nodes

`hello-world`, `typed-greet`, `chain-test`, `slow-echo`, and `worker-info` are
registered alongside the project's nodes so the cross-runtime conformance
harness can drive this worker with the same assertions it drives every other
runtime with. Disable them with `BLOK_WORKER_BUILTINS=0`.
