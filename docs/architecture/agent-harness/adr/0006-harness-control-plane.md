# ADR 0006 — Harness control plane

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

The desktop, CLI, cloud, and tests need a stable interface for interactive
agent sessions. Existing runtime-node gRPC and public workflow triggers do not
provide lifecycle ownership, steering, approvals, ordered event resumption, or
desktop authentication.

## Decision

Define a versioned harness control-plane protocol with operations to create,
open, fork, and inspect sessions; submit and steer turns; start workflows;
stream ordered events; answer interactions; approve or deny effects; cancel;
and resume from a cursor.

Use gRPC for the reference remote/local transport, with explicit deadlines,
cancellation, bounded messages, resumable sequence cursors, health/readiness,
and compatibility tests. Local desktop transport uses an authenticated endpoint
owned by the trusted host; it must not bind an unauthenticated fixed public
port. The protocol is distinct from runner-to-language-runtime execution.

## Consequences

- A new proto and generated clients are required.
- UI streaming is decoupled from workflow SSE events and may bridge to ordered
  Tauri channels.
- Authentication, endpoint discovery, and token rotation are host concerns.
- Protocol compatibility becomes a release gate.
