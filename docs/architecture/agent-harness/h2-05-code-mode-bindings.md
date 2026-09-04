# H2-05 — Typed Code Mode bindings

packages/code-mode is the generated binding boundary between the constrained
Code Mode runtime and trusted Blok workflows/capabilities. It is deliberately
not a TypeScript evaluator or a capability adapter.

Definitions use Zod input/output schemas and an explicit output kind. The same
schemas are converted into bounded JSON Schema declarations and parsed again
before and after every call. The output kind records whether a result is a
scalar, object, array, null, streaming handle, background handle, or artifact
reference; no human rendering is used as a result protocol.

Generation is phase-scoped and deterministic. It excludes implementation-only
bindings and filters principal, runtime, maturity, eligible manifest, active
authority, and a preflight policy decision. Binding names are namespaced and
collision-safe. Secret reference names are retained only in the trusted policy
request and are absent from generated declarations and provenance.

Invocation rechecks all static restrictions and asks the policy provider for a
fresh decision. A binding can only narrow the active authority. allow is the
only result that crosses to the handler in this contract package; deny, ask,
require-sandbox, stale, malformed, and widened decisions have stable error
codes. H2-04 owns sandbox execution, cancellation, and budgets; its handler
receives the validated PolicyRequest, effective authority, and explicit
provenance.

The graph provider is not an authority source. Graph data may help a caller
choose a binding input, but authoritative workflow/capability handlers must
re-read current state and re-enter policy before effects.
