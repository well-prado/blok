# ADR 0010 — Security and behavioral conformance

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

Unit tests and happy-path demos do not prove that an AI follows a workflow or
that hostile repository content cannot escape its permissions. The harness
crosses model, workflow, OS, network, secret, persistence, and parallel-runtime
boundaries.

## Decision

Maintain a repository-owned conformance campaign covering:

- required-step adherence and invalid-transition rejection;
- out-of-phase and undeclared capability denial;
- path traversal, symlink escape, command injection, and network exfiltration;
- secret non-disclosure in model context, traces, outputs, and errors;
- malicious repository prompt injection;
- process crashes and restart at every durable boundary;
- approval expiry, denial, duplicate answers, and identity mismatch;
- Code Mode time, memory, output, call, and concurrency limits;
- sub-workflow and parallel-branch non-escalation;
- cancellation, retry, idempotency, backpressure, and partial failure;
- stale graph results and authoritative-source conflicts;
- protocol and cross-runtime contract compatibility.

Security-sensitive suites fail closed and run in CI-supported isolated
environments. Release evidence records environment, versions, raw results, and
known exceptions. No “production-ready” claim is made while a critical class is
uncovered or bypassable.

## Consequences

- Threat modeling and test fixtures are implementation deliverables, not later
  documentation work.
- The vertical slice must demonstrate denied attacks as well as successful
  coding tasks.
- Performance targets are measured only after correctness and isolation gates
  pass.
