# H0-04 secret references and named capability injection

Issue #917 builds on the H0-03 policy boundary. Agent workflows do not read
the ambient process environment: installing agent policy state replaces the
context environment with an immutable empty object, and the gRPC sidecar
envelope sends no environment entries. Ordinary workflows retain the existing
`ctx.env` behavior, including the operator allowlist.

Nodes declare opaque secret reference names in their capability manifest. After
the runner authorizes the node, the private policy state records those names.
Node code can call `resolveSecret(ctx, reference)` only for a declared name and
only when a trusted caller supplied a resolver. The resolver receives principal,
session, turn, workflow, step, policy layers, and cancellation data; it never
receives workflow input as authority. A successful result is a short-lived
lease with a `read()` capability rather than a value placed in state, inputs,
outputs, logs, or the generic sidecar envelope.

Resolution emits a separate redacted `secret.resolve` audit event. The event
contains the opaque reference, lease identifier, attribution, and outcome, but
never secret material. Missing, revoked, malformed, or unavailable resolution
fails closed. The in-memory resolver is a test/reference implementation; host
integrations must provide the actual vault-backed resolver and enforce expiry,
revocation, and maximum lifetime at the provider boundary.

This issue deliberately does not introduce provider-specific vault adapters or
serialize grants through gRPC. Those are follow-up integrations: a sidecar
may receive a value only through an explicit, narrowly scoped grant protocol,
never through ambient environment forwarding.
