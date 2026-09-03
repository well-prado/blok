# @blokjs/agent-kernel

The optional, headless Blok agent kernel owns provider-neutral model turns,
bounded stream assembly, session-derived context, steering, cancellation,
budgets, and restart recovery. It has no provider, Tauri, Studio, or operating
system dependency.

## Boundaries

`AgentKernel` accepts the existing `@blokjs/shared` `SessionStore` contract and
persists observable `model.stream`, `model.completed`, tool-call, message,
budget, and turn events. `AgentDispatcher` is the sole effect seam. Its
implementation must validate tool input and authorize the capability or
workflow through Blok policy before executing it; the kernel cannot bypass that
boundary.

Steering is appended durably and is included at the next model boundary.
Cancellation aborts in-flight provider work and records a cancelled terminal
turn; a boundary that has already accepted a tool call never invokes that call
again during recovery. A stream must have contiguous indexes and a finish
chunk. Usage chunks are deltas, and all persisted stream facts are bounded.

`assembleContext` accepts typed context items for session facts, workflow
instructions, current source, graph results, policy, skills, summaries, and
user input. Items carry source, trust, freshness, truncation, content-hash,
and invalidation provenance. Fixed precedence and logical keys make ordering
and deduplication deterministic; stale/conflicting/missing items are visible
as diagnostics and stale data is excluded by default. Repository content is
labelled as untrusted data before it is sent to a model. Token, byte, item,
and work-time budgets are bounded, with optional provider token estimation.

`assembleContextWithCompaction` uses an injected provider-neutral
`ContextCompactor`. Required policy/workflow items must survive compaction;
the kernel persists the summary and replacement identities as observable
`compaction.started` and `compaction.completed` session events.

The stable error codes include `CONTEXT_OVERFLOW`, `RATE_LIMIT`,
`PROVIDER_DISCONNECT`, `MALFORMED_TOOL_CALL`, `PARTIAL_STREAM`,
`BUDGET_EXCEEDED`, `CANCELLED`, and `TIMEOUT`.

The reusable fake adapter and adapter contract cases are available from
`@blokjs/agent-kernel/testing`.

## Architecture conformance

This package is governed by:

- `docs/architecture/agent-harness/adr/0001-layered-harness-boundaries.md`
- `docs/architecture/agent-harness/adr/0005-event-sourced-agent-sessions.md`

The implementation note is
`docs/architecture/agent-harness/h2-03-agent-kernel.md`.

The context and compaction implementation note is
`docs/architecture/agent-harness/h3-04-context-compaction.md`.

Conformance evidence is in `tests/agent-kernel.test.ts` and
`tests/context.test.ts`: deterministic bounded stream assembly and context
ordering, provenance/freshness/invalidation handling, untrusted-content
boundaries, budgets, observable compaction events, dispatcher routing, stable
partial-stream errors, steering/cancellation-compatible turn boundaries, and
recovery without repeating persisted stream facts or accepted tool calls.
