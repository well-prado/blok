---
"@blokjs/runner": minor
---

The Docker, WASM and Bun-subprocess runtime adapters no longer ship the accumulated workflow state either (#895).

#874/#885 removed the unbounded O(n²) growth term from the gRPC codec, but three sibling
adapters had the identical line — `vars: ctx.vars` (every completed step's output) plus
`response: ctx.response` (the previous step's output) inlined into every call. They are
never wired by `Configuration.initializeRuntimeRegistry`, but they are exported from
`@blokjs/runner` and the docs tell you to `registry.register(new DockerRuntimeAdapter(…))`,
so the bug is reachable by anyone following them.

All four transports now resolve the diet through one helper, `stateForRuntimePayload()` in
`core/runner/src/adapters/transport.ts`, with identical semantics: `vars` becomes `{}` and
the previous step's output becomes `null`, while the envelope, the mapped `inputs`, `env`
and the trigger body ride along untouched.

The flag gets a transport-neutral spelling, **`BLOK_RUNTIME_STATE_DIET`** — gating a Docker
or WASM call on a variable named `..._GRPC_...` was a naming lie. `BLOK_GRPC_STATE_DIET`
keeps working as an alias (`BLOK_RUNTIME_STATE_DIET` wins when both are set), so #885's
behaviour and documentation stay true.
