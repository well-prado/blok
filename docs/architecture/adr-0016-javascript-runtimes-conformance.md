# ADR 0016 conformance evidence

Governing ADR: `docs/architecture/adr-0016-javascript-runtimes.md`

This file is the acceptance audit for issue #942. Every acceptance criterion in
the issue appears below with the test, script, or generated artifact that
proves it — or, where something is deliberately not built, with the reason and
the ADR section that makes it a non-goal. A row is marked Pass only where a
test in this repository exercises it; a canonical identifier appearing in a
schema or editor is not by itself evidence that the runtime executes.

Two implementation slices produced this: the contract, worker, and CLI
(PR #1007), and the conformance matrix, supervision, packaging, deployment
metadata, benchmarks, and documentation (PR for slice 2).

---

## Architecture and compatibility

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| An approved ADR defines the runtime model, protocol, lifecycle, portability boundary, security model, naming, and migration behavior | `docs/architecture/adr-0016-javascript-runtimes.md` | Pass |
| Existing projects with no explicit JavaScript runtime continue to build and run with no workflow rewrite | `core/shared/__tests__/unit/RuntimeContracts.test.ts`; `packages/cli/tests/services/runtime-contract.test.ts` ("defaults old config without runtime to the legacy-compatible shape") | Pass |
| Node/nodejs aliases are normalized at one boundary with tests and actionable diagnostics | `core/shared/src/RuntimeContracts.ts`; `core/runner/src/workflow/WorkflowNormalizer.ts`; `core/runner/src/__tests__/WorkflowNormalizer.runtime-alias.test.ts` | Pass: `node`/`typescript`/`ts` → `nodejs` with a deprecation diagnostic naming input and replacement; Bun and Deno are never rewritten |
| Runtime and package-manager selections are represented independently | `core/shared/src/RuntimeContracts.ts`; `packages/cli/tests/services/runtime-contract.test.ts` ("writes the selected target independently from the package manager") | Pass |
| No selected runtime silently falls back to another runtime | `core/runner/src/Configuration.ts` (`buildJavaScriptWorkerAdapter`); `core/runner/__tests__/javascript-runtime-resolution.test.ts`; `packages/cli/tests/services/js-worker.test.ts` ("never substitutes another engine for an unavailable one") | Pass: a missing/too-old binary produces a reported skip with remediation and the step then fails with the command to start the worker |

## CLI and project generation

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| `blokctl create --runtime node\|bun\|deno` works non-interactively | `packages/cli/src/commands/create/project.ts`; exercised by `tests/e2e/scaffold-smoke/run.sh` for all three targets in the `js-runtime-targets` CI matrix | Pass |
| Interactive creation exposes all three options with a documented default | `packages/cli/src/commands/create/project.ts`; `docs/d/cli/project.mdx`; `docs/d/cli/runtimes.mdx` | Pass |
| Existing projects can switch the configured runtime through an idempotent CLI command | `packages/cli/src/commands/runtime/use.ts`; `packages/cli/tests/commands/runtime/runtime.test.ts` | Pass: `runtime use` is idempotent and preserves unrelated config |
| Each generated project installs, type-checks, builds, tests, and starts using its selected runtime | `packages/cli/src/services/runtime-setup.ts` (`generateJavaScriptScripts`, `generateExampleTest`); `tests/e2e/scaffold-smoke/run.sh` §4b runs `typecheck`, `build` and `test` INSIDE the generated project and asserts the test script uses the selected engine's runner; §5–6 boot it | Pass, with one documented split: `typecheck`/`build` are `tsc` for every target (the type checker is not an execution axis), and `start` is Node.js for a Deno project because the runner is not hosted under Deno — ADR §1's host/target separation. Deno projects run their steps in the worker `worker:start`/`blokctl dev` launches |
| Generated deployment/container metadata uses the selected runtime and a pinned supported version | `packages/cli/src/services/runtime-setup.ts` (`generateJavaScriptWorkerSupervisord`, `withJavaScriptEngine`); `pinnedVersion`/`dockerProvision` in `packages/cli/src/services/runtime-detector.ts`; asserted by `tests/e2e/scaffold-smoke/run.sh` and pin-checked by `packages/cli/tests/services/runtime-drift.test.ts` | Pass for generation and pinning. The generated image is **not built** by CI (no Docker in the JavaScript lane), so the Dockerfile layer is verified as content, not as a successful image build |

## Execution

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| `runtime.nodejs`, `runtime.bun`, `runtime.deno` resolve through the same registry contract | `core/runner/src/Configuration.ts`; `core/runner/src/__tests__/RuntimeRegistry.test.ts`; `core/runner/__tests__/javascript-runtime-resolution.test.ts` | Pass: in-process when the orchestrator host IS the selected engine, otherwise a gRPC adapter on the per-kind worker port (10012/10013/10014, `RUNTIME_<KIND>_GRPC_PORT` to override) |
| Node.js, Bun, and Deno execute the same portable `defineNode()` fixture successfully | `packages/js-runtime-worker/src/conformance/`; `packages/js-runtime-worker/tests/conformance.test.ts` (one fixture set, 12 cases × 3 engines) | Pass |
| Cross-runtime steps run in one workflow with correct inputs, outputs, state, traces, deadlines, and errors | `packages/js-runtime-worker/tests/conformance.workflow.test.ts` | Pass: a Node.js → Bun → Deno chain threading handles through `ctx.state`, plus branch/switch/forEach/loop/try-catch arms on other engines, sub-workflows, a step deadline, uncaught-failure propagation, and per-step trace records tagged with the engine |
| Out-of-process execution uses persistent, health-checked workers with bounded concurrency and backpressure | `packages/js-runtime-worker/src/server.ts`; `packages/js-runtime-worker/tests/worker.integration.test.ts`; `tests/worker.overload.test.ts`; `benchmarks/js-runtime-worker.ts` (backpressure phase) | Pass: 64 in flight against a capacity-4 worker → 4 served, 60 `WORKER_OVERLOADED`, 0 other errors, on every engine |
| No production path starts a new runtime process for each step execution | `packages/js-runtime-worker/tests/worker.integration.test.ts` ("serves N concurrent executions from ONE process"); `benchmarks/js-runtime-worker.ts` regression assertions | Pass: under sustained load the worker's execution counter advances by exactly the call count from one pid and its direct-child count does not move; the benchmark exits non-zero if either changes |
| Cancellation, timeout, shutdown, and worker-crash recovery are covered by deterministic tests | Cancellation + deadline: `tests/worker.integration.test.ts` ("enforces the per-call deadline"), `src/builtins.ts` `slow-echo` honouring `ctx.signal`. Shutdown: same file ("drains on SIGTERM instead of dropping the process"). Crash: `tests/conformance.test.ts` ("dies on an unrecoverable node crash") per engine, and recovery in `packages/cli/tests/integration/js-worker-crash-recovery.test.ts` + `packages/cli/tests/services/supervisor.test.ts` | Pass |
| Only resolved inputs and the documented context projection cross the runtime boundary | `packages/js-runtime-worker/src/registry.ts` (`projectContext`); `tests/conformance.test.ts` ("projects the documented context and nothing more" — `ctx.state` arrives EMPTY on all three engines even though the caller's state is populated) | Pass |

## Portability, safety, and developer experience

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| Portable and runtime-specific node capabilities are machine-readable and validated before execution | `capabilityManifest.runtimes` enforced in `packages/js-runtime-worker/src/registry.ts` (`isRuntimeCompatible`); `tests/conformance.test.ts` ("accepts only the runtime-constrained fixture that names this engine") | Pass: refused at BOOT with both sides named, kept out of the catalog, and `NODE_RUNTIME_INCOMPATIBLE` (distinct from `NODE_NOT_FOUND`) if a step still targets it |
| Deno permissions are least-privilege by default; unrestricted execution is opt-in and visibly diagnosed | `packages/js-runtime-worker/src/permissions.ts`; `packages/cli/src/services/js-worker.ts`; `tests/worker.unit.test.ts` | Pass: flags derived from declared effects over a baseline of one bound port, project read, env read. Each grant is printed with the reason it exists. Nothing maps to `--allow-ffi`. `--allow-all` requires `BLOK_DENO_ALLOW_ALL=1` and warns. `BLOK_DENO_ALLOW_NET` scopes the `network` grant |
| LSP and VS Code surfaces recognize the same three canonical choices | `packages/lsp-server/src/constants.ts`; `packages/vscode-extension/schemas/workflow.v2.json`; `packages/vscode-extension/snippets/workflow.json`; drift-checked by `packages/cli/tests/services/runtime-drift.test.ts` | Pass |
| Runtime-specific module/dependency limitations produce actionable messages | `packages/js-runtime-worker/src/index.ts` (node-module candidates per engine, with the engine-specific hint); `packages/cli/src/services/js-worker.ts` (Deno sloppy-imports probe + diagnostic); `docs/d/cli/runtime-troubleshooting.mdx` | Pass |
| Documentation includes a comparison matrix, selection guide, migration guide, and runtime-specific troubleshooting | `docs/d/cli/runtimes.mdx`; `docs/d/cli/runtime-troubleshooting.mdx`; `docs/migration/single-to-multi-runtime.md` | Pass |
| Templates and examples contain no undocumented Bun-, Node-, or Deno-only assumptions | Audited across `packages/cli/scaffold-templates`, the bundled scaffold assets, `examples/`, and the CLI-generated scripts; the engine-specific generated commands are documented in `docs/d/cli/runtimes.mdx` ("What a generated project gets") | Pass |
| The same runtime identifiers appear everywhere; a repository check prevents drift | `packages/cli/tests/services/runtime-drift.test.ts` | Pass: the CLI's target list, the LSP list, both workflow schemas, the VS Code snippets, three docs pages and the CI matrix are all read from disk and checked against `@blokjs/shared`; the pinned engine versions are checked against the versions `js-runtime-targets` installs |

## Verification

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| The shared conformance suite passes against the supported Node.js, Bun, and Deno versions in CI | `.github/workflows/ci.yml` → `js-runtime-targets` (setup-node 22.11.0, setup-bun 1.4.0, setup-deno v2.7.5) runs `tests/conformance.test.ts` and `tests/conformance.workflow.test.ts` | Pass |
| Scaffold and packed-consumer smoke tests pass for all three choices | `tests/e2e/scaffold-smoke/run.sh` per matrix target; `scripts/check-packed-exports.ts` imports every packed subpath and runs every packed bin under Node.js, Bun AND Deno | Pass: 540 subpath imports across the three engines |
| Performance artifacts include environment, workload, throughput, p50/p95/p99 latency, errors, CPU, and memory | `benchmarks/js-runtime-worker.ts` (`bun run bench:runtimes`); measurements below | Pass |
| A regression test proves worker reuse and bounded process count under concurrent load | `benchmarks/js-runtime-worker.ts` assertions; `tests/worker.integration.test.ts` | Pass |
| `bun run ci:fast` and `bun run ci:packaging` pass | See "Focused verification" below | Pass |

---

## Performance artifacts

Measured, not claimed. Reproduce with `bun run bench:runtimes` (or
`bun run benchmarks/js-runtime-worker.ts <calls> <concurrency>`); the harness
prints its own environment block so a number can never be quoted without the
hardware it came from.

**Environment.** Apple M1 Pro, 10 cores, 16 GB, darwin 25.6.0 arm64; harness
Bun 1.3.14; engines Node.js v26.5.0, Bun 1.3.14, Deno 2.7.5; commit `8c7c3c57`.
**Workload.** `typed-greet`, 25 B inputs, 2000 calls at concurrency 64, after a
200-call warm-up (a cold process would measure start-up, not steady state).

| Engine | rps | p50 | p95 | p99 | errors | RSS (start → end) | CPU |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Node.js | 9 365 | 5.70 ms | 12.40 ms | 18.11 ms | 0 | 92 → 177 MiB | 0.60 s |
| Bun | 10 787 | 5.37 ms | 8.94 ms | 9.63 ms | 0 | 105 → 129 MiB | 0.57 s |
| Deno | 8 478 | 7.60 ms | 11.41 ms | 14.99 ms | 0 | 102 → 235 MiB | 0.73 s |

Concurrency sweep (rps / p99, same run):

| Concurrency | Node.js | Bun | Deno |
| --- | --- | --- | --- |
| 1 | 3 517 / 1.45 ms | 4 615 / 1.24 ms | 2 987 / 1.46 ms |
| 4 | 7 681 / 2.46 ms | 10 283 / 2.08 ms | 7 077 / 2.52 ms |
| 16 | 9 692 / 7.48 ms | 9 830 / 5.73 ms | 8 801 / 4.29 ms |
| 64 | 13 095 / 7.34 ms | 10 677 / 10.55 ms | 9 068 / 13.25 ms |
| 256 | 11 803 / 31.06 ms | 12 137 / 32.55 ms | 9 968 / 39.52 ms |

**Backpressure.** 64 concurrent 250 ms calls against a worker configured for 2
concurrent + 2 queued: 4 served, 60 `WORKER_OVERLOADED`, 0 other errors — on
every engine. The gate refuses; it does not queue without limit.

**Reuse and process count.** Across the 4 501 calls of each engine's run, the
worker's own execution counter advanced by exactly 4 501, every response
reported the same pid, and the worker's direct-child count stayed at 0. The
benchmark exits non-zero if any of those three change.

**Measured module behaviour.** All three engines loaded the JSON fixture
through the `import … with { type: "json" }` attribute (`jsonVia:
"import-attribute"` on Node.js 26, Bun 1.3.14 and Deno 2.7.5). Stack frames
resolve to the built `.js` files on all three: `bun run build` runs
`scripts/fix-esm-extensions.ts`, which rewrites specifiers and drops the
emitted source maps, so `.ts` frames are not available in built output on any
engine.

---

## Documented non-goals

Not gaps — decisions, with the reason:

- **Outbound claim-check.** ADR 0014's `blob-v1` is inbound only: the runner
  offloads oversized `inputs`, and no SDK offloads a response. An oversized
  RESULT is therefore a structured `OUTPUT_TOO_LARGE` error at the worker and a
  payload-too-large error at the adapter, asserted per engine in
  `tests/conformance.test.ts`. Adding a response leg is an ADR 0014 change, not
  an ADR 0016 one.
- **Per-host `--allow-net` from the manifest.** A capability manifest declares
  *effects* (`network`) and free-form capability identifiers (`network.http`);
  no field names a destination host, and inventing a host grammar for one
  engine's flag would be a manifest change with no other consumer. The
  `network` effect therefore widens `--allow-net` to unrestricted, said so
  explicitly in the launch diagnostic, and `BLOK_DENO_ALLOW_NET` is the
  supported way for a deployment that knows its egress to scope it.
- **Narrowed `--allow-env`.** Measured and rejected: a node never reads Deno's
  environment (its `ctx.env` is the runner's projection), and `@grpc/grpc-js`
  reads `GRPC_*` variables at module load — under an allow-list Deno throws
  `NotCapable: Requires env access to "GRPC_NODE_VERBOSITY"`. An allow-list
  would track a transitive dependency's internals and break on its next
  release.
- **A Deno-hosted orchestrator.** The runner is hosted under Node.js or Bun; a
  Deno project keeps a Node orchestrator and runs its `runtime.deno` steps in
  the worker. This is ADR §1's host/target separation, not a missing feature.
- **Building the generated container image in CI.** The JavaScript lane has no
  Docker. The engine layer and the supervised worker program are verified as
  generated content and pinned by the drift test; the image build itself is not
  exercised.

---

## Focused verification

Contract and unit evidence:

```bash
bun run --filter @blokjs/shared test
bun run --filter @blokjs/runner test
bun run --filter blokctl test
bun run lint:check
bun run build
bun run ci:packaging      # imports every packed subpath under node, bun AND deno
```

Worker and conformance evidence:

```bash
cd packages/js-runtime-worker
bunx vitest run tests/worker.unit.test.ts          # under Node.js
bun test tests/worker.unit.test.ts                 # under Bun
bunx vitest run tests/worker.integration.test.ts   # boots the worker under node, bun and deno
bunx vitest run tests/conformance.test.ts          # the portable fixture matrix, per engine
bunx vitest run tests/conformance.workflow.test.ts # real workflows across all three
```

Supervision, benchmarks, and the scaffold:

```bash
bunx vitest run --root packages/cli tests/services/supervisor.test.ts
bunx vitest run --root packages/cli tests/integration/js-worker-crash-recovery.test.ts
bun run bench:runtimes
SMOKE_JS_RUNTIME=deno SMOKE_RUNTIMES=none SMOKE_TRIGGERS=http BLOK_SMOKE_REQUIRE_ALL=1 \
  bash tests/e2e/scaffold-smoke/run.sh
```

Cross-runtime evidence (boots the three workers alongside the language SDKs):

```bash
bun run build
bash tests/e2e/cross-runtime/run-spec-b-e2e.sh
```

The full acceptance gate is `bun run ci:fast` plus the `js-runtime-targets` and
`cross-runtime` CI lanes, which pin Bun, Node.js, and Deno versions.
