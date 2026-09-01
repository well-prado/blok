# ADR 0008 — Parallel and child permission inheritance

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

Parallel agents and sub-workflows increase throughput but create permission,
state-isolation, cancellation, join, and duplicated-side-effect hazards. A child
must not gain authority merely by being delegated work.

## Decision

Effective permissions are monotonic:

```text
effective = parent envelope ∩ child request ∩ active policy
```

Each branch receives isolated transient state, budgets, cancellation scope, and
audit lineage. Cross-branch data moves only through declared outputs and join
contracts. Required joins verify the completion/evidence obligations of every
required branch. Cancellation is structured and cannot be confused with
successful completion. Retried or resumed effects require idempotency evidence.

## Consequences

- Delegation can specialize but never escalate authority.
- Parallel branches cannot communicate through mutable shared workflow state.
- Budget allocation, branch limits, cancellation, and join failures become
  first-class trace events.
- Conformance must include wait/resume and failure injection inside parallel
  branches.
