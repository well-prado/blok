# `@blokjs/control-plane`

This package is the reference gRPC transport for the Blok agent-harness
control plane. Its `blok.harness.control.v1` service is intentionally separate
from `blok.runtime.v1.NodeRuntime`: it owns session lifecycle, turns, workflow
dispatch, interaction answers, approvals, cancellation, and resumable event
streams.

The default server binds an authenticated `127.0.0.1:0` endpoint and returns an
ephemeral bearer credential. Callers must use contract version `1`; JSON
payloads, metadata, and event envelopes are bounded before reaching a store or
execution hook. The client uses `@grpc/proto-loader` to create the generated
service client from the packaged proto at runtime, so compatibility tests
exercise the same wire descriptor used by consumers.

## Architecture conformance

Governing decisions:

- `docs/architecture/agent-harness/adr/0005-event-sourced-agent-sessions.md`
- `docs/architecture/agent-harness/adr/0006-harness-control-plane.md`

Conformance evidence is in `tests/control-plane.test.ts`: authenticated local
endpoint enforcement, capability negotiation, health/readiness separation,
ordered cursor replay, turn/workflow events, H1-01 answer/resume fencing, and
session ownership/event order after a server restart. The proto-loader client
also verifies the current v1 descriptor and backward-compatible omitted
optional fields without reusing the NodeRuntime contract.
