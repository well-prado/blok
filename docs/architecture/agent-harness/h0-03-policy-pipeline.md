# H0-03 policy pipeline design

Issue #916 places one runner-owned authorization boundary around leaf-step
execution. `RunnerSteps` remains the only place that owns retries and
idempotency, so authorization is performed after input preparation and before
each attempt. Cache hits are authorized before replay and are audited as
replays, not executions.

Agent execution is opt-in through a trusted runner call that installs an
opaque per-context policy state. Ordinary contexts have no policy state and
retain the existing behavior. The state is held in a private WeakMap and is
copied by `createChildContext`; it is never exposed as a mutable Context field.

The policy provider receives normalized, bounded data and returns a typed
decision. Composition is deployment, repository, workflow, phase, then user;
the first deny is terminal, `require-sandbox` dominates `ask`, and malformed,
missing, timed-out, or exceptional policy state fails closed. `ask` emits an
interaction request through an injected suspension port and throws a typed
control signal when no durable port is available.

Pre-audit persistence is a gate: a failed append prevents execution. A
post-audit failure is reported as critical after the effect and never claims
the effect was rolled back. Audit records are immutable snapshots with bounded
strings, rule counts, scope fragments, and serialized size; secret-like keys
and values are redacted.

Runtime nodes use the manifest already attached to their trusted resolved node
descriptor. Workflow input and request metadata are never consulted for agent
identity or authority.
