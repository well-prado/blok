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
| Registry resolution | `core/runner/src/__tests__/RuntimeRegistry.test.ts`; `core/runner/__tests__/javascript-runtime-resolution.test.ts`; `core/runner/src/Configuration.ts` | Pass: all three JavaScript kinds resolve through one registry path. In-process when the orchestrator host IS the selected engine; otherwise a gRPC adapter on the per-kind worker port (10012/10013/10014, overridable via `RUNTIME_<KIND>_GRPC_PORT`). No fallback to another engine in either direction. |
| Persistent worker | `packages/js-runtime-worker/`; `packages/js-runtime-worker/tests/worker.integration.test.ts` | Pass: one long-lived gRPC server per engine implementing Health, ListNodes, Execute, and ExecuteStream, with readiness, bounded concurrency + queue (`WORKER_OVERLOADED`), cancellation via `ctx.signal`, per-call deadlines, configurable max message size, keepalive, and a graceful `SIGTERM` drain. The integration suite boots `dist/bin.js` under Node.js, Bun, and Deno. |
| No process per step | `packages/js-runtime-worker/tests/worker.integration.test.ts` ("serves N concurrent executions from ONE process") | Pass: 24 concurrent executions per engine report one pid, the worker's own execution counter advances by exactly 24, and the worker's direct-child count does not move. |
| Deno permissions | `packages/js-runtime-worker/src/permissions.ts`; `packages/js-runtime-worker/tests/worker.unit.test.ts`; `packages/cli/src/services/js-worker.ts` | Pass: flags are derived from the effects nodes DECLARE in their capability manifests (`network` → `--allow-net`, `filesystem`/`write` → `--allow-write`, `process` → `--allow-run`) over a least-privilege baseline. `--allow-all` is reachable only through `BLOK_DENO_ALLOW_ALL=1`, which prints a diagnostic. |
| Runtime capability manifest | `core/shared/src/RuntimeContracts.ts` (`RuntimeCapabilityManifestSchema`); `packages/js-runtime-worker/src/host.ts`; `blok-runtime-manifest` metadata on `ListNodes` | Pass: runtime name/version, protocol version, module formats, TypeScript mode, npm compatibility, permissions, cancellation, streaming, and max message size are Zod-validated at worker boot and advertised on every `ListNodes` response. |
| Cross-runtime conformance | `tests/e2e/cross-runtime/spec-b-typed-e2e.ts`; `tests/e2e/cross-runtime/run-spec-b-e2e.sh`; `.github/workflows/ci.yml` (`cross-runtime`) | Pass for the shared fixture suite: `nodejs`, `bun`, and `deno` are rows in the same 14-runtime harness as the language SDKs — typed schema reflection, capability-manifest equality against the canonical fixture, structured validation errors, `blob-v1` claim-check, user-node discovery, and a mixed Node.js → Bun → Deno chain. The full portable-fixture matrix (control flow, sub-workflows, module-resolution cases) is slice 2. |
| CLI worker lifecycle | `packages/cli/src/services/js-worker.ts`; `packages/cli/src/commands/dev/index.ts`; `packages/cli/src/commands/runtime/list.ts`; `packages/cli/src/services/runtime-detector.ts` | Partial: `blokctl dev` spawns and health-probes the worker when the target differs from the orchestrator host, reports exact remediation for a missing/too-old binary or a missing worker package, and `runtime list --json` probes the engine instead of trusting the config. Automatic RESTART of a crashed sidecar does not exist for any runtime in `blokctl dev` (the worker gets exactly the language sidecars' supervision: spawn, probe, log the exit), so §3's crash-recovery requirement is only half met — the adapter's circuit breaker recovers once a worker is back, but nothing brings it back. |
| Editor surfaces | `packages/lsp-server/src/constants.ts`; `packages/vscode-extension/src/providers/WorkflowDiagnostics.ts`; `packages/vscode-extension/schemas/workflow.v2.json`; `packages/vscode-extension/snippets/workflow.json` | Pass for canonical completion/validation coverage; compatibility aliases remain schema-only inputs where legacy workflows require them. |
| Architecture and migration | `docs/architecture/adr-0016-javascript-runtimes.md`; `docs/migration/single-to-multi-runtime.md`; `docs/d/cli/runtimes.mdx` | Pass: host/target separation, naming, package-manager separation, fail-closed behavior, portability boundary, and permission policy are documented. |

## Acceptance items still blocked

The following issue criteria are not claimed by this slice:

- The complete portable conformance fixture matrix: branch/switch/loop/
  try-catch paths, sub-workflows, trace correlation, secret redaction,
  non-serializable results, worker crash + restart recovery, and the documented
  ESM/module-resolution and npm-dependency cases, executed identically against
  all three engines. The current cross-runtime suite covers the shared
  `typed-greet` / `chain-test` / user-node fixture only.
- Packed-consumer smoke tests (`npm pack` → install → run) under Bun and Deno.
- Runtime-specific install/type-check/build/start command generation in the
  scaffold, and pinned deployment/container metadata for a selected target.
- Performance artifacts containing environment, workload, throughput,
  p50/p95/p99 latency, errors, CPU, and memory.
- Fine-grained Deno permissions (per-path `--allow-read`/`--allow-write`,
  per-host `--allow-net`) derived from capability identifiers rather than the
  coarse effect buckets.
- Automatic restart of a crashed sidecar in `blokctl dev`. This is a
  repository-wide gap, not a JavaScript-specific one — no runtime sidecar is
  restarted today — but §3 names crash recovery, so it stays on this list until
  the supervision loop exists.

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

Worker evidence:

```bash
cd packages/js-runtime-worker
bunx vitest run tests/worker.unit.test.ts          # under Node.js
bun test tests/worker.unit.test.ts                 # under Bun
bunx vitest run tests/worker.integration.test.ts   # boots the worker under node, bun and deno
```

Cross-runtime evidence (boots the three workers alongside the language SDKs):

```bash
bun run build
bash tests/e2e/cross-runtime/run-spec-b-e2e.sh
```

The full acceptance gate remains `bun run ci:fast` plus the `js-runtime-targets`
and `cross-runtime` CI lanes, which pin Bun, Node.js, and Deno versions. A row
above is marked Pass only where a test in this repository exercises it; the
schema-only rows from the first slice are not evidence for the worker rows.
