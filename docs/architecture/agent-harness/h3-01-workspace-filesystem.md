# H3-01 workspace filesystem capability

The trusted workspace filesystem capability is implemented by
`@blokjs/capabilities` in `packages/capabilities`. It is an effect adapter, not
a workflow policy layer and not a replacement for the H0-03 runner boundary.

## Boundary contract

`WorkspaceFilesystemCapability` is constructed with one or more registered
workspace roots. Roots are canonicalized with `realpath`; operation results
contain only the root identifier and a normalized workspace-relative path.
Requested paths reject absolute POSIX, drive, UNC, device, NUL, and traversal
forms. Every component is checked with `lstat`, symlinks are rejected, regular
files with more than one link are rejected, and directories, regular files,
and special files are distinguished at the final open boundary. Linux uses
`O_NOFOLLOW` when available in addition to the pre-open and post-open identity
checks.

The operation surface is deliberately split:

| Operation | Shared effects | Capability |
| --- | --- | --- |
| metadata, list, read | `filesystem`, `read` | `fs.workspace.metadata`, `fs.workspace.list`, `fs.workspace.read` |
| search | `filesystem`, `read` | `fs.workspace.search` |
| write, patch | `filesystem`, `write` | `fs.workspace.write` |
| watch | `filesystem`, `read`, `streaming` | `fs.workspace.watch` |

Each operation produces a separate policy request. The request reuses the
shared `PolicyRequest` identity, `CapabilityAuthority`, `PolicyDecision`, and
v1 `CapabilityManifestV1`; the filesystem-specific operation and relative path
are additive request metadata. A caller-provided authority is intersected
before policy evaluation, so a policy provider cannot widen the parent scope.

## Bounds and consistency

Hard package ceilings cover path/query length, read/write/search/list/watch
bytes and counts, lines, watch events, debounce, and operation duration.
Callers can lower a ceiling but cannot raise it. Search and list return an
explicit `truncated` result when count/byte/line traversal reaches a bound.
Reads use fatal UTF-8 decoding by default and expose explicit `bytes` and
`base64` modes for binary content. Metadata, read, write, search, and watch
results include a workspace artifact identity and a content SHA-256 version for
bounded files; oversized files use a bounded stat version token.

Replacing an existing file requires its expected version. Content is written
to an exclusive same-directory temporary file, synced, checked again against
the expected version, and atomically renamed. A target appearing during a
create is a conflict, not an overwrite. Cancellation is checked before and
during bounded work; watches close their OS handles on cancellation, overflow,
or deadline.

Watch events are debounced and carry `requiresRescan: true` on overflow. Paths
are relative and event metadata is best effort; a consumer must re-read the
authoritative source before applying a derived index update.

## Governing architecture and out of scope

This implementation conforms to:

- `docs/architecture/agent-harness/adr/0003-capabilities-effects-and-policy.md`
- `docs/architecture/agent-harness/adr/0009-desktop-packaging.md`
- `docs/architecture/agent-harness/h0-03-policy-pipeline.md`

Git/worktree semantics, shell/process execution, graph indexing, and desktop
IPC remain separate capabilities. Platform path cases are maintained in
`packages/capabilities/tests/fixtures/platform-paths.v1.json`; POSIX security
fixtures run on Linux/macOS and Windows path-form cases run on every host.
