---
"@blokjs/runner": minor
"@blokjs/helper": minor
"@blokjs/shared": minor
---

Add declarative selective retry via `retry.nonRetryableErrorNames`.

Steps may now list error names that must never be retried. When a thrown
error, a soft `response.error`, or any wrapped `cause` carries a matching
name — `Error.name` or `GlobalError.context.name` — the step fails on the
current attempt with no further retries or backoff. Undeclared names keep the
existing bounded exponential-backoff behaviour, and control-flow signals
(`WaitDispatchRequest`, `RunCancelledError`) are never affected.

```ts
retry: {
  maxAttempts: 3,
  minTimeoutInMs: 1000,
  nonRetryableErrorNames: ["VALIDATION_FAILED", "SNAPSHOT_CHANGED"],
}
```

Additive and backward compatible: the field is optional, and omitting it
reproduces prior behaviour exactly. The published `workflow.v2.json` schema
gains the optional field.
