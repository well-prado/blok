# H2-03 — Provider-neutral agent kernel

`@blokjs/agent-kernel` is the optional, headless model-loop layer. It consumes
the canonical `@blokjs/shared` `SessionStore` and event contracts and never
imports a model provider, Tauri, Studio, or an operating-system capability.

## Boundaries and ordering

The kernel builds a provider-neutral `ModelRequest` from model-visible session
messages and durable steering facts. Before each adapter call it appends
`model.call.started`; each validated bounded stream chunk is appended as one
observable `model.stream` fact, followed by `model.completed` and an assistant
message. A finish chunk is mandatory and chunk indexes are contiguous. Usage
chunks are deltas. Tool requests are appended as `tool.call.started` before the
kernel calls the injected `AgentDispatcher`, then completed/failed and
model-visible tool messages are persisted.

`AgentDispatcher` is the policy/workflow seam. Its implementation validates the
declared tool input and re-enters Blok authorization before executing any
capability or workflow. The kernel does not provide an effect bypass.

Steering is durable immediately and is included at the next model boundary; it
does not mutate an in-flight request. Cancellation aborts the active signal and
persists a cancelled terminal turn. A boundary that has appended
`tool.call.started` never dispatches that same idempotency key again. During
recovery, a complete persisted stream is assembled without another adapter
call; a partial stream or accepted call with no terminal fact fails with a
stable recovery error.

## Contracts and limits

`contracts.ts` defines request, content block, stream chunk, usage, finish,
tool, dispatcher, budget, and stable error contracts. The kernel enforces token,
cost, duration, step, tool-call, and output-byte limits and records budget
updates/exhaustion as operational session events. Provider failures map to
stable context-overflow, rate-limit, disconnect, malformed-tool, partial-stream,
budget, cancellation, timeout, and recovery codes.

`testing/FakeModelAdapter.ts` and `testing/contract-suite.ts` are provider-
independent test assets. Production adapters can run the same contract cases
without adding provider dependencies to this package or to `core/runner`.
