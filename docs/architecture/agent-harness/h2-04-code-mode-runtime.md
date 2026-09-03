# H2-04 — Constrained TypeScript Code Mode runtime

`@blokjs/code-mode` is the runtime boundary for ephemeral, model-authored
TypeScript function bodies. It is deliberately separate from the agent kernel:
the kernel owns model turns and durable session events, while this package owns
one bounded code invocation. A kernel `AgentDispatcher` or runner node can
adapt to this API without giving the model a policy bypass.

## Boundary

The host sends source, bounded JSON input, and binding names to a fresh
`worker_threads` worker. The worker creates a `node:vm` context containing only
`input`, `bindings`, `log`, and `emit`. The model source is never run as a host
module and no host object is placed in the context. The worker is disposed on
all terminal paths. `resourceLimits` provide a V8 heap ceiling; wall time and
cancellation terminate the worker because asynchronous code cannot be safely
bounded by a VM synchronous timeout alone.

The VM is not treated as a complete security boundary. The required defense in
depth is: source-size and AST validation, no imports/module loading, no
constructors or dynamic code loading, no ambient OS/network/environment
identifiers, no timers or nondeterministic globals, frozen input/bindings,
worker isolation, and bounded host-to-worker messages. A deployment that needs
stronger adversarial isolation can place this package behind a process or
desktop sandbox without changing the binding contract.

## Binding and policy contract

Bindings are the generated, phase-scoped catalog surface. Each binding carries
Zod input/output schemas, a v1 agent-compatible capability manifest, and an
authority envelope. Secret effects and secret references are rejected at
registration. A binding authority must match its declared manifest and be a
subset of the active parent authority.

For every direct or nested call, the runtime:

1. validates the JSON input and binding schema;
2. intersects the binding authority with the active parent scope;
3. calls the existing shared `CapabilityAuthorizationPort` with the binding
   manifest and policy identity;
4. rejects malformed, denied, asked, unsandboxed, or widened decisions; and
5. invokes the trusted host adapter and validates its bounded JSON output.

This package never interprets policy rules, grants capabilities, reads the
filesystem, resolves graph data, loads secrets, or writes session state. Those
remain owned by the runner, capability adapters, graph provider, and session
contracts respectively. The authorization port must therefore be backed by
the normal H0-03 runner/capability policy pipeline in production.

## Bounds and deterministic behavior

The runtime bounds source/input/output bytes, wall time, worker heap, binding
calls, call nesting, and active parallel calls. `log` and `emit` values are
bounded JSON and count against output. Call IDs and binding exposure order are
deterministic; no clock, random source, module loader, timer, network API, or
environment is exposed. Intermediate values stay in the worker. Only validated
call results and the final bounded result cross the boundary.

## Threat model and adversarial corpus

The conformance suite treats source as hostile model input and binding handlers
as trusted host adapters. It exercises import/module loading, process,
filesystem, network, environment, secret, constructor/prototype, mapper, and
regular-expression escape attempts; unbounded CPU, heap, output, calls, and
parallel calls; policy denial; invalid schemas; cancellation; and nested
authority widening. A policy denial is observable only as a stable bounded
error, and a handler is never entered before authorization. The VM is defense-
in-depth rather than a claim of perfect isolation; deployments requiring a
stronger host boundary can supervise this worker behind a process or desktop
sandbox using the same contract.

## Governing ADRs

- `docs/architecture/agent-harness/adr/0001-layered-harness-boundaries.md`
- `docs/architecture/agent-harness/adr/0003-capabilities-effects-and-policy.md`
- `docs/architecture/agent-harness/adr/0004-constrained-code-mode.md`
- `docs/architecture/agent-harness/adr/0005-event-sourced-agent-sessions.md`
- `docs/architecture/agent-harness/adr/0007-graph-provider-and-tetrix.md`
- `docs/architecture/agent-harness/adr/0008-parallel-and-child-permissions.md`
- `docs/architecture/agent-harness/adr/0010-security-and-behavioral-conformance.md`
