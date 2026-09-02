# H3-03 graph provider contract and Tetrix adapter

Status: accepted implementation contract

## Governing decisions

- [ADR 0001 — Layered harness boundaries](adr/0001-layered-harness-boundaries.md)
- [ADR 0003 — Capabilities, effects, and policy](adr/0003-capabilities-effects-and-policy.md)
- [ADR 0007 — Graph provider and Tetrix](adr/0007-graph-provider-and-tetrix.md)
- [ADR 0010 — Security and behavioral conformance](adr/0010-security-and-behavioral-conformance.md)

## Contract

`@blokjs/shared` owns the versioned, provider-neutral `GraphProvider` surface.
It defines repository and worktree identity, locations and ranges, symbols,
relations, search, impact, indexing, freshness, provenance, content hashes,
bounded errors, and explicit `fresh`, `stale`, `missing`, `truncated`,
`partial`, `unsupported`, and `conflict` result states.

Every query/index response is stamped `authority: "navigation-only"`. The
graph is a derived index and never exposes a source write or mutation
authorization operation. `AuthoritativeSourceReader` is intentionally a
read-only interface for #927's workspace capability to implement later:
graph-informed mutation code must reread the current source and compare its
expected commit/content hash before it can proceed through the existing policy
pipeline.

`@blokjs/capabilities` provides:

- `FakeGraphProvider`, a deterministic contract-test provider that models
  branch/worktree changes, uncommitted overlays, stale commits, missing paths,
  content conflicts, truncation, and unsupported operations;
- `BoundedGraphIndexer`, which bounds queue size, files, and bytes, deduplicates
  identical repository/worktree/content jobs, propagates cancellation, limits
  concurrency, and emits lifecycle events;
- `TetrixGraphProvider`, a transport-only seam. Tetrix-specific client code is
  supplied by an integration and must return the normalized contract; no native
  Tetrix response shape or filesystem implementation is bundled here.

Graph query and derived-index persistence use the existing capability/effect
vocabulary (`graph.query` with `read`, `graph.index` with `read` + `write`).
The package exports manifests for callers to submit to the existing
`PolicyProvider`; it does not introduce a competing policy or authority
contract.

## Conformance evidence

`packages/capabilities/tests/graph-provider-contract.test.ts` proves:

- deterministic symbol, relation, impact, and provenance/hash behavior;
- clean results versus branch switch and uncommitted-overlay stale results;
- content-hash conflict, missing symbol/path, truncated result, and unsupported
  operation states;
- bounded indexing deduplication, queue overflow, cancellation, lifecycle
  behavior, and `maxConcurrent` enforcement;
- Tetrix provenance stamping and fail-closed invalid transport responses.

The focused validation for this change is:

```text
bun run --filter @blokjs/shared build
bun run --filter @blokjs/capabilities typecheck
bun run --filter @blokjs/capabilities test
bunx biome check core/shared/src/GraphContracts.ts core/shared/src/index.ts packages/capabilities/src packages/capabilities/tests
git diff --check
```
