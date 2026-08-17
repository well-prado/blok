---
"@blokjs/shared": patch
"@blokjs/runner": patch
"@blokjs/trigger-worker": patch
---

A step's `retry.nonRetryableErrorNames` now stops the worker JOB, not just the step (#679).

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
