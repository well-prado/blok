# @blokjs/runner

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
