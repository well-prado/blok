# ADR 0001 — Layered harness boundaries

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

Blok is a workflow engine, not yet a complete interactive agent runtime or an
operating-system sandbox. Treating model tokens, terminal bytes, filesystem
operations, UI state, and durable business steps as one abstraction would
couple unrelated latency, trust, and recovery requirements.

## Decision

Use four explicit layers:

1. A trusted desktop/cloud host owns operating-system effects and process
   supervision.
2. An agent kernel owns the model loop, context, streaming, steering, budgets,
   and event-sourced sessions.
3. Blok owns durable, observable, policy-enforced workflow orchestration.
4. Capability adapters own individual effects behind typed contracts.

The WebView is untrusted. The agent kernel may request effects but cannot bypass
Blok policy or the trusted host. Blok remains useful without the harness; agent
packages remain optional.

## Consequences

- The existing runner gRPC runtime protocol is not reused as the harness
  control plane; their responsibilities and security boundaries differ.
- Streaming model and PTY data does not become one persisted step per chunk.
- Some features require coordinated packages instead of being placed entirely
  in `core/runner`.
- Tauri, cloud, CLI, and headless clients can share the same control plane and
  agent kernel.
