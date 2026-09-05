# ADR 0016 conformance evidence

Governing ADR: `docs/architecture/adr-0016-javascript-runtimes.md`

This file is the acceptance audit for issue #942. It separates the machine-
checked contract slice from runtime capabilities that are intentionally not
promoted until their workers, packaging, and CI evidence exist. A canonical
identifier appearing in a schema or editor does not by itself mean that the
runtime is executable.

## Evidence recorded in this repository

| Area | Evidence | Result |
| --- | --- | --- |
| Shared project vocabulary | `core/shared/src/RuntimeContracts.ts`; `core/shared/__tests__/unit/RuntimeContracts.test.ts` | Pass: `node`, `bun`, `deno` and independent package-manager values are schema-checked. |
| Alias boundary | `core/runner/src/workflow/WorkflowNormalizer.ts`; `core/runner/src/__tests__/WorkflowNormalizer.runtime-alias.test.ts`; `core/runner/src/RuntimeRegistry.ts` | Pass: `node`/`typescript`/`ts` aliases normalize to canonical Node.js with diagnostics; Bun and Deno are never rewritten to Node.js. |
| Existing-project selection | `packages/cli/src/commands/runtime/use.ts`; `packages/cli/tests/commands/runtime/runtime.test.ts` | Pass: `runtime use` is idempotent, preserves unrelated config, and keeps package-manager policy independent. |
| Project creation selection | `packages/cli/src/commands/create/project.ts`; `packages/cli/src/index.ts`; `docs/d/cli/project.mdx` | Contract pass: interactive and non-interactive creation record the selected target. Runtime-specific build/start commands still require the worker slice below. |
| Registry resolution | `core/runner/src/__tests__/RuntimeRegistry.test.ts`; `core/runner/src/Configuration.ts` | Partial: canonical kinds resolve through one registry API, but the default configuration registers only Node.js plus existing non-JavaScript adapters. Bun and Deno fail closed as unavailable. |
| Editor surfaces | `packages/lsp-server/src/constants.ts`; `packages/vscode-extension/src/providers/WorkflowDiagnostics.ts`; `packages/vscode-extension/schemas/workflow.v2.json`; `packages/vscode-extension/snippets/workflow.json` | Pass for canonical completion/validation coverage; compatibility aliases remain schema-only inputs where legacy workflows require them. |
| Architecture and migration | `docs/architecture/adr-0016-javascript-runtimes.md`; `docs/migration/single-to-multi-runtime.md`; `docs/d/cli/runtimes.mdx` | Pass: host/target separation, naming, package-manager separation, fail-closed behavior, portability boundary, and permission policy are documented. |

## Acceptance items still blocked

The following issue criteria are not claimed by this slice:

- A persistent Bun or Deno worker/sidecar with readiness, health checks,
  bounded concurrency, backpressure, cancellation, timeout, shutdown, and
  crash recovery.
- A Deno adapter and least-privilege permission generation from capability
  manifests.
- Cross-runtime execution of one portable fixture, including mixed Node.js →
  Bun → Deno workflows and trace/deadline/error propagation.
- A regression proof that production runtime execution reuses workers and does
  not spawn a process per step. The exported Bun compatibility adapter still
  has a Node-host `bun eval` per-call path and is deliberately not registered.
- Runtime-specific install/type-check/build/test/start commands, pinned
  deployment/container metadata, packed-consumer smoke tests under Bun and
  Deno, and CI jobs pinned to supported Bun/Deno versions.
- Performance artifacts containing environment, workload, throughput,
  p50/p95/p99 latency, errors, CPU, and memory.

These are release-blocking gaps, not reasons to silently fall back to Node.js.
Issue #942 must remain open until the blocked rows have implementation and
deterministic evidence.

## Focused verification

Run the contract evidence with:

```bash
bun run --filter @blokjs/shared test
bun run --filter @blokjs/runner test
bun run --filter blokctl test
bun run lint:check
bun run build
bun run ci:packaging
```

The full acceptance gate remains `bun run ci:fast` plus runtime-version CI
jobs for each supported worker. The current repository has no supported Deno
worker image or persistent Bun worker fixture, so those jobs must not be
represented as passing by a schema-only test.
