# H1-02 shared evidence and provenance contracts

The shared `@blokjs/shared` evidence contract is the language-neutral seam for
assertions, evidence gates, and completion criteria. This stream defines data
and validation only. Runner transitions, agent-step execution, and Studio
rendering remain owned by their respective follow-up work.

## Trust boundary

An `EvidenceRecord` is trusted only when it contains all of the following:

- a stable artifact identity, immutable version label, and content digest;
- a producer identity limited to a capability, deterministic step, or runner;
- workflow-step and trace provenance, with an optional H1-01 interaction ID;
- a verification result with a trusted verifier, method, timestamp, and
  machine-readable checks.

There is intentionally no model producer or model-report verification method.
Model messages may describe work for context, but cannot be parsed as an
evidence record. Claim, check, and reason fields are bounded machine-readable
codes; narrative fields are not part of the trusted record. Unknown object
fields are stripped by the Zod schemas, so a future descriptive field cannot
silently become a gate input.

## Bounds and serialization

Evidence records and payloads use the H1-01 JSON envelope: 64 KiB per record,
eight nested payload levels, 256 fields/items per container, and 8 KiB per
string. Circular values, non-finite numbers, class instances, and other
non-JSON values are rejected. Artifact locators are deliberately absent from
the identity: a URL or filesystem path is not proof of content.

`parseEvidenceRecord` and `parseCompletionContract` are the boundary helpers.
They return normalized, serializable values or throw `EvidenceContractError`
with actionable issue paths. The exported Zod schemas are useful to adapters
that need to compose the contract into a larger schema.

## Completion

`CompletionContract` is a declarative list of `evidence` and `approval`
requirements. Evidence requirements always require `verification: "verified"`
and explicitly enumerate accepted producer kinds. Approval requirements refer
to an H1-01 durable interaction ID and the accepted `answered` status. The
runner will later decide whether all or any requirements are satisfied; this
shared stream does not execute or resume a workflow.

The contract is additive to existing trace concepts. `provenance.trace.runId`
and `nodeRunId` map to the existing workflow and node trace identities, while
`provenance.interactionId` points at the durable interaction record rather than
copying its answer or suspension state.

## Conformance coverage

Focused shared tests cover valid records and completion contracts, digest and
claim-code validation, verification invariants, payload bounds, deterministic
serialization, interaction/trace linkage, duplicate requirement IDs, and
rejection of model-authored evidence.
