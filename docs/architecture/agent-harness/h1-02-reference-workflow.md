# H1-02 reference strict coding workflow

The repository's H1-02 reference fixture is
[`strict-coding-workflow.ts`](../../../core/core/examples/strict-coding-workflow.ts).
It demonstrates the enforceable shape of a coding procedure while the
provider-neutral model loop and the first-class `agentStep`/assertion/evidence
authoring primitives remain separate roadmap work.

```text
understand → plan → approve → implement → test → assert → evidence → review → complete
```

The workflow is authored with the typed-handle DSL. Model-facing phases are
`defineNode()` nodes so the test harness can replace their output by node key.
The test, assertion, evidence, and completion nodes remain real deterministic
nodes. Their Zod schemas are part of the trust boundary, and the evidence gate
only consumes the output of the trusted test capability; a model field such as
`modelClaimedEvidence` cannot satisfy it.

## Policy and approval

`runWorkflow()` accepts an optional `policy` execution option. It installs the
same policy boundary used by `RunnerSteps` before the v2 runner starts, so
mocking a model does not bypass capability-manifest checks or audit events.
Mocks preserve the source node's declared capability manifest. A mock for an
unresolved node therefore remains fail-closed under agent policy.

The `approve` step has the `workflow.approval` capability. In the integration
scenario, the policy provider returns `ask`; H1-01's `DurableInteractionPort`
persists the interaction before the control signal escapes. The test answers
the record and calls `TriggerBase.resumeInteraction()`. The trace cursor skips
the completed `understand` and `plan` steps, and the original run completes
through `implement` and the remaining gates.

## Conformance evidence

`core/core/src/strict-coding-workflow.e2e.test.ts` proves:

- all model phases can be mocked while the real runner executes every gate;
- the policy provider sees the declared `workspace.write` envelope for
  `implement` and audit receives one pre-execution event per step;
- a bad artifact produces trusted failed test evidence and prevents
  `assert`, `evidence`, `review`, and `complete` from executing;
- an asserted model claim is not accepted as evidence;
- approval is durable, the run is `suspended`, and resume executes only the
  post-approval continuation.

This slice intentionally does not add model-loop, desktop, control-plane, or
provider-specific behavior. Nested/parallel workflow semantics continue to be
owned by the existing runner primitives and their conformance suites.
