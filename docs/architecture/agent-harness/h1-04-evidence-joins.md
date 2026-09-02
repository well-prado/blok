# H1-04 evidence-aware joins and retry/resume contracts

This slice defines the language-neutral contracts used at parallel join and
effect retry/resume boundaries. They are validated with Zod at authoring and
workflow-load boundaries, and can be asserted by conformance harnesses before
publishing state.

## Join API

```ts
interface JoinContract {
  version: "1";
  id: string;
  mode: "all" | "any";
  branches: readonly {
    id: string;
    required: boolean;
    evidence?: readonly EvidenceRequirement[];
  }[];
  outputs: readonly {
    id: string;
    branchId: string;
    path: readonly (string | number)[];
    schema: boolean | Record<string, unknown>;
  }[];
  authority?: CapabilityAuthority;
}

assertJoinSatisfied(contract, {
  branches: [{ id, status, output, evidence }],
});
```

`all` requires every required branch to be completed. `any` requires at least
one declared branch to be completed. An optional branch may be missing or
incomplete, but it cannot contribute a declared output unless it completed.
Every required branch evidence obligation must match a verified
`EvidenceRecord`; malformed or missing evidence fails closed. Outputs are
read only from declared branch paths and are checked against their bounded JSON
schemas. Undeclared branch results are rejected.

Stable join failure reasons include `REQUIRED_BRANCH_MISSING`,
`REQUIRED_BRANCH_INCOMPLETE`, `NO_BRANCH_COMPLETED`, `EVIDENCE_MISSING`,
`OUTPUT_BRANCH_MISSING`, `OUTPUT_MISSING`, `OUTPUT_TYPE_INVALID`, and
`UNKNOWN_BRANCH`.

## Retry/resume API

```ts
interface RetryResumeIdempotencyContract {
  version: "1";
  id: string;
  stepId: string;
  effect: "none" | CapabilityEffect;
  maxAttempts: number; // <= 20
  maxResumes: number; // <= 100
  idempotency: {
    mode: "not-required" | "keyed" | "evidence-required";
    keyDeclared?: boolean;
  };
  evidence?: readonly EvidenceRequirement[];
  authority?: CapabilityAuthority;
}

interface EffectRetryEvidence {
  version: "1";
  id: string;
  stepId: string;
  runId: string;
  attempt: number; // <= maxAttempts
  effect: CapabilityEffect;
  idempotencyKeyDigest: string; // sha256 or sha512; never the raw key
  outcome: "committed" | "deduplicated" | "not-committed";
  producer: { kind: "capability" | "deterministic-step" | "runner"; id: string };
  observedAt: string;
}

assertEffectRetryEvidence(contract, evidence);
```

An effectful step that can retry or resume must declare keyed idempotency or
evidence-required idempotency. Evidence-required replay accepts only bounded,
validated runner evidence for each declared requirement; no raw idempotency key
is persisted. `CapabilityEffect` and the optional `authority` field are the
canonical exports from the permission algebra. This package does not define a
second authority type or perform authority intersection; permission monotonicity
remains owned by `CapabilityAuthority` and its algebra.

## Conformance hooks

Shared unit tests exercise the pure assertions. Workflow authors can attach
`join` to callback `branch`/`forEach` options and `retryResume` to steps and
subworkflows. The helper schemas and normalizer preserve and validate these
fields, so H1-04 harness tests can inspect normalized step metadata before
execution and call the assertion functions with branch/evidence envelopes.
