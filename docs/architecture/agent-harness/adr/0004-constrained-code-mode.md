# ADR 0004 — Constrained Code Mode

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

Code Mode lets a model compose typed multi-step operations efficiently, but
arbitrary TypeScript with ambient filesystem, process, imports, network, or
environment access would bypass workflow policy and expose the host.

## Decision

Code Mode executes an ephemeral, bounded TypeScript function in an isolated
runtime. Its only ambient API is a generated binding object for workflows and
capabilities visible in the active phase. Every nested call re-enters schema
validation, policy, tracing, cancellation, concurrency, and output limiting.

The runtime forbids native imports, module loading, direct `process`, direct
filesystem/network APIs, environment access, and Blok expression escape
hatches. It enforces time, memory, output, nested-call, and parallelism budgets.
Intermediate values are execution-local; durable facts cross the boundary only
through normalized call results and the final bounded result.

## Consequences

- Code Mode is not a general local JavaScript shell.
- Generated types and runtime schemas come from the same catalog contract.
- Parallel subcalls are permitted only within the phase budget and capability
  envelope.
- The sandbox implementation requires adversarial testing on every supported
  host platform.
