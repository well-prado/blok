# @blokjs/shared

## 2.2.1

### Patch Changes

- Fix the workspace filesystem watcher on macOS: kqueue's directory self-event was turned into a bogus path and consumed the bounded watch budget before the real per-file event (#991). Lockstep 2.2.1 for every package.

## 2.2.0

### Minor Changes

- 8608279: Add the provider-neutral, headless agent kernel and model adapter contracts,
  including deterministic stream assembly, session-backed turn recovery, effect
  dispatch, steering, cancellation, budgets, stable errors, and test adapters.
- 3d6ab7b: Add language-neutral H1-03 enforcement profiles, workflow binding inputs and
  rules, immutable pinned run contract identities, and authorized guided override
  events. Parsers bound and canonicalize caller-controlled data before a runner
  or control plane persists it.
- a3cf6e5: Add H1-04 evidence-aware join and bounded retry/resume idempotency contracts.
  Required and optional branch obligations, verified evidence, declared typed
  outputs, canonical capability authorities, and effect retry evidence are
  validated at authoring and workflow-load boundaries.
- Four new first-class runtime sidecars and a modular JavaScript execution target.

  - **Swift** (`runtime.swift`, gRPC 10008), **Dart** (`runtime.dart`, 10009),
    **Elixir/BEAM** (`runtime.elixir`, 10010) and **Kotlin** (`runtime.kotlin`, 10011) ship as canonical gRPC sidecars with typed node APIs, capability
    manifests, claim-check support, user-node discovery and the `blokctl create`
    / `blokctl runtime add` lifecycle. All eleven sidecars are exercised by the
    cross-runtime gRPC harness and the scaffold smoke in CI.
  - Node.js, Bun and Deno are explicit JavaScript execution targets
    (`runtime.nodejs`, `runtime.bun`, `runtime.deno`; ADR 0016). `runtime.nodejs`
    runs the registered portable node in-process; a Bun-hosted runner registers
    the in-process Bun adapter; cross-host Bun and Deno fail closed until their
    persistent workers land. The per-step `bun eval` path is gone.
  - CLI: `blokctl dev` regenerates Swift and Elixir user-node registries,
    `runtime add` enforces SDK version floors, `create` rejects unknown
    `--runtimes`, `runtime list` reports the JavaScript target separately, and
    Swift/Dart build caches no longer leak into scaffolds. Dart's floor is 3.11.

### Patch Changes

- f38e2b0: ADR 0015 follow-through — the input gate's failure is now a named, exported error.

  `WorkflowInputValidationError` (from `@blokjs/core/runtime` / `@blokjs/shared`) replaces the
  anonymous `GlobalError` the trigger-boundary input gate used to throw. It **extends**
  `GlobalError` — same code `400`, same `WORKFLOW_INPUT_VALIDATION` tag on
  `context.name`, same structured `validation_errors` json — so every existing
  transport translation (HTTP 400, MCP `isError`, gRPC status, worker DLQ, pub/sub
  dead-letter, webhook 4xx) is unchanged. What's new is that callers can
  `instanceof` it and read `err.info.workflowName` / `err.info.issues`, and the
  rejection now names the workflow: the message reads
  `Input validation failed for workflow 'search': query (Required)` and the 400 body
  gained `error` and `workflowName` alongside `validation_errors`.

  Scope is documented where it was previously only implied: the `runWorkflow`
  testing path is **not** gated (it drives the runner directly, the same position a
  `subworkflow:` child occupies — neither passes through `TriggerBase.run()`), so a
  test runs the payload its author wrote, verbatim.

- 84fabc0: A step's `retry.nonRetryableErrorNames` now stops the worker JOB, not just the step (#679).

  Two things were broken. First, `WorkflowNormalizer` copied only the four timing
  keys off a step's `retry` block and silently dropped `nonRetryableErrorNames` —
  the field was validated by the v2 schema and honoured by `RunnerSteps`, but it
  never reached the runner from any authored workflow, so selective retry was dead
  end to end. It is carried through now (non-string entries filtered).

  Second, the worker trigger's job-level retry ignored the declaration even when the
  step-level loop honoured it: BullMQ re-ran the entire workflow `retries` more
  times, replaying a guard whose outcome cannot change. `handleJob` now routes a
  declared non-retryable failure to the same terminal `job.fail(err, false)` path
  ADR-0015 validation failures take — BullMQ discards the remaining attempts (the
  same check `UnrecoverableError` trips), and the NATS/Kafka/Redis/Rabbit/SQS/pg-boss
  adapters route to their dead-letter queue. Retryable errors honour `retries`
  unchanged.

  The two layers cannot drift: the matcher moved to `@blokjs/shared` as
  `isNonRetryableError` and is called exactly once, by `RunnerSteps`, which stamps
  its verdict on the propagating error (`markNonRetryableStepError`). The worker
  reads that verdict back (`isNonRetryableStepError`) rather than re-deriving it.

## 1.6.2

### Patch Changes

- CLI and observability fixes:

  - `blokctl dev` now honours `--port` and the `PORT` env var instead of forcing
    the config port (precedence: `--port` > `PORT` > project config). Previously
    it always spawned on the config port (4000 by default) and failed whenever
    that port was taken.
  - The HTTP trigger's metrics boot log now reports the real endpoints (app
    `/metrics` on the actual resolved port, plus the Prometheus exporter port,
    configurable via `BLOK_METRICS_PORT`) instead of a hardcoded
    `http://localhost:4000/metrics`.

## 1.6.1

### Patch Changes

- Security: clear all 34 vulnerabilities reported by `npm audit` in a freshly scaffolded project (13 high, 17 moderate, 4 low).

  The findings collapsed to seven root advisories; everything else was cascade through `@blokjs/runner` and the OpenTelemetry SDK packages.

  - **OpenTelemetry 1.x → 2.10.0** (exporters → `0.221.0`). Clears both HIGHs — `exporter-prometheus` process crash via malformed HTTP request (GHSA-q7rr-3cgh-j5r3) and `propagator-jaeger` denial of service (GHSA-45rx-2jwx-cxfr) — plus `@opentelemetry/core`'s unbounded W3C baggage allocation (GHSA-8988-4f7v-96qf).
  - **`@hono/node-server` 1.19.9 → 2.0.11** for the `serve-static` path traversal (GHSA-frvp-7c67-39w9). Reachable rather than theoretical: the HTTP trigger serves `/public/*` through `serveStatic`.
  - **`ai` 4.x → 7.0.36** and **`@ai-sdk/openai` → 4.0.19**. Fixes the AI SDK filetype-whitelist bypass and `@ai-sdk/provider-utils` uncontrolled resource consumption, and removes `jsondiffpatch` (XSS) from the dependency tree entirely.

  The runner's OpenTelemetry bootstraps are optional dynamic imports and now detect BOTH the 1.x class API and the 2.x factory API, so existing projects that have not upgraded their own OpenTelemetry dependencies keep working.

  Also fixes a latent hang the upgrade exposed: `TracingBootstrap.shutdown()` awaited `provider.shutdown()` unbounded, which force-flushes queued spans through the OTLP exporter and retries indefinitely against an unreachable collector — so graceful shutdown (SIGTERM) never completed. The flush is now bounded via `BLOK_TRACING_SHUTDOWN_TIMEOUT_MS` (default `2000`).

## 1.6.0

### Minor Changes

- Runtime-boundary hardening: workflow `input` enforcement (ADR 0015) and gRPC payload safety (ADR 0014).

  **Workflow `input` Zod is now enforced at the trigger boundary.** A workflow declaring `input` has each request validated in `TriggerBase.run` before the body reaches any step: the body is `safeParse`d and replaced with the parsed value, so `.default()`s and coercions apply and unknown keys are stripped. Enforced for **http, mcp, grpc, worker, pubsub, and webhook** — the triggers whose body is the caller/producer payload the schema describes. A malformed payload yields `400` (HTTP/webhook), `isError` (MCP), an error status (gRPC), a DLQ'd job with no retries burned (worker), or a dead-lettered/dropped message (pub/sub) — never a poison-message loop. `cron`, `sse` and `websocket` are excluded: their `ctx.request.body` is framework-generated, not caller input. Workflows that declared a schema _and_ read undeclared body fields must switch to `z.object({...}).passthrough()`. Kill switch: `BLOK_VALIDATE_WORKFLOW_INPUT=0`. Undeclared `input` → unchanged.

  **Non-retryable failures are now terminal on worker/pub-sub.** A validation failure carries a `WORKFLOW_INPUT_VALIDATION` tag; worker routes it straight to DLQ instead of exhausting the retry budget, and pub/sub dead-letters (or ACK-drops) it instead of nacking forever. Three worker adapters were fixed to honour the terminal `job.fail(err, false)` contract they previously ignored: **BullMQ** (a discarded job now lands in the failed set with the real error — `moveToFailed` previously threw `Lock mismatch` because the lock token was never captured), **SQS** (deletes, optionally after a DLQ send, instead of waiting out the visibility timeout), and **pg-boss** (no longer re-throws, so it does not retry). A webhook validation failure returns a real 4xx and is not recorded as a processed delivery, so the sender can retry after correcting the payload.

  **Runtime-boundary payload safety.** Non-NodeJS runtime nodes now fail fast with a `GRPC_REQUEST_TOO_LARGE` error naming the node and a per-blob byte breakdown when a request would exceed the gRPC message limit, instead of an opaque `RESOURCE_EXHAUSTED`. New opt-in `BLOK_GRPC_STATE_DIET=1` stops shipping the accumulated workflow state and previous-step output on every remote call (keeps `env` + trigger body); use it only when runtime nodes follow the v2 ABI and never read `ctx.vars` / `ctx.response.data`.

## 0.2.0

### Minor Changes

- Initial public release of Blok packages.

  This release includes:

  - Core packages: @blokjs/shared, @blokjs/helper, @blokjs/runner
  - Node packages: @blokjs/api-call, @blokjs/if-else, @blokjs/react
  - Trigger packages: pubsub, queue, webhook, websocket, worker, cron, grpc
  - CLI tool: blokctl
  - Editor support: @blokjs/lsp-server, @blokjs/syntax

## 0.0.9

### Patch Changes

- Python3 runtime implemented in the runner

## 0.0.8

### Patch Changes

- Added examples and create project' command to include examples and 'create node' command with options for type ('module' or 'class') and template ('class' or 'ui')

## 0.0.7

### Patch Changes

- Added support for YAML, XML and TOML in the workflow file. Upgraded package version recommended by Dependabot.

## 0.0.6

### Patch Changes

- Updated the quickstart mdx and fixed api-call error issue with rest

## 0.0.5

### Patch Changes

- Implemented a react node and the chatbot demo page

## 0.0.4

### Patch Changes

- Improved Loki metrics

## 0.0.3

### Patch Changes

- Improved and extended the open telemetry feature

## 0.0.2

### Patch Changes

- Fixed open telemetry issues and types

## 0.0.1

### Patch Changes

- Fixed issue with the cli node creation test
