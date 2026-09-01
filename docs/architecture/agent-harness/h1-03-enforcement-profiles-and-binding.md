# H1-03 enforcement profiles and workflow binding

This document defines the shared, language-neutral contract for selecting an
enforced workflow. It does not resolve a rule or execute a workflow; those are
runner responsibilities. The wire contracts and parsers live in
`@blokjs/shared` (`EnforcementProfileContracts` and
`WorkflowBindingContracts`).

## Profiles

The profile is part of the selected binding and is captured in the run
contract before execution starts.

| Profile | Transitions | Deviations | In-run bypass |
| --- | --- | --- | --- |
| `advisory` | Advisory; the runner may continue | Permitted, but recorded in trace/session results | Not needed; deviations are visible |
| `guided` | Enforced | Only a bounded, authorized override may permit a deviation | No unrecorded bypass |
| `strict` | Enforced | Rejected | Forbidden |

An override is not a boolean flag or a prompt instruction. The shared event
must identify the run and binding rule, an answered durable H1-01 interaction,
the authorizing principal, a machine-readable reason code, and at least one
specific step, transition, or capability scope. Strict and advisory runs
cannot carry a guided override event. Scope cannot mean “everything”; an
escape from strict mode requires a new authorized run with a different
binding.

## Binding inputs and rules

`WorkflowBindingInputs` contains metadata only:

- repository provider, stable repository ID, and optional revision;
- task type;
- normalized labels and paths;
- tenant, actor identity, and environment;
- bounded scalar attributes for deployment-specific selectors.

No request payload, workflow output, credential, or secret value belongs in
these inputs. Arrays are treated as sets by the shared parser: duplicates are
removed and values are sorted with a bytewise comparator. This makes the
serialized representation identical for identical facts supplied in a
different order.

A `WorkflowBindingRule` (or bounded list of rules) has a stable ID,
non-negative priority, a selector, the selected profile, and a
`WorkflowReference`. Parsed rule lists are ordered by priority descending and
then rule ID so precedence input is stable. A reference contains a
version-pinned workflow name, trusted source identity, source digest, and IR
digest. Source trust is explicit (`trusted: true`) and both content identities
must be SHA-256 or SHA-512 digests. A runner may reject conflicting strict
rules; the shared contract deliberately leaves precedence and ambiguity
resolution to that layer.

Selectors are conjunctive across fields. A selector's labels are required
labels; path matching is the resolver's declared path policy and must be
deterministic. The contract does not allow executable expressions or arbitrary
JavaScript in a binding selector.

## Pinned run contract

`PinnedWorkflowRunContract` is the immutable snapshot associated with one run.
It records:

- the run ID, selected profile, binding rule ID, and binding timestamp;
- workflow name/version, trusted source digest, and IR digest;
- every node identity and version used by the workflow;
- every runtime kind and version used by the run;
- capability-manifest version/digest;
- policy ID/version (and optional digest);
- model provider/ID/version and model-configuration digest.

The active run reads this snapshot rather than a live workflow registry. A
later workflow edit, policy publication, node upgrade, runtime upgrade, or
model configuration change therefore cannot mutate the active run's
contract. A new run must bind again and receive a new snapshot.

## Bounds and trust

All identifiers, versions, labels, paths, attributes, scope entries, node
entries, and runtime entries have finite limits, and each parsed contract is
capped at 512 KiB. Binding attributes accept only
strings, finite numbers, and booleans; nested objects, arrays, functions,
cyclic values, and expressions are rejected. Digests are normalized to
lowercase. Parsers strip additive unknown fields and return normalized values
that can be serialized directly; adapters should persist the serialized
contract or an immutable copy.

The shared package performs shape, bounds, trust-marker, and digest checks. It
does not claim that a digest was obtained from a trusted registry, that an
actor is authorized, or that a rule is unambiguous. Those facts are established
by the runner/control-plane boundary and must be included in the surrounding
immutable audit/session record.

## Conformance coverage

Focused shared tests cover profile semantics, invalid profile versions,
canonical binding inputs, trusted source and digest requirements, complete
run pins, guided-only authorization, non-empty bounded override scope, and
rejection of nested/unbounded selector data.
