# ADR 0002 — Enforced agent workflows

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

Prompt instructions such as “always inspect, plan, test, and review” are not an
enforcement mechanism. Models can omit steps, fabricate evidence, call a tool
early, or lose instructions during compaction. Repetitive procedures require a
runtime-owned state machine.

## Decision

Blok workflows own control flow. An AI executes only inside explicit agent
steps. Required deterministic steps, branches, joins, assertions, evidence
gates, approvals, and completion criteria remain runner-owned transitions.

Support three enforcement profiles:

- `advisory`: deviations are permitted and recorded;
- `guided`: transitions are enforced, with an authorized human override;
- `strict`: transitions and capabilities are enforced without an in-run bypass.

Binding rules select and version-pin workflows from trusted task metadata such
as repository, task kind, path, label, tenant, or environment. The runtime
validates every transition. A model-produced statement is never accepted as
proof that a deterministic check ran.

The language-neutral H1-03 contract for these profiles, binding inputs, trusted
workflow references, pinned run identities, and guided override events is
defined in [h1-03-enforcement-profiles-and-binding.md](../h1-03-enforcement-profiles-and-binding.md).

## Consequences

- The model cannot choose to skip a required step.
- Human overrides are explicit audit events, not hidden flags.
- Workflow quality becomes critical: a bad strict workflow enforces a bad
  process reliably, so versioning, review, and escape-by-new-authorized-run are
  required.
- Existing ordinary workflows remain compatible and default to their current
  behavior.
