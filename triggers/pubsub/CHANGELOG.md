# @blokjs/trigger-pubsub

## 1.6.0

### Minor Changes

- Runtime-boundary hardening: workflow `input` enforcement (ADR 0015) and gRPC payload safety (ADR 0014).

  **Workflow `input` Zod is now enforced at the trigger boundary.** A workflow declaring `input` has each request validated in `TriggerBase.run` before the body reaches any step: the body is `safeParse`d and replaced with the parsed value, so `.default()`s and coercions apply and unknown keys are stripped. Enforced for **http, mcp, grpc, worker, pubsub, and webhook** — the triggers whose body is the caller/producer payload the schema describes. A malformed payload yields `400` (HTTP/webhook), `isError` (MCP), an error status (gRPC), a DLQ'd job with no retries burned (worker), or a dead-lettered/dropped message (pub/sub) — never a poison-message loop. `cron`, `sse` and `websocket` are excluded: their `ctx.request.body` is framework-generated, not caller input. Workflows that declared a schema _and_ read undeclared body fields must switch to `z.object({...}).passthrough()`. Kill switch: `BLOK_VALIDATE_WORKFLOW_INPUT=0`. Undeclared `input` → unchanged.

  **Non-retryable failures are now terminal on worker/pub-sub.** A validation failure carries a `WORKFLOW_INPUT_VALIDATION` tag; worker routes it straight to DLQ instead of exhausting the retry budget, and pub/sub dead-letters (or ACK-drops) it instead of nacking forever. Three worker adapters were fixed to honour the terminal `job.fail(err, false)` contract they previously ignored: **BullMQ** (a discarded job now lands in the failed set with the real error — `moveToFailed` previously threw `Lock mismatch` because the lock token was never captured), **SQS** (deletes, optionally after a DLQ send, instead of waiting out the visibility timeout), and **pg-boss** (no longer re-throws, so it does not retry). A webhook validation failure returns a real 4xx and is not recorded as a processed delivery, so the sender can retry after correcting the payload.

  **Runtime-boundary payload safety.** Non-NodeJS runtime nodes now fail fast with a `GRPC_REQUEST_TOO_LARGE` error naming the node and a per-blob byte breakdown when a request would exceed the gRPC message limit, instead of an opaque `RESOURCE_EXHAUSTED`. New opt-in `BLOK_GRPC_STATE_DIET=1` stops shipping the accumulated workflow state and previous-step output on every remote call (keeps `env` + trigger body); use it only when runtime nodes follow the v2 ABI and never read `ctx.vars` / `ctx.response.data`.

### Patch Changes

- Updated dependencies
  - @blokjs/shared@1.6.0
  - @blokjs/runner@1.6.0
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
  - @blokjs/runner@0.2.0
