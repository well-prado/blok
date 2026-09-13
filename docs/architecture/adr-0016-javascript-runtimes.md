# ADR 0016 — Selectable JavaScript execution runtimes

- Status: Accepted for the staged implementation of issue #942
- Date: 2026-09-04
- Governing issue: [#942](https://github.com/well-prado/blok/issues/942)

## Context

Blok currently has a Node.js in-process adapter and an exported Bun adapter,
while workflow schemas, CLI scaffolding, and editor tooling use overlapping
runtime vocabularies. A project must be able to declare Node.js, Bun, or Deno
as the JavaScript target without coupling that choice to the process hosting
the Blok control plane or to the package manager installing dependencies.

This ADR governs the incremental implementation. The first implementation
slice establishes the shared contract and normalization boundary. Persistent
workers, Deno permissions enforcement, and complete CLI switching are later
slices and must conform to this document.

## Decision

### 1. Orchestrator host and node target are different axes

The process hosting the trigger, workflow engine, and runtime registry is the
orchestrator host. The runtime selected for a JavaScript/TypeScript node is its
execution target. Hosting Blok under Bun does not silently select Bun for every
node; a target must be explicit or use the documented Node.js default for
legacy projects.

The project-level configuration vocabulary is:

```json
{
  "runtime": "node",
  "packageManager": "npm"
}
```

`runtime` and `packageManager` are independent fields. Existing config without
`runtime` remains a Node.js project. A later CLI slice may change `runtime`
without rewriting workflows or nodes.

### 2. Canonical names and compatibility

The canonical project targets are `node`, `bun`, and `deno`. The canonical
runner/step kinds are `nodejs`, `bun`, and `deno`, exposed as
`runtime.nodejs`, `runtime.bun`, and `runtime.deno`.

At compatibility boundaries, `nodejs`, `typescript`, and `ts` are accepted as
aliases for the project target `node`; `node`, `typescript`, and `ts` are
accepted as aliases for the runner kind `nodejs`. Normalization returns an
explicit deprecation diagnostic containing the input and replacement. The
normalizer never maps a selected Bun or Deno target to Node.js.

### 3. Worker topology and lifecycle

The runner owns orchestration; runtime workers own JavaScript module loading and
execution. A worker is long-lived, health-checked, bounded by concurrency and
message limits, and reused across step invocations. A target different from
the orchestrator host uses a pooled worker/sidecar. In-process execution is
allowed only for an explicitly selected, contract-compatible target.

No production path may spawn a fresh Node.js, Bun, or Deno process per step.
The existing gRPC runtime protocol remains the default cross-process transport
until a measured constraint justifies a transport-neutral replacement. Only
resolved step inputs and the documented context projection cross the boundary;
the runner must not send accumulated workflow state unnecessarily.

Workers must provide readiness, health, graceful shutdown, bounded concurrency,
backpressure, crash recovery, cancellation propagation, timeouts, and
structured errors before an out-of-process target is promoted to production.

### 4. Portability boundary

Portable nodes use `defineNode()`, Zod input/output schemas, the documented Blok
context ABI, standard ESM, and runtime-neutral dependencies. Node-specific
`node:` APIs, `Bun.*`, `Deno.*`, native addons, and runtime permissions require
an explicit runtime-specific capability declaration. Unsupported capabilities
must fail at validation or boot, not during an otherwise valid production run.

The shared runtime capability manifest records runtime name/version, protocol
version, module formats, TypeScript execution mode, npm compatibility,
permissions, cancellation, streaming, and maximum message size.

### 5. Package-manager separation

The execution target does not select npm, pnpm, Yarn, or Bun as the dependency
manager. Lockfiles and install commands remain governed by the independent
`packageManager` field. Deno projects may use `deno.json`, `package.json`, npm
specifiers, or a supported combination, but the chosen policy must be explicit
and deterministic in a later scaffold slice.

### 6. Security and permissions

The capability declaration is the policy input for filesystem, network,
environment, subprocess, FFI/native-addon, and secret access. Deno workers use
least-privilege permissions generated from declared capabilities where
possible; unrestricted permissions are not the production default. Node.js and
Bun workers have no equivalent native permission boundary, so they must enforce
the same Blok capability policy in their worker launch and host integration.
Secrets are represented by opaque references, never values in manifests,
workflow config, logs, traces, or model context.

## Consequences

- Shared schemas and aliases can be consumed by the runner, helper, CLI, LSP,
  and VS Code without each surface inventing a runtime list.
- `runtime.deno` is a valid, distinct workflow kind now, but execution remains
  unavailable until the persistent worker slice registers a Deno adapter. The
  resulting error is explicit; there is no silent Node.js fallback.
- `runtime.nodejs` now resolves through the same registry path as the other
  runtime kinds, preserving existing Node.js workflows.
- The Bun adapter's current subprocess fallback is not a conforming production
  worker implementation and must not be expanded or relied upon by this slice.

### Worker slice (implemented)

The persistent worker described in §3 is `@blokjs/runtime-worker`: one gRPC
server, one process per engine, running unchanged under Node.js, Bun, and Deno.
It serves the canonical `blok.runtime.v1` service, loads the SAME
`defineNode()` modules the in-process path loads (the project's `Nodes` module,
the source of truth the runner's `NodeMap` is built from), reflects Zod schemas
and capability manifests into `NodeDescriptor`, resolves `blob-v1` claim-check
references, and maps failures to the canonical `NodeError` envelope with
`sdk = blok-js-<node|bun|deno>` and `runtime_kind = runtime.<nodejs|bun|deno>`.

Consequences of that slice:

- `runtime.deno` executes. `runtime.bun` and `runtime.nodejs` execute
  in-process when the orchestrator host is that engine, and through the worker
  otherwise. The registry decides once, at `Configuration` boot.
- Default worker ports are `10012` (Node.js), `10013` (Bun), and `10014`
  (Deno), continuing the `HTTP_PORT + 1000` convention, overridable per kind
  via `RUNTIME_<KIND>_GRPC_PORT`.
- The runtime capability manifest of §4 is advertised on every `ListNodes`
  response in the `blok-runtime-manifest` gRPC metadata header, and validated
  against `RuntimeCapabilityManifestSchema` at worker boot.
- Deno `--allow-*` flags are derived from the effects nodes declare, over a
  least-privilege baseline of one bound port, project read, and env read.
  `--allow-all` requires `BLOK_DENO_ALLOW_ALL=1` and prints a diagnostic.
- Only resolved inputs and the documented projection cross the boundary. A
  node in the worker sees an EMPTY `ctx.state`; anything it publishes travels
  back as `vars_delta`.

### Conformance, supervision, and deployment slice (implemented)

The second slice closes the verification, supervision, packaging, and
deployment obligations §3, §4 and §6 create.

- **One portable fixture set, three engines.** `@blokjs/runtime-worker`'s
  `src/conformance/` is a single runtime-neutral set of `defineNode()` nodes,
  served when `BLOK_WORKER_CONFORMANCE=1`. It is executed unchanged against
  Node.js, Bun and Deno by `tests/conformance.test.ts` (worker contract) and
  `tests/conformance.workflow.test.ts` (real workflows through the runner:
  handles and persisted state, branch, switch, forEach, loop, try/catch,
  sub-workflows, deadlines, uncaught failures, trace correlation, secret
  redaction, and a mixed Node.js → Bun → Deno chain). There is deliberately no
  per-engine fork: an engine either satisfies the portable contract with those
  exact modules or it does not.

- **Runtime constraints are enforced, not merely declarable.**
  `capabilityManifest.runtimes` (§4) is now checked when a worker registers a
  node. Entries are canonical runner kinds (`nodejs`, `bun`, `deno`, with the
  `node`/`typescript`/`ts` aliases accepted); an absent or empty list means
  portable. A node the engine does not satisfy is refused AT BOOT with both
  sides named, stays out of the catalog, and answers `NODE_RUNTIME_INCOMPATIBLE`
  — distinct from `NODE_NOT_FOUND` — if a step still targets it. This is what
  §4's "fail at validation or boot, not during an otherwise valid production
  run" requires.

- **Crash recovery exists.** §3 lists crash recovery among the properties an
  out-of-process target needs before production. `blokctl dev` now supervises
  every runtime sidecar — not only the JavaScript worker — with bounded
  restart-and-backoff: restart on an unexpected exit, exponential delay, and a
  capped budget per rolling window so a process that cannot boot produces one
  clear message instead of an endless loop.

- **Permission decisions are inspectable.** The Deno launcher reports each
  `--allow-*` grant with the reason it exists (baseline, or the declared effect
  that earned it). `--allow-ffi` is unreachable by derivation.
  `BLOK_DENO_ALLOW_NET` scopes the `network` effect's grant for a deployment
  that knows its egress; without it the grant is unrestricted, because no
  manifest field names a destination host. `--allow-env` stays unrestricted for
  a measured reason recorded in the conformance file.

- **Host and target stay separate in generated projects.** The selected target
  shapes `test` (the engine's own runner) and `worker:start` (the persistent
  worker); `start` boots the ORCHESTRATOR, which is Node.js or Bun. A Deno
  project therefore starts a Node orchestrator and executes its `runtime.deno`
  steps in the Deno worker. `typecheck` and `build` are `tsc` for every target:
  the type checker is no more an execution axis than the package manager is
  (§5).

- **Deployment metadata names the engine and pins it.** The worker is emitted
  as a supervised `[program:javascript_worker]` alongside the language
  sidecars, and a non-Bun target adds a pinned engine layer to the generated
  Dockerfile. The pins are the versions CI installs, enforced by a drift test
  that reads `.github/workflows/ci.yml`.

- **Drift is a test, not a convention.** One check reads the CLI's target
  definitions, the LSP completion list, both workflow schemas, the VS Code
  snippets, three documentation pages and the CI matrix from disk and compares
  them with `@blokjs/shared`.

## Conformance requirements

The following are machine-checked in the first slice:

1. Shared schemas accept exactly the canonical JavaScript targets and keep the
   package manager independent.
2. Alias normalization returns the canonical value and a deprecation
   diagnostic, while canonical `deno` remains unmodified.
3. The registry resolves `node` to the existing `nodejs` adapter and recognizes
   `deno` as a distinct kind.
4. The workflow normalizer emits `runtime.nodejs` for legacy
   `runtime.node` and preserves `runtime.deno`.
5. Editor completion/validation surfaces list `runtime.nodejs`,
   `runtime.bun`, and `runtime.deno` consistently.

Later worker, CLI, packaging, permission, and performance slices must add their
own conformance evidence before claiming those capabilities.
