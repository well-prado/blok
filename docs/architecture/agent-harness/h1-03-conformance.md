# H1-03 conformance campaign

This document maps the H1-03 acceptance criteria to executable conformance
coverage. The shared contract definitions are the source of truth for names,
versions, identity fields, digest validation, and canonical ordering:
`EnforcementProfile`, `WorkflowBindingRule`, `WorkflowBindingInputs`,
`PinnedWorkflowRunContract`, and `EnforcementOverrideEvent`.

## Coverage map

| Requirement | Coverage | Expected invariant |
| --- | --- | --- |
| Precedence | `unit/policy/WorkflowBinding.conformance.test.ts` | Priority, selector specificity, and stable rule ID produce one winner and stable explanation/fingerprint. |
| Ambiguity | same unit suite | Equal-precedence strict rules targeting different workflows fail closed and identify every winner. |
| Overrides | same unit suite and `integration/h1-03-enforcement-lifecycle.e2e.test.ts` | Advisory records; guided requires an authorized durable interaction; strict never accepts an in-run bypass. |
| Advisory deviations | unit suite and lifecycle suite | A permitted deviation is visible in run state and trace events without changing the pinned contract. |
| Pinned identities | fixture `h1-03-binding.ts` and unit suite | Workflow, node, runtime, capability, policy, and model identities are present in the canonical run contract. |
| Workflow deletion/version changes | unit suite | A missing workflow, changed version/source, or changed execution identity is stale relative to the original pin. |
| Explainability | unit suite | Input/catalog ordering does not change matched rules, winning rule, explanation, or fingerprint. |
| Run immutability | lifecycle suite | The contract is created with the run ID and later store updates cannot replace it. |

## Reference fixtures

`core/runner/__tests__/fixtures/h1-03-binding.ts` contains type-checked,
non-secret reference values. Digests use complete SHA-256 forms because the
shared parser intentionally rejects abbreviated or human-readable digests.
The fixture includes a broad advisory fallback, a strict repository rule, an
equal-precedence ambiguity pair, a complete pinned contract, and a guided
override event scoped to one step.

The resolver tests call the pure binding API directly. The lifecycle test uses
the real in-memory run store and tracker, so persistence and append-only trace
behavior are exercised without a server or external services.

## Mutation model

Binding and identity data is evaluated before execution. Once a
`PinnedWorkflowRunContract` is persisted, changing or deleting the currently
available workflow does not rewrite the active run. The conformance comparison
reports the appropriate stale category; a later run must bind and pin again.
Guided override events are append-only, bounded by their canonical scope, and
must contain a durable answered interaction. Advisory deviations are recorded
as run evidence; neither path edits the pinned identities.

Run the focused campaign with:

```sh
bun run --filter @blokjs/runner test -- __tests__/unit/policy/WorkflowBinding.conformance.test.ts __tests__/integration/h1-03-enforcement-lifecycle.e2e.test.ts
```
