# v0.5 Workflow Primitives — Mock Examples

These are **mock workflows** illustrating the proposed v0.5 control-flow primitives from [`docs/c/devtools/workflow-primitives-roadmap.mdx`](../../docs/c/devtools/workflow-primitives-roadmap.mdx). They are NOT executable today — they reference primitives (`forEach`, `loop`, `switch`, `tryCatch`, `middleware`) that haven't shipped yet, plus illustrative node names (`stripe-charge`, `csv-parser`, `verify-jwt-node`) that aren't real nodes in the scaffold.

The point is to evaluate **readability** before shipping any code. Read each file top-to-bottom and check whether the intent is clear without consulting the spec.

## Coverage map

| File | Primitives demonstrated | Real-world scenario |
|---|---|---|
| `01-order-fulfillment.json` | `switch` + `forEach` (parallel) + `tryCatch` + middleware | E-commerce checkout: route by order type, fan out items, charge with retry, audit on failure |
| `02-async-job-poller.json` | `loop` + `wait` + `switch` | Submit a long-running job and poll until done/failed/timeout |
| `03-webhook-fanout.json` | `forEach` (parallel, bounded concurrency) | Dispatch one event to N webhook subscribers with retry + idempotency |
| `04-multi-tenant-router.json` | `switch` + `subworkflow` + middleware | Per-tenant routing where each tenant has its own sub-workflow |
| `05-csv-import-pipeline.json` | `forEach` (sequential) + `tryCatch` (DLQ) + middleware | Bulk CSV import with row-level error isolation |
| `06-admin-delete-user.json` | middleware chain | Three middleware (auth + admin + audit) then a one-step handler |
| `07-middleware-auth-check.json` | middleware definition (workflow with `middleware: true`) | The reusable JWT-verify middleware referenced by other examples |
| `08-middleware-rate-limit.json` | middleware definition + `branch` with `stop` | Reusable rate-limit middleware with 429 short-circuit |
| `09-polling-with-backoff.json` | `loop` + dynamic `wait` (exponential backoff) | Polling pattern with growing delays and `maxIterations` safety |
| `10-github-webhook-router.json` | `switch` (array `when` for grouping) + `subworkflow` + middleware | GitHub webhook handler routing by `X-GitHub-Event` |
| `11-user-signup-saga.json` | `tryCatch` (try + catch + finally) + `branch` (rollback) | Multi-step signup with conditional rollback on failure |
| `12-data-export-pipeline.json` | `forEach` + `tryCatch` (per-page) + per-step `retry` | Resilient paginated export — one bad page doesn't kill the job |
| `13-nested-control-flow.json` | `forEach` > `tryCatch` > `switch` > `branch` | Deep nesting — proves the primitives compose cleanly |
| `14-travel-booking-saga.json` | `tryCatch` + `branch` chain (compensating actions) | Distributed transaction with manual rollback in the catch arm |
| `15-hello-with-global-middleware.json` | process-global middleware via `WorkflowRegistry.useGlobalMiddleware()` | Minimal workflow demonstrating that ops middleware can wrap any workflow without per-route config |

## What's NOT mocked

- The `wait`, `branch`, `subworkflow`, regular step shapes — these already work today (v0.4).
- Step-level `retry`, `idempotencyKey`, `maxDuration`, `concurrencyKey` — these already work today (Tier 1 + Tier 2).
- The proxy expressions `$.req`, `$.state`, `$.env`, `$.error`, `$.prev` — already work today.

The new shapes the examples assume:

- **`forEach`** step shape with `{ in, as, mode, concurrency, do }` config
- **`loop`** step shape with `{ while, maxIterations, do }` config
- **`switch`** step shape with `{ on, cases: [{when, do}], default }` config
- **`tryCatch`** step shape with `{ try, catch, finally }` config
- **`middleware: true`** flag on the workflow envelope (marks a middleware-only workflow with no trigger)
- **`middleware: string[]`** field on `trigger.<kind>.middleware` AND on the workflow envelope
- **`$.error`** proxy accessible inside `catch` arms (carries `message`, `code`, `name`, `stack`)
- A new `WorkflowRegistry.useGlobalMiddleware(names: string[])` API for process-wide middleware

## Reading order

For first read I'd suggest:

1. `01-order-fulfillment.json` — the flagship; shows everything together
2. `02-async-job-poller.json` — simplest `loop` example
3. `09-polling-with-backoff.json` — `loop` with computed delay
4. `11-user-signup-saga.json` — `tryCatch` with try/catch/finally
5. `13-nested-control-flow.json` — proof that nesting works without ceremony

If those read cleanly, the rest mostly fall out of the same patterns.

## How to give feedback

For each example, evaluate:

- Can a non-Blok-expert read top-to-bottom and grasp the intent?
- Is each primitive's name (`forEach`, `loop`, `switch`, `tryCatch`) doing the right disambiguation work?
- Are field names (`in`, `as`, `mode`, `concurrency`, `while`, `on`, `cases`, `when`, `do`, `try`, `catch`, `finally`) intuitive without reading the spec?
- Where does the JSON shape feel awkward? (Nesting depth, trailing commas, field ordering, etc.)

Concrete suggestions (rename `forEach` → `each`, change `do` → `steps`, etc.) are easy to apply before any code lands.
