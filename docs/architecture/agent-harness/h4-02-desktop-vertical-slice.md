# H4-02 — Desktop coding-harness vertical slice

Status: boundary slice

This slice connects the existing harness contracts into one headless desktop
workflow surface. It is intentionally a narrow vertical slice: the Tauri host
remains the OS trust boundary, while the TypeScript runtime owns the enforced
workflow and the control-plane client is the UI-facing seam.

## Reference procedure

`@blokjs/desktop` exposes the reference workflow
`strict-coding-reference` with these durable phases:

```text
understand -> plan -> approve -> implement -> test -> review
```

The runtime records phase transitions, policy decisions, approval state,
graph freshness/fallback, worktree identity, trusted test evidence, and the
review diff in the event-sourced session. `DesktopCodingHarnessClient` runs
the same procedure through `HarnessControlPlaneClient`, so the workflow does
not depend on a desktop renderer.

## Architecture Conformance

| Boundary requirement | Evidence in this slice |
| --- | --- |
| Workflow transitions are runtime-owned | `CodingHarnessRuntime` gates each phase and persists completion before advancing. |
| Effectful calls re-enter policy | Git, graph, source, workspace-write, process, and review calls each receive a policy request. |
| Approval is durable and restartable | H1-01 interaction records are shared by the runtime and control plane; approval identity and sequence are persisted. |
| Task worktree is authoritative for writes/tests | Worktree identity is persisted, writes are workspace-checked, and test cwd must exactly match it. |
| Code Mode is phase-scoped | Internally created model kernels receive only the generated surface for the current Code Mode phase. |
| Graph is navigation-only | Stale or non-fresh graph status causes authoritative source reads before planning completes. |
| Trusted evidence gates review | Only a completed foreground process result can produce passing test evidence. |
| Recovery does not duplicate completed work | Terminal runs are idempotent; partial implementation recovery reuses the persisted worktree. |
| Cancellation is distinct from success | Abort signals stop the workflow and persist a cancelled terminal event; only an answered approval may resume that path. |

## Governing ADR paths

- `docs/architecture/agent-harness/adr/0001-layered-harness-boundaries.md`
- `docs/architecture/agent-harness/adr/0002-enforced-agent-workflows.md`
- `docs/architecture/agent-harness/adr/0003-capabilities-effects-and-policy.md`
- `docs/architecture/agent-harness/adr/0004-constrained-code-mode.md`
- `docs/architecture/agent-harness/adr/0005-event-sourced-agent-sessions.md`
- `docs/architecture/agent-harness/adr/0006-harness-control-plane.md`
- `docs/architecture/agent-harness/adr/0007-graph-provider-and-tetrix.md`
- `docs/architecture/agent-harness/adr/0009-desktop-packaging.md`
- `docs/architecture/agent-harness/adr/0010-security-and-behavioral-conformance.md`

## Boundary rules

- Repository inspection, graph lookup, and authoritative source reads happen
  before approval and are read-only.
- Worktree creation and workspace writes happen only after the durable
  approval is answered. Every write is required to identify the task worktree.
- Process execution is policy-authorized and its result must be a foreground
  completion from the process capability. Test evidence is emitted by the
  trusted process boundary; model output cannot mark a test as passed.
- Graph data is treated as a derived index. A stale or partial result causes
  an authoritative source read before planning can complete.
- Control-plane approval events include the interaction/approval identity, so
  a reopened session can reconstruct pending or resolved approval state.
- Cancellation is propagated through the workflow signal, model kernel, and
  process capability; terminal failure/cancellation is appended to the
  session rather than inferred from a UI status.

## Conformance evidence

The focused suite is:

```bash
bun run --filter @blokjs/desktop typecheck
bun run --filter @blokjs/desktop test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

The tests cover read-only planning, stale-graph fallback, durable approval and
restart recovery, worktree confinement, trusted process evidence, phase-scoped
Code Mode catalogs, cancellation, shell-string rejection, and rejection of a
process working directory outside the task worktree. The repository-level
release checks are `bun run build`, `bun run lint:check`, and `git diff --check`.

## Governing decisions

- [ADR 0002 — Enforced agent workflows](adr/0002-enforced-agent-workflows.md)
- [ADR 0003 — Capabilities, effects, and policy](adr/0003-capabilities-effects-and-policy.md)
- [ADR 0004 — Constrained Code Mode](adr/0004-constrained-code-mode.md)
- [ADR 0005 — Event-sourced agent sessions](adr/0005-event-sourced-agent-sessions.md)
- [ADR 0006 — Harness control plane](adr/0006-harness-control-plane.md)
- [ADR 0007 — Graph provider and Tetrix](adr/0007-graph-provider-and-tetrix.md)
- [ADR 0009 — Desktop packaging and runtime packs](adr/0009-desktop-packaging.md)
- [ADR 0010 — Security and behavioral conformance](adr/0010-security-and-behavioral-conformance.md)

The renderer, production Git/filesystem/process adapters, model-provider
configuration, and release packaging remain follow-up integration work. This
slice keeps those concerns behind typed ports and does not grant the WebView
direct access to them.
