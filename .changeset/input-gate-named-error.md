---
"@blokjs/shared": patch
"@blokjs/runner": patch
---

ADR 0015 follow-through — the input gate's failure is now a named, exported error.

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
