# H1-02 runner enforcement

H1-02 adds runner-owned contracts for agent completion, approval handoff,
assertion gates, and trusted evidence gates. The contracts are metadata on the
existing node/step records; they do not introduce a second execution engine.

## Enforcement boundary

The existing `RunnerSteps` loop remains the execution authority:

1. authorize the step through the existing policy pipeline;
2. execute the existing node or runtime adapter;
3. validate the returned output;
4. publish through the existing persistence helper only after validation;
5. record the existing post-execution audit event.

Built-in `BlokService` and runtime-adapter paths validate immediately before
their persistence call. `RunnerSteps` also validates custom-node results and
cache replays at the common step boundary. Enforcement errors are deterministic
and non-retryable. No arbitrary `ctx.state` or `ctx.vars` rollback is used.

## Contracts

Typed `step()` options and `defineNode()` metadata support:

- `agentStep`: requires an explicit completion value, defaulting to
  `output.completed === true`;
- `approval`: carries a reason/scope into the policy request; policy `ask`
  persists through the H1-01 durable interaction port and resumes the same
  runner cursor;
- `assertionGate`: requires trusted deterministic output and checks a boolean
  or expected value before publication;
- `evidenceGate`: requires trusted evidence records matching every declared
  artifact ID, version, and producer step ID;
- `outputTrust: "trusted"`: is accepted only for a non-agent node with a valid
  deterministic capability manifest.

Returned model JSON cannot establish trust by setting `provenance` fields.
Invalid gates are rejected before the current step's state publication. Normal
workflows without these declarations retain their existing behavior.

## Resume, cache, retry, and nesting

H1-01 suspension signals (`PolicyInteractionRequiredError` and its durable
interaction record) pass through unchanged. A resumed run reuses the existing
cursor and validates the resumed step normally. Cache hits are revalidated
before replay publication; gate failures do not populate or hide state. Retry
configuration is preserved for ordinary failures, while deterministic gate
failures do not retry. Nested runners use the same enforcement helper and
inherit the existing control-flow/persistence semantics.
