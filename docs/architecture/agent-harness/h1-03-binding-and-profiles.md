# H1-03 workflow binding and enforcement profiles

H1-03 adds a runner-local binding resolver. It is intentionally additive to
the shared H0/H1-02 policy contracts: the resolver chooses the workflow and
profile before an agent run, while the existing `PolicyProvider` continues to
authorize each effectful step.

## Resolution contract

`resolveWorkflowBinding({ inputs, catalog })` is pure. It reads only the
canonical `WorkflowBindingInputs` and a catalog of shared
`WorkflowBindingRule`/`WorkflowReference` values, and returns either an
advisory `unbound` result or a resolved/denied result. Repository provider and
ID are exact (and a selector revision is exact when present); task types,
tenant, actors, and environments are allow-lists; all declared labels and
attributes must match; and at least one input path must be under a declared
selector path.

Matching rules are ordered by descending explicit priority, descending match
specificity, then ascending rule ID. Equal-precedence rules that disagree and
include a `strict` profile are denied with every winning rule ID in the
explanation. This makes rule order in a file irrelevant and makes ambiguity
fail closed.

The selected source must be explicitly trusted and match the rule's exact
`WorkflowReference` (name, version, source, and IR digest). The resulting
shared `PinnedWorkflowRunContract` pins the workflow reference, node/runtime
identities, capability-manifest identity, policy identity, and model
configuration identity. Persist that contract with the run;
`compareWorkflowContract` detects deletion, version changes, source/IR changes,
and other pin changes without re-resolving the active run.

## Profile semantics

- `advisory`: deviations are allowed and marked for recording.
- `guided`: deviations require an authorized override with a non-empty reason
  and scope; the caller persists the resulting audit/session event.
- `strict`: deviations and in-run bypasses are denied, including when an
  override flag is supplied.

`evaluateEnforcementProfile` is a side-effect-free boundary helper. It does
not manufacture audit events or authorize actors; those remain owned by the
caller and the existing durable interaction/policy layers.

## Configuration and testing seam

The resolver accepts a snapshot catalog, so `Configuration`, a future control
plane, or a trusted registry can construct workflow references without
changing the `PolicyRequest` shared contract. `InMemoryWorkflowBindingProvider`
is supplied for deterministic tests and configuration adapters. The resolver,
explanation, fingerprint, profile evaluation, pinning, and contract comparison
helpers are exported from `@blokjs/runner` and `@blokjs/runner/testing` (and
therefore the existing `@blokjs/core/runtime` and `@blokjs/core/testing`
re-exports).

For file-backed inspection, `blokctl binding explain --catalog catalog.json
--task task.json` (canonical workflow binding inputs) prints the same
deterministic explanation; `--json` emits the complete resolution for CI or a
control-plane adapter.

No source bytes, credentials, or model output are accepted as trust evidence;
the source catalog must be populated by a trusted loader or operator.
