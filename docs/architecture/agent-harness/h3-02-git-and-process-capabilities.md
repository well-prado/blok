# H3-02 — Git/worktree and bounded process capability contracts

Status: contract baseline

This slice defines the language-neutral shared contracts for issue #928. It
does not execute Git, create operating-system processes, allocate PTYs, or
canonicalize host paths. Those effects belong to trusted adapters and the
desktop host.

## Governing decisions

- [ADR 0003 — Capabilities, effects, and policy](adr/0003-capabilities-effects-and-policy.md)
- [ADR 0009 — Desktop packaging and runtime packs](adr/0009-desktop-packaging.md)

The implementation also preserves the boundary in
[ADR 0001 — Layered harness boundaries](adr/0001-layered-harness-boundaries.md):
the host owns process supervision and the filesystem capability owns path
canonicalization. No contract grants ambient filesystem, process, network, or
secret access.

## Contract rules

### Git

`GitCapability` exposes only repository inspection, worktree creation and
inspection, diff evidence, and owned cleanup. A repository identity includes
the workspace reference, provider/id, observed head, dirty-state fingerprint,
changed paths, and task owner. Worktree creation requires a base revision and
`preserveSourceChanges: true`; a dirty primary checkout is therefore an input
fact that an adapter must preserve, never an instruction to reset or clean.

Diff evidence carries repository, worktree, base, head, dirty-state, and a
content hash for every changed file, plus an evidence hash and capture time.
Reset, clean, checkout, rebase, merge, branch deletion, and forced cleanup are
outside the capability and are rejected as destructive Git operations. Any
future opt-in destructive operation needs an explicit policy/approval contract.

### Processes and PTYs

`ExecutableProcessSpec` is the default mode. Its executable and argument list
are separate fields; adapters must use an argv spawn API with shell parsing
disabled. Arguments remain opaque strings, so shell metacharacters in an
argument cannot become a second command. `ShellStringProcessSpec` is a distinct
discriminant and maps to `shell.exec`; it is accepted only after an explicit
policy `allow` decision.

Every spec has an opaque workspace cwd reference, named host/secret
environment references (never values), closed/provided stdin, pipe/PTY mode,
network `none` or an explicit destination allowlist, and finite wall-time,
CPU-time, memory, input, output, and process-count ceilings. Defaults are
bounded and normalized at the contract boundary.

Durable background execution returns an owned handle. Handle inspection,
output streaming, cancellation, and orphan cleanup all carry the owner and
policy request. Providers must compare principal/session/turn/task ownership,
honor cancellation and bounds, cap UTF-8 output bytes, and reap only handles
eligible for the supplied owner and orphan cutoff.

## H3-02 conformance evidence

`core/shared/__tests__/unit/CapabilityContracts.test.ts` proves:

- structured argv arguments, shell-string classification, and explicit shell denial;
- workspace path escape, NUL, duplicate environment, and UTF-8 output bounds;
- durable handle ownership, cancellation, and orphan cutoff validation;
- dirty-state identity and hashed diff evidence;
- destructive Git denial and safe operation scopes.

Provider and desktop integration tests must additionally prove real spawn
without a shell, PTY/process-tree cancellation, orphan reaping after restart,
CPU/time enforcement, and host-specific path/network sandbox behavior. Those
tests are intentionally deferred with the adapters.
