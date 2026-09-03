# H3-04 — Provenance-aware context assembly and compaction

Status: accepted implementation contract

## Governing architecture

This slice conforms to:

- [ADR 0001 — Layered harness boundaries](adr/0001-layered-harness-boundaries.md)
- [ADR 0003 — Capabilities, effects, and policy](adr/0003-capabilities-effects-and-policy.md)
- [ADR 0005 — Event-sourced agent sessions](adr/0005-event-sourced-agent-sessions.md)
- [ADR 0007 — Graph provider and Tetrix](adr/0007-graph-provider-and-tetrix.md)
- [ADR 0010 — Security and behavioral conformance](adr/0010-security-and-behavioral-conformance.md)

The implementation is in `packages/agent-kernel/src/context.ts`. It is a
provider-neutral assembly layer: graph providers, workspace readers, policy
providers, and summarizers remain injected contracts owned by their existing
packages.

## Context contract

`ContextItem` is a bounded model message with a typed source, trust class,
freshness state, truncation marker, optional content hash, and invalidation
identity. Source precedence is fixed by the kernel: policy, workflow, session,
current source, graph, skill, summary, and user. Policy and workflow items are
protected from ordinary eviction and compaction replacement.

Assembly sorts by precedence, source-local order, and stable id. A logical
`dedupeKey` lets current source content replace a graph navigation result for
the same file or range. Same-precedence hash conflicts fail closed. Missing,
stale, conflicting, truncated, and invalidated items remain observable as
bounded diagnostics; stale data is excluded by default. Untrusted repository
content is explicitly labelled as data before it reaches the model and cannot
become policy or workflow instructions.

Token estimates, UTF-8 bytes, item count, and elapsed work are bounded. A
caller may provide a provider-specific estimator, but the default remains
deterministic. Cancellation is propagated to assembly and to the injected
compactor. Compaction can only produce a `summary` item and must return every
protected item; the kernel persists `compaction.started` and
`compaction.completed` events so summaries and replacement identities are
observable and recoverable.

An optional evaluation sink receives bounded token, byte, latency,
omitted-item, stale-context-rate, and task-success measurements after a turn
boundary. It is observational and cannot change the durable turn result.

## Conformance evidence

`packages/agent-kernel/tests/context.test.ts` covers deterministic ordering,
source-over-stale-graph deduplication, explicit untrusted labels, token/byte/
item budgets, conflict and missing evidence handling, path/worktree
invalidation, compaction preservation, and cancellation. The existing
`packages/agent-kernel/tests/agent-kernel.test.ts` continues to cover steering,
stream recovery, stable errors, and durable session boundaries.

The focused commands are:

```text
bun run --filter @blokjs/agent-kernel test
bun run --filter @blokjs/agent-kernel typecheck
bunx biome check packages/agent-kernel/src packages/agent-kernel/tests
git diff --check
```
