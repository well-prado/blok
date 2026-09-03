# Blok Coding Harness and Enforced Agent Workflows

Status: accepted architecture baseline

Date: 2026-08-31

Audience: framework maintainers, agent-runtime authors, security reviewers,
SDK authors, desktop authors, and AI agents implementing the roadmap

## Objective

Make Blok a safe, provider-neutral foundation for coding harnesses and other AI
systems that must execute repeatable procedures. Blok workflows own durable,
observable orchestration. A dedicated agent kernel owns model turns, context,
streaming, compaction, and steering. A trusted host owns operating-system
effects. The model receives only the capabilities permitted by the active
workflow phase.

The defining product rule is:

> Everything composable is a workflow. Everything effectful is a capability.

The defining enforcement rule is:

> An AI is not prompted to follow a workflow. The runtime makes an invalid
> transition or out-of-scope capability call impossible.

## Target architecture

```text
Tauri WebView
  chat, plans, code, diffs, approvals, traces, terminals
            |
            | typed Tauri IPC / ordered channels
            v
Trusted Rust host
  process supervision, PTY, filesystem boundary, secure storage,
  approvals, updates, runtime-pack installation
            |
            | authenticated local control plane
            v
Agent kernel
  session log, model loop, context assembly, compaction, steering,
  budgets, model-provider adapters, tool/workflow dispatch
            |
            | typed workflow and capability calls
            v
Blok runner
  enforced workflows, retries, durable suspension, concurrency,
  sub-workflows, tracing, evidence, policy interception
            |
            v
Capabilities
  filesystem, Git, shell, LSP, browser, models, Tetrix, secrets,
  databases, queues, and remote executors
```

## Non-negotiable invariants

1. The WebView never receives unrestricted filesystem, process, network, or
   secret access.
2. The model never receives raw operating-system APIs. Code Mode sees generated
   bindings whose calls re-enter the normal policy pipeline.
3. Selecting a strict workflow pins its definition, node versions, capability
   manifest, model configuration, and policy for the run.
4. Every effectful invocation is authorized before execution and produces an
   immutable audit event after execution.
5. Child workflows and parallel branches can only narrow permissions:
   `effective = parent intersection child-requested intersection policy`.
6. The model cannot attest that a check passed. Evidence comes from a trusted
   capability or deterministic step and is verified by a gate.
7. Session history is event-sourced and recoverable independently of workflow
   replay. Replay is not treated as checkpoint restoration.
8. Tetrix and other graph providers are derived indexes. The current
   filesystem/worktree is authoritative for code reads and writes.
9. Bounded work is the default: bytes, time, memory, output, processes,
   concurrency, network destinations, and path scope all have ceilings.
10. Security-sensitive behavior fails closed when policy, identity, metadata,
    or sandbox state is missing.

## Component ownership

| Component | Owns | Must not own |
|---|---|---|
| `core/runner` | generic effects, policies, durable suspension, evidence, permission inheritance | model-provider UI or Tauri-specific behavior |
| `packages/control-plane` | start, stream, steer, approve, cancel, resume, inspect | direct OS access |
| `packages/agent-kernel` | model loop, session derivation, context, compaction, budgets | bypass paths around the runner policy pipeline |
| `packages/code-mode` | constrained TypeScript programs and generated bindings | ambient `fs`, `process`, network, imports, or secrets |
| `packages/capabilities` | typed contracts and trusted adapters for effects | workflow business policy |
| desktop host | OS trust boundary, sidecar supervision, secure storage, updates | workflow semantics |
| Tetrix adapter | indexed relationships and provenance | authoritative source contents or session truth |

Names may be refined during implementation, but ownership boundaries require a
superseding ADR to change.

## Accepted decisions

1. [ADR 0001: Layered harness boundaries](adr/0001-layered-harness-boundaries.md)
2. [ADR 0002: Enforced agent workflows](adr/0002-enforced-agent-workflows.md)
3. [ADR 0003: Capabilities, effects, and policy](adr/0003-capabilities-effects-and-policy.md)
4. [ADR 0004: Constrained Code Mode](adr/0004-constrained-code-mode.md)
5. [ADR 0005: Event-sourced agent sessions](adr/0005-event-sourced-agent-sessions.md)
6. [ADR 0006: Harness control plane](adr/0006-harness-control-plane.md)
7. [ADR 0007: Graph provider and Tetrix](adr/0007-graph-provider-and-tetrix.md)
8. [ADR 0008: Parallel and child permission inheritance](adr/0008-parallel-and-child-permissions.md)
9. [ADR 0009: Desktop packaging and runtime packs](adr/0009-desktop-packaging.md)
10. [ADR 0010: Security and behavioral conformance](adr/0010-security-and-behavioral-conformance.md)

## Delivery roadmap

The dependency-ordered implementation plan lives in
[ROADMAP.md](ROADMAP.md). GitHub issues are execution records; this directory
remains the architectural source of truth.

The H1-02 runner enforcement contract is documented in
[h1-02-runner-enforcement.md](h1-02-runner-enforcement.md).

The H1-02 reference strict coding procedure and its conformance evidence are
documented in [h1-02-reference-workflow.md](h1-02-reference-workflow.md).

The H1-03 shared profile and binding contract is documented in
[h1-03-enforcement-profiles-and-binding.md](h1-03-enforcement-profiles-and-binding.md).

The H3-02 Git/worktree and bounded process capability contract is documented in
[h3-02-git-and-process-capabilities.md](h3-02-git-and-process-capabilities.md).

- [GitHub Project 11: Blok AI Harness & Enforced Workflows](https://github.com/users/well-prado/projects/11)
- [Epic #913: Blok coding harness and enforced agent workflows](https://github.com/well-prado/blok/issues/913)

## Pull-request conformance checklist

Every roadmap pull request must answer:

- Which accepted ADRs govern this change?
- Does the implementation preserve every relevant invariant?
- What automated test proves the contract?
- What attack, crash, concurrency, or compatibility case was considered?
- Does the catalog/control-plane schema remain backward compatible?
- Were documentation and generated contracts updated together?

If the implementation needs to violate an accepted decision, stop and propose a
superseding ADR before changing runtime code.
