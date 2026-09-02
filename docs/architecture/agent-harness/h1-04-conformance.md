# H1-04 permission inheritance conformance

This campaign verifies that parallel branches and child workflows can only
narrow the authority they inherit. It consumes the canonical
`CapabilityAuthority` contract from H1-04; it does not introduce a second
permission or envelope type.

## Coverage map

| Requirement | Conformance evidence | Invariant |
| --- | --- | --- |
| Monotonic authority | `core/shared/__tests__/unit/H1-04Conformance.test.ts` | Parsing is strict and deterministic; intersection is stable, commutative, and associative; a child request outside its parent is rejected. |
| Policy narrowing | `core/runner/__tests__/integration/h1-04-conformance.e2e.test.ts` | A policy result may narrow a request, but a malformed or widened policy scope cannot authorize execution. |
| Nested and parallel isolation | `core/runner/__tests__/integration/h1-04-conformance.e2e.test.ts` plus the existing `wait-inside-foreach-parallel.test.ts` | Branches and children use separate transient state and cancellation scopes; lineage identifies the root, parent, branch, and depth. |
| Required/optional joins | `core/shared/__tests__/unit/H1-04Conformance.test.ts` | Required branches and verified evidence are mandatory; optional branches may be absent; declared outputs are checked against their JSON Schema. |
| Cancellation | `core/runner/__tests__/integration/h1-04-conformance.e2e.test.ts` plus `unit/tracing/RunTracker.cancelled.test.ts` | Cancellation is terminal and never becomes successful completion or successful join evidence. |
| Wait/resume | `unit/wait-state-snapshot.test.ts`, `unit/wait-inside-foreach-parallel.test.ts`, and the H1-01 interaction lifecycle suite | Resume uses the saved state/cursor and preserves completed branch evidence without rerunning committed work. |
| Failure injection and duplicate effects | `core/shared/__tests__/unit/H1-04Conformance.test.ts` plus `unit/RunnerSteps.idempotency.test.ts` | Effectful retry/resume requires a declared keyed idempotency mode or verified retry evidence; committed effects are not silently replayed. |
| Bounded work | `core/shared/__tests__/unit/H1-04Conformance.test.ts` and existing `unit/RunnerSteps.maxDuration.test.ts` | Recursion, fan-out, attempts, resumes, payloads, schemas, and duration remain bounded by the canonical limits. |
| Cross-runtime children | `core/runner/__tests__/integration/h1-04-conformance.e2e.test.ts` plus `tests/e2e/cross-runtime` | A child reached through a runtime adapter receives the same narrowed authority and lineage rules as an in-process child. |

## Test design

The shared suite exercises pure contracts directly. The runner suite uses
public policy/runner exports and the existing real-engine test harness; it
does not duplicate `RunnerSteps`, `SubworkflowNode`, or scheduler logic.
Existing wait, cancellation, idempotency, runtime-adapter, and H1-01 resume
suites remain part of the campaign because those paths already own the
durability behavior.

The failure cases are intentional: a cancelled branch is not a completed
branch, a model-shaped or unverified record is not evidence, and a child
authority that contains an entry absent from its parent fails before dispatch.
The tests never assert raw secrets or raw idempotency keys; only bounded names,
digests, and public reason codes are allowed in evidence.

Run the focused campaign with:

```sh
bun run --filter @blokjs/shared test -- __tests__/unit/H1-04Conformance.test.ts
bun run --filter @blokjs/runner test -- __tests__/integration/h1-04-conformance.e2e.test.ts
```

The full H1-04 campaign also includes the existing suites named in the
coverage map. This keeps the campaign aligned with the shipped wait/resume,
retry, tracing, and cross-runtime implementations instead of creating
parallel test-only behavior.
