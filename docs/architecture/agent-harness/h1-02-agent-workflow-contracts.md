# H1-02 agent workflow contracts

This contract layer adds typed authoring and serializable v2 IR for enforced
agent workflows. It does not implement the model loop or claim that authored
metadata is proof; those runtime concerns consume these records in later
runner work.

## Authoring

The `@blokjs/core` surface exposes five additive primitives:

```ts
const tests = step("tests", runTests, { target: req.body.target });
const report = evidence("test-report", {
  producer: tests,
  artifact: { id: "test-report", version: "run-1" },
  verification: { verifier: "test-runner", status: "pending" },
});
const testsPass = assert("tests-pass", report);

const plan = agentStep("implement", "Implement the requested change.", {
  task: req.body.task,
}, {
  phase: {
    name: "implement",
    capabilities: ["workspace.read", "workspace.write"],
    effects: ["read", "write"],
  },
  budgets: { maxTurns: 12, maxDurationMs: 300_000 },
  outputSchema: z.object({ summary: z.string() }),
  completion: { required: [testsPass] },
});

approval("approve", {
  prompt: "Approve the implementation plan.",
  inputs: { plan },
  outputSchema: z.object({ approved: z.boolean() }),
});
completion("done", { required: [testsPass] });
```

`agentStep` requires a phase envelope and a completion contract. Phase
capabilities are an explicit allow-list; they are not inferred from an
objective or description. `approval` is the workflow declaration for the
durable H1-01 interaction boundary. `evidence` records only a deterministic
step or named capability producer, an artifact/version, and verifier status.
`assert` accepts a boolean handle or evidence reference. `completion` is a
runner-owned terminal gate. `complete` is an alias for `completion`.

Zod schemas are authoring conveniences. They are converted to JSON Schema at
workflow construction time, so `_config.steps` and `toJson()` contain no Zod
instances. Handles in inputs lower to the same structural `{"$ref": ...}` IR
used by ordinary typed steps.

## IR and trust boundary

The helper package is the canonical schema owner. New steps are discriminated
by the presence of `agentStep`, `approval`, `evidence`, `assert`, or
`completion`; existing regular and control-flow steps remain unchanged.

Evidence has no free-form `proof` field. A model message or assertion cannot
become trusted evidence merely by matching a string. The future runner gate
must verify the declared producer, artifact version, and verifier result before
allowing a completion contract to pass. Until that enforcement is wired, these
records are declarations and validation metadata only.

The contracts are intentionally JSON-safe and bounded: identifiers are capped,
object schemas are JSON Schema values, budgets have finite ceilings, and
approval expiry is bounded to 24 hours. Secret entries are opaque reference
names and never secret values.
