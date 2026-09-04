# `@blokjs/code-mode`

`@blokjs/code-mode` executes one ephemeral model-authored TypeScript function
body in a fresh worker and VM context. The body receives only `input`, the
phase-scoped `bindings` object, and the bounded `log`/`emit` functions. It does
not receive a Node global, module loader, filesystem, process, network,
environment, secret, or Blok mapper context.

Every binding has a Zod input/output schema, an agent-compatible capability
manifest, and a shared `CapabilityAuthority`. Before a handler runs, the
runtime checks the parent authority, invokes the existing
`CapabilityAuthorizationPort`, validates the returned decision/scope, and only
then invokes the trusted host adapter. Nested host calls use that same path.

The worker is terminated on cancellation, timeout, output/call/parallelism
failure, host shutdown, or a memory-limit exit. Worker resource limits are a
containment aid; the AST validator is mandatory and rejects imports, module
loading, process/filesystem/network/environment access, dynamic code loading,
constructors, regular expressions, timers, nondeterministic globals, and Blok
expression escape hatches. This is a constrained runtime, not a general
JavaScript shell.

```ts
const result = await executeCodeMode({
	 source: `
		const answer = await bindings.lookup({ key: input.key });
		log({ lookedUp: input.key });
		return answer;
	`,
	 input: { key: "alpha" },
	 bindings: [lookupBinding],
	 policy: { authorization, policyVersion: "policy-v1", context: agentPolicyContext },
	 budgets: { maxCalls: 4, maxParallelism: 2 },
});
```


## Typed binding surface

The package also exposes the H2-05 typed binding boundary. Workflow and
capability definitions use Zod input/output schemas and explicit output kinds.
The registry generates bounded, deterministic TypeScript declarations after
phase, principal, runtime, maturity, manifest, authority, and policy filters.
Generated names are namespaced and collision-safe; secret reference names remain
only in trusted policy requests and never appear in model-facing declarations
or provenance.

Each generated handle revalidates input, asks the policy provider for a fresh
decision, propagates only the intersection of active and binding authority,
validates output, and returns canonical JSON. H2-04 owns sandbox execution,
cancellation, and budgets; the registry is the typed binding/control-plane
layer consumed by that runtime. See
`docs/architecture/agent-harness/h2-05-code-mode-bindings.md`.


## Architecture conformance

This package is governed by:

- `docs/architecture/agent-harness/adr/0001-layered-harness-boundaries.md`
- `docs/architecture/agent-harness/adr/0003-capabilities-effects-and-policy.md`
- `docs/architecture/agent-harness/adr/0004-constrained-code-mode.md`
- `docs/architecture/agent-harness/adr/0005-event-sourced-agent-sessions.md`
- `docs/architecture/agent-harness/adr/0007-graph-provider-and-tetrix.md`
- `docs/architecture/agent-harness/adr/0008-parallel-and-child-permissions.md`
- `docs/architecture/agent-harness/adr/0010-security-and-behavioral-conformance.md`
- `docs/architecture/agent-harness/adr/0009-desktop-packaging-and-runtime-packs.md`

The implementation notes are
`docs/architecture/agent-harness/h2-04-code-mode-runtime.md` and
`docs/architecture/agent-harness/h2-05-code-mode-bindings.md`.

Conformance evidence is in `tests/code-mode.test.ts`: accepted typed bodies,
forbidden construct rejection, absent ambient APIs, policy-before-handler
ordering, schema normalization, independent call/parallel/output/time/memory
bounds, cancellation cleanup, and nested authority non-escalation.
