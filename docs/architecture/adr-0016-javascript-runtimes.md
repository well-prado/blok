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
