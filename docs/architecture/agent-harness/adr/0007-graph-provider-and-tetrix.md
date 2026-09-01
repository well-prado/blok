# ADR 0007 — Graph provider and Tetrix

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

Code graphs improve symbol discovery, relationships, impact analysis, and
long-term task memory. Indexes can be stale, incomplete, truncated, or scoped to
a different commit/worktree. They cannot safely replace authoritative source
reads or transactional session state.

## Decision

Define a provider-neutral graph contract. Tetrix is the first adapter. Results
carry repository, branch/worktree, commit, content hash, path, range,
provenance, index version, and freshness metadata whenever available.

The graph is a derived index. Before a write, the harness re-reads the current
source from the workspace capability and verifies the expected content/version.
Sessions, approvals, policy, and workflow truth remain in transactional stores.
File watching and committed patches schedule incremental reindexing.

## Consequences

- Graph queries can locate candidates but cannot authorize or directly mutate
  source.
- Retrieval needs explicit stale/missing/truncated states and source fallback.
- Multiple graph providers can coexist without changing workflows.
- Evaluation includes stale-index, branch-switch, uncommitted-overlay, missing
  symbol, and truncated-result cases.
