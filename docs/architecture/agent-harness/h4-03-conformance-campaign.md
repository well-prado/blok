# H4-03 security, recovery, parallelism, and adherence campaign

Status: campaign harness and deterministic local evidence

The release gate requires adversarial evidence across workflow, policy, model,
host, persistence, and parallel-runtime boundaries. The executable harness is
`@blokjs/conformance` in `packages/conformance`. It consumes existing public
contracts and adapters; it does not replace policy, capability, session, or
workflow implementations.

## Architecture Conformance

This campaign preserves the accepted architecture invariants:

- capability and policy checks stay on the existing runner/shared boundary;
- model-authored evidence is never promoted to trusted evidence;
- child/parallel authority is checked as an intersection and cannot widen;
- Code Mode is exercised only through generated bindings and bounded worker
  execution;
- graph data is treated as derived navigation context, not an authority to
  write source;
- session and interaction recovery use durable contracts and idempotency
  fences;
- platform-dependent claims are reported as `deferred`, never as passes, when
  the required trusted host or release runner is unavailable.

## Coverage matrix

| Campaign case | Deterministic local evidence | Deferred integration seam |
| --- | --- | --- |
| `security.policy-evidence` | deny-before-effect, missing/invalid manifest, widened child authority, non-union parallel authority, fabricated/skipped evidence, retry evidence | H4-02 transition dispatcher |
| `security.secrets-redaction` | nested payload, policy fragment, decision text, and manifest canary checks | native secure-store and model-provider egress tests |
| `security.filesystem-boundary` | relative traversal, symlink escape, hardlink escape, safe-file control | Windows/macOS host parity |
| `security.process-boundary` | argv metacharacters, explicit shell classification/denial, bounded output chunks | real spawn, PTY/process-tree, special files |
| `security.code-mode` | imports/process/network/mapper escapes, output budget, policy-before-handler | stronger desktop/process sandbox |
| `integrity.graph-context` | stale branch, content conflict, navigation-only provenance, stale context exclusion | authoritative reread/write conflict through H4-02 |
| `recovery.approvals-sessions` | principal/sequence fencing, duplicate answer, claim, denial, cancellation, expiry, event idempotency, SQLite reopen | crash injection at every desktop/store boundary |
| `security.filesystem-race-special-file` | — | TOCTOU replacement and FIFO/socket/device handling through trusted host adapters |
| `recovery.crash-restart-infra` | — | H4-02 desktop sidecar and native release runners |
| `workflow.h4-02-adherence` | — | strict `understand → plan → approve → implement → test → review` transition enforcement |

The local profile has no external services and its environment manifest records
that fact. It does not claim coverage for Postgres, brokers, native desktop
bundles, real PTYs, platform secure stores, or Tetrix transport deployments.

## Reproducible results

`runCampaign()` returns a versioned report with sorted case IDs, status,
bounded evidence labels, summary counts, and an environment manifest. The
default `serializeCampaignReport()` form excludes timing so two runs can be
compared byte-for-byte. `includeTiming: true` is available for diagnostics but
is intentionally not the reproducibility format. The source commit is supplied
by `BLOK_CONFORMANCE_COMMIT` or `GITHUB_SHA`; otherwise it is explicitly
`unknown`, and dirty state is `null` unless the caller supplies
`BLOK_CONFORMANCE_DIRTY`.

## H4-02 integration plan

The H4-02 vertical slice should invoke the same `runCampaign()` with an
integration adapter at the deferred seams rather than fork this fixture set.
The adapter should provide: strict workflow transition dispatch and durable
cursor inspection; a trusted-host filesystem/process boundary with race and
special-file controls; crash/restart injection; and authoritative source
re-read before graph-informed writes. Those additions should change deferred
case status to `passed` only after they produce the same bounded evidence and
identity lineage required by the existing contracts.

## Governing ADR paths

- `docs/architecture/agent-harness/adr/0001-layered-harness-boundaries.md`
- `docs/architecture/agent-harness/adr/0002-enforced-agent-workflows.md`
- `docs/architecture/agent-harness/adr/0003-capabilities-effects-and-policy.md`
- `docs/architecture/agent-harness/adr/0004-constrained-code-mode.md`
- `docs/architecture/agent-harness/adr/0005-event-sourced-agent-sessions.md`
- `docs/architecture/agent-harness/adr/0006-harness-control-plane.md`
- `docs/architecture/agent-harness/adr/0007-graph-provider-and-tetrix.md`
- `docs/architecture/agent-harness/adr/0008-parallel-and-child-permissions.md`
- `docs/architecture/agent-harness/adr/0009-desktop-packaging.md`
- `docs/architecture/agent-harness/adr/0010-security-and-behavioral-conformance.md`

## Conformance evidence

Run the deterministic campaign with:

```sh
bun run conformance:test
bun run conformance:report > conformance-report.json
```

The test asserts zero failed local cases, explicit deferred records for H4-02
and platform-only work, and stable machine-readable output. The report command
emits the same timing-free JSON plus the environment manifest and exits nonzero
if any local case fails. Focused contract tests remain authoritative for
implementation detail: the runner policy and interaction suites,
`packages/capabilities/tests`, `packages/code-mode/tests`,
`packages/agent-kernel/tests`, and the shared H1-04 conformance suite.
