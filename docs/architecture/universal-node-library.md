# Universal node library architecture

Blok's universal node library is built around two independent contracts:

1. input/output schemas describe the values a node accepts and returns;
2. capability manifests describe the operational effects and authority a node requires.

The normative decision for manifests is
[ADR 0003](./agent-harness/adr/0003-capabilities-effects-and-policy.md). The
canonical v1 TypeScript contract and parser live in
`core/shared/src/CapabilityManifest.ts`; every runtime sends the same JSON
object through `NodeDescriptor.capability_manifest_json`.

## Compatibility boundary

Capability metadata is additive. Existing nodes and workflows without a
manifest continue to execute in ordinary, non-agent workflows. Catalogs mark
them `missing` and agent policy must deny them. Invalid metadata is also denied
to agents and is never silently converted into safe metadata.

This separates migration from authorization:

- `agent-compatible` is an explicit claim that policy may evaluate;
- `trusted-legacy` documents an operator-approved legacy dependency but is not
  agent-eligible;
- `denied-to-agents` makes the restriction explicit;
- no manifest means unclassified, never safe-by-default.

## Runtime invariants

- gRPC carries UTF-8 JSON bytes so the protocol is language-neutral.
- Unknown object fields are ignored by a v1 reader for additive evolution.
- Unknown manifest versions are invalid.
- Secret requirements contain opaque reference names only, never values.
- Arrays are deduplicated and sorted at the runner boundary for deterministic
  comparison and audit output.
- Resource bounds are positive integers and remain advisory metadata until a
  later policy/sandbox issue enforces them.

The conformance fixtures live in `tests/fixtures/capability-manifest/`. The
cross-runtime SPEC-B harness requires every SDK's `typed-greet` descriptor to
produce a manifest semantically equivalent to the canonical fixture.

## Authoring rule

Authors select the narrowest truthful effects and capabilities. A node that
performs an HTTP request declares `network`; it does not declare filesystem or
process authority merely because its runtime could theoretically use them.
`destructive` supplements, rather than replaces, the concrete `write` effect.

See the public [capability manifest guide](../d/fundamentals/capability-manifests.mdx)
for field definitions and examples.
