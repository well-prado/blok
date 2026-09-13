# @blokjs/runner

## 2.2.1

### Patch Changes

- Fix the workspace filesystem watcher on macOS: kqueue's directory self-event was turned into a bogus path and consumed the bounded watch budget before the real per-file event (#991). Lockstep 2.2.1 for every package.
- Updated dependencies
  - @blokjs/shared@2.2.1
  - @blokjs/helper@2.2.1

## 2.2.0

### Minor Changes

- 0774a31: Remote runtime calls no longer ship the accumulated workflow state by default (#874).

  `ctx.vars` is an alias of `ctx.state`, so it holds **every** completed step's output.
  Every `runtime.*` (gRPC) call inlined that whole bag plus the previous step's output,
  which made per-call cost linear in the run's accumulated state — a runtime node inside
  a `forEach` re-serialized a payload that grew with the loop, for O(n²) over the loop,
  with a slow crawl rather than an error as the failure mode. ADR 0014's opt-in
  `BLOK_GRPC_STATE_DIET=1` is now the **default**, resolved in one place
  (`isStateDietEnabled()` in `core/runner/src/adapters/transport.ts`).

  Measured with `benchmarks/grpc-state-payload.ts` — 1200 calls over real gRPC against a
  state that accumulates one 512 B step output per call: **384.79 MiB → 0.09 MiB** sent,
  **4984 ms → 427 ms**, and per-call time goes from 1.07 ms → 6.88 ms across the deciles
  to a flat ~0.25 ms.

  **Unchanged:** mapped `inputs` (where a v2 node reads its data), `env`, the trigger
  body, and the response `vars_delta` — so state still flows back out of a node.

  **If a node reads `ctx.vars` or `ctx.response.data` inside its own body** it now sees
  them empty. Set `BLOK_GRPC_STATE_DIET=0` to restore the old payload process-wide, or —
  better, and per-node — map the value that node needs into that step's `inputs`.

- a3cf6e5: Add H1-04 evidence-aware join and bounded retry/resume idempotency contracts.
  Required and optional branch obligations, verified evidence, declared typed
  outputs, canonical capability authorities, and effect retry evidence are
  validated at authoring and workflow-load boundaries.
- 516c720: The Docker, WASM and Bun-subprocess runtime adapters no longer ship the accumulated workflow state either (#895).

  #874/#885 removed the unbounded O(n²) growth term from the gRPC codec, but three sibling
  adapters had the identical line — `vars: ctx.vars` (every completed step's output) plus
  `response: ctx.response` (the previous step's output) inlined into every call. They are
  never wired by `Configuration.initializeRuntimeRegistry`, but they are exported from
  `@blokjs/runner` and the docs tell you to `registry.register(new DockerRuntimeAdapter(…))`,
  so the bug is reachable by anyone following them.

  All four transports now resolve the diet through one helper, `stateForRuntimePayload()` in
  `core/runner/src/adapters/transport.ts`, with identical semantics: `vars` becomes `{}` and
  the previous step's output becomes `null`, while the envelope, the mapped `inputs`, `env`
  and the trigger body ride along untouched.

  The flag gets a transport-neutral spelling, **`BLOK_RUNTIME_STATE_DIET`** — gating a Docker
  or WASM call on a variable named `..._GRPC_...` was a naming lie. `BLOK_GRPC_STATE_DIET`
  keeps working as an alias (`BLOK_RUNTIME_STATE_DIET` wins when both are set), so #885's
  behaviour and documentation stay true.

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

- dead9d9: `defineNode()` nodes keep the thrown error reachable on `cause`, so
  `retry.nonRetryableErrorNames` can actually match them (#893).

  `FunctionNode.mapErrorToGlobalError` rebuilt a plain thrown `Error` as a fresh
  `GlobalError` carrying the NODE's name and nothing else — the original
  `Error.name` and the whole `cause` chain were dropped before the step-retry loop
  ever saw the failure. Two of the three documented matching semantics of
  `retry.nonRetryableErrorNames` (`Error.name`, a wrapped `cause`) were therefore
  unreachable from `defineNode()`, the recommended authoring path: a step
  declaring `nonRetryableErrorNames: ["Boom"]` and throwing a `Boom` still burned
  its entire retry budget, and — since #679 — the worker job replayed on top of
  that. Only a hand-thrown `GlobalError` + `setName(...)` ever matched.

  The original error is now attached to the rebuilt `GlobalError` as `cause`, with
  the same non-enumerable descriptor `new Error(msg, { cause })` produces. The
  existing bounded cause-walk in `isNonRetryableError` finds the real name one hop
  down, and the same applies to a value thrown that is not an `Error` at all.

  Error envelopes are unchanged: `context.name` still carries the node name (the
  HTTP trigger's `origin`, `BlokError.fromUnknown`'s `node`), and `context.message`
  / `context.code` / `context.json` / `context.stack` are untouched. Inside a
  `tryCatch` catch arm, `ctx.error.name` and `ctx.error.stack` now report the
  author's actual error class and stack rather than a flat `"Error"` — the values
  `ctx.error` was always documented to carry.

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

- Updated dependencies [8608279]
- Updated dependencies [3d6ab7b]
- Updated dependencies [a3cf6e5]
- Updated dependencies [f38e2b0]
- Updated dependencies
- Updated dependencies [84fabc0]
  - @blokjs/shared@2.2.0
  - @blokjs/helper@2.2.0

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

- Updated dependencies
  - @blokjs/shared@1.6.2
  - @blokjs/helper@1.6.2

## 1.6.1

### Patch Changes

- Security: clear all 34 vulnerabilities reported by `npm audit` in a freshly scaffolded project (13 high, 17 moderate, 4 low).

  The findings collapsed to seven root advisories; everything else was cascade through `@blokjs/runner` and the OpenTelemetry SDK packages.

  - **OpenTelemetry 1.x → 2.10.0** (exporters → `0.221.0`). Clears both HIGHs — `exporter-prometheus` process crash via malformed HTTP request (GHSA-q7rr-3cgh-j5r3) and `propagator-jaeger` denial of service (GHSA-45rx-2jwx-cxfr) — plus `@opentelemetry/core`'s unbounded W3C baggage allocation (GHSA-8988-4f7v-96qf).
  - **`@hono/node-server` 1.19.9 → 2.0.11** for the `serve-static` path traversal (GHSA-frvp-7c67-39w9). Reachable rather than theoretical: the HTTP trigger serves `/public/*` through `serveStatic`.
  - **`ai` 4.x → 7.0.36** and **`@ai-sdk/openai` → 4.0.19**. Fixes the AI SDK filetype-whitelist bypass and `@ai-sdk/provider-utils` uncontrolled resource consumption, and removes `jsondiffpatch` (XSS) from the dependency tree entirely.

  The runner's OpenTelemetry bootstraps are optional dynamic imports and now detect BOTH the 1.x class API and the 2.x factory API, so existing projects that have not upgraded their own OpenTelemetry dependencies keep working.

  Also fixes a latent hang the upgrade exposed: `TracingBootstrap.shutdown()` awaited `provider.shutdown()` unbounded, which force-flushes queued spans through the OTLP exporter and retries indefinitely against an unreachable collector — so graceful shutdown (SIGTERM) never completed. The flush is now bounded via `BLOK_TRACING_SHUTDOWN_TIMEOUT_MS` (default `2000`).

- Updated dependencies
  - @blokjs/shared@1.6.1
  - @blokjs/helper@1.6.1

## 1.6.0

### Minor Changes

- Runtime-boundary hardening: workflow `input` enforcement (ADR 0015) and gRPC payload safety (ADR 0014).

  **Workflow `input` Zod is now enforced at the trigger boundary.** A workflow declaring `input` has each request validated in `TriggerBase.run` before the body reaches any step: the body is `safeParse`d and replaced with the parsed value, so `.default()`s and coercions apply and unknown keys are stripped. Enforced for **http, mcp, grpc, worker, pubsub, and webhook** — the triggers whose body is the caller/producer payload the schema describes. A malformed payload yields `400` (HTTP/webhook), `isError` (MCP), an error status (gRPC), a DLQ'd job with no retries burned (worker), or a dead-lettered/dropped message (pub/sub) — never a poison-message loop. `cron`, `sse` and `websocket` are excluded: their `ctx.request.body` is framework-generated, not caller input. Workflows that declared a schema _and_ read undeclared body fields must switch to `z.object({...}).passthrough()`. Kill switch: `BLOK_VALIDATE_WORKFLOW_INPUT=0`. Undeclared `input` → unchanged.

  **Non-retryable failures are now terminal on worker/pub-sub.** A validation failure carries a `WORKFLOW_INPUT_VALIDATION` tag; worker routes it straight to DLQ instead of exhausting the retry budget, and pub/sub dead-letters (or ACK-drops) it instead of nacking forever. Three worker adapters were fixed to honour the terminal `job.fail(err, false)` contract they previously ignored: **BullMQ** (a discarded job now lands in the failed set with the real error — `moveToFailed` previously threw `Lock mismatch` because the lock token was never captured), **SQS** (deletes, optionally after a DLQ send, instead of waiting out the visibility timeout), and **pg-boss** (no longer re-throws, so it does not retry). A webhook validation failure returns a real 4xx and is not recorded as a processed delivery, so the sender can retry after correcting the payload.

  **Runtime-boundary payload safety.** Non-NodeJS runtime nodes now fail fast with a `GRPC_REQUEST_TOO_LARGE` error naming the node and a per-blob byte breakdown when a request would exceed the gRPC message limit, instead of an opaque `RESOURCE_EXHAUSTED`. New opt-in `BLOK_GRPC_STATE_DIET=1` stops shipping the accumulated workflow state and previous-step output on every remote call (keeps `env` + trigger body); use it only when runtime nodes follow the v2 ABI and never read `ctx.vars` / `ctx.response.data`.

### Patch Changes

- Updated dependencies
  - @blokjs/shared@1.6.0
  - @blokjs/helper@1.6.0

## 0.2.0

### Minor Changes

- Initial public release of Blok packages.

  This release includes:

  - Core packages: @blokjs/shared, @blokjs/helper, @blokjs/runner
  - Node packages: @blokjs/api-call, @blokjs/if-else, @blokjs/react
  - Trigger packages: pubsub, queue, webhook, websocket, worker, cron, grpc
  - CLI tool: blokctl
  - Editor support: @blokjs/lsp-server, @blokjs/syntax

### Patch Changes

- Updated dependencies
  - @blokjs/shared@0.2.0
  - @blokjs/helper@0.2.0

## 0.1.26

### Patch Changes

- extended memory and cpu metrics

## 0.1.25

### Patch Changes

- fixed issue collecting errors counter from node base class

## 0.1.24

### Patch Changes

- Removed request id from the metrics as label.

## 0.1.23

### Patch Changes

- Refactored logging output to structured JSON format for better compatibility with Loki and Grafana. Logs now support queryable fields like `request_id`, `workflow_name`, and `duration_ms`.

## 0.1.22

### Patch Changes

- sync metrics for workflows and nodes, including mem, cpu and errors to nodes.

## 0.1.21

### Patch Changes

- set_var bug fixed and CLI deployment support

## 0.1.20

### Patch Changes

- Updated dependencies
  - @blokjs/helper@0.1.5

## 0.1.19

### Patch Changes

- Python3 runtime implemented in the runner
- Updated dependencies
  - @blokjs/shared@0.0.9

## 0.1.18

### Patch Changes

- Added examples and create project' command to include examples and 'create node' command with options for type ('module' or 'class') and template ('class' or 'ui')
- Updated dependencies
  - @blokjs/shared@0.0.8

## 0.1.17

### Patch Changes

- setSuccess accept JsonLikeObject[] for arrays

## 0.1.16

### Patch Changes

- Added support for YAML, XML and TOML in the workflow file. Upgraded package version recommended by Dependabot.
- Updated dependencies
  - @blokjs/helper@0.1.4
  - @blokjs/shared@0.0.7

## 0.1.15

### Patch Changes

- Improved the BlokService base class to accept a InputType. This force developer to always create a type to define the Node handle input. Added unit test for pending projects like if-else and api-call.

## 0.1.14

### Patch Changes

- Updated dependencies
  - @blokjs/shared@0.0.6

## 0.1.13

### Patch Changes

- Implemented a react node and the chatbot demo page
- Updated dependencies
  - @blokjs/shared@0.0.5

## 0.1.12

### Patch Changes

- Improved Loki metrics
- Updated dependencies
  - @blokjs/shared@0.0.4

## 0.1.11

### Patch Changes

- Fixed invalid metric name

## 0.1.10

### Patch Changes

- Fixed prometheus metrics

## 0.1.9

### Patch Changes

- Improved and extended the open telemetry feature
- Updated dependencies
  - @blokjs/shared@0.0.3

## 0.1.8

### Patch Changes

- Fixed open telemetry issues and types
- Updated dependencies
  - @blokjs/shared@0.0.2

## 0.1.7

### Patch Changes

- Fixed issue with the cli node creation test
- Updated dependencies
  - @blokjs/shared@0.0.1

## 0.1.6

### Patch Changes

- Migrated and refactored shared library

## 0.1.5

### Patch Changes

- e5225d2: Implemented open telemetry and prometheus metrics

## 0.1.4

### Patch Changes

- Updated the imports with new scope
- Updated dependencies
  - @blokjs/helper@0.1.3

## 0.1.3

### Patch Changes

- Changed the module scope to blok
- Updated dependencies
  - @blokjs/helper@0.1.2

## 0.1.2

### Patch Changes

- Changed private to false
- Updated dependencies
  - @blokjs/helper@0.1.1

## 0.1.1

### Patch Changes

- Changed the private property to true

## 0.1.0

### Minor Changes

- Blok code modules initialized

### Patch Changes

- Updated dependencies
  - @blokjs/helper@0.1.0
