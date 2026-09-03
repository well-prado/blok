# `@blokjs/capabilities`

Trusted, bounded adapters for effectful operations used by the Blok harness.

`WorkspaceFilesystemCapability` is the H3-01 filesystem boundary. It accepts
only registered, canonical workspace roots and workspace-relative paths. It
does not expose host paths, follows no symlinks, rejects hard-linked regular
files and special files, and returns stable, bounded results. Reads, searches,
writes, patches, and watches carry separate `fs.workspace.*` capabilities and
filesystem/read, filesystem/write, or filesystem/streaming effects in the
shared v1 capability-manifest vocabulary.

Agent-originated callers should provide the H0-03 policy provider and complete
policy context through `WorkspaceFilesystemOptions.policy`. A policy provider
does not grant filesystem authority by itself: the requested operation must
remain in the existing `CapabilityAuthority`, and only an `allow` decision for
the configured policy version proceeds.

Writes require an expected content version when replacing a file. Replacement
is performed with a same-directory temporary file and atomic rename; a changed
version or a target appearing during a create is rejected.

This package deliberately does not implement Git, process execution, shell
commands, graph indexing, or a desktop-specific host protocol.
