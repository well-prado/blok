# ADR 0003 — Capabilities, effects, and policy

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

Schemas describe values but do not describe operational risk. Tags are useful
for discovery but are insufficient for authorization. A coding harness must
distinguish reads, writes, process execution, network access, secret use,
destructive behavior, and resource bounds before execution.

## Decision

Add a structured, language-neutral capability manifest to node and workflow
catalog contracts. It includes effects, required capabilities, secret
references, determinism/idempotency class, resource bounds, maturity, and
applicable trigger/runtime constraints.

Every effectful invocation passes through one pre-execution policy pipeline.
The policy result is `allow`, `deny`, `ask`, or `require-sandbox`, with bounded
reasons and matched rules. Missing metadata or policy fails closed for
agent-originated execution. Post-execution emits an immutable normalized audit
event.

Secrets are opaque references resolved by trusted capabilities. Raw credentials
must not appear in workflow input, output, trace state, Code Mode bindings, or
model context.

## Consequences

- Catalog and gRPC descriptor schemas gain backward-compatible fields.
- All SDKs need shared conformance fixtures.
- Existing nodes without metadata require a compatibility classification; they
  are not silently considered safe for agent execution.
- Deployment and desktop policies share one decision contract even when their
  sandbox implementations differ.
