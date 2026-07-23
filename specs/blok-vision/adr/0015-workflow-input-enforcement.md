# ADR 0015 — Enforce `workflow.input` at the trigger boundary (one gate in TriggerBase)

- **Status:** Accepted — implemented (unit + MCP end-to-end tests green)
- **Date:** 2026-07-21
- **Resolves:** [#678](https://github.com/well-prado/blok/issues/678)
- **Origin:** tetrix-blok ADR-003 — MCP tool calls with malformed/missing args executed anyway and failed deep in nodes (or silently ran with `undefined` fields) instead of returning a validation error.

## Context

A workflow's `input` Zod schema is declaration-only. The type doc says so
explicitly (`core/workflow-helper/src/components/workflowV2.ts:78-83`): used by
the `mcp` trigger to *generate* the advertised `inputSchema` and for TS
inference, "carried verbatim on `_config.input`; **not validated or serialized
by the runner**."

The result is a systemic gap, worst on MCP because MCP *advertises* the schema:

- **MCP** (`triggers/mcp/src/McpTrigger.ts`): `tools/list` advertises
  `inputSchema` via `zodToJsonSchema` (`:331`, `:155-173`), but `tools/call`
  extracts `req.params.arguments ?? {}` (`:341`) and passes it straight through
  `dispatchTool` (`:372-388`) into `ctx.request.body` (`:421-426`). No
  `safeParse` ever runs. The MCP SDK validates only the JSON-RPC envelope, not
  the per-tool schema. Advertise-but-don't-enforce is a correctness bug: a
  machine caller that honored the schema contract gets no protection from one
  that didn't.
- **HTTP** (`triggers/http/src/runner/HttpTrigger.ts`): body parsed and set as
  `ctx.request.body` with no schema check; the only entry validation is
  required *headers* (`:1317-1343`). Same gap for the `/__blok/rpc/:name`
  mount (`:1013-1030`).
- **gRPC** (`triggers/grpc/src/GRpcTrigger.ts:157-167`): decoded message
  assigned to `ctx.request`, no schema check.
- **Consequences of the miss:** Zod `.default()` values promised by the
  advertised JSON Schema — and by the compile-time entry-handle type
  (`EntryBodyOf` at `core/runner/src/stepBuilder.ts:1204` infers
  `z.infer<S>`) — are **never applied**, so the static types lie at runtime.
  Malformed calls either run to completion with `undefined` fields or die
  deep in a node with an opaque error (under `BLOK_MAPPER_MODE=strict`, a
  `MapperResolutionError` naming a mapper path, not the caller's mistake).

Everything needed to close the gap already exists:

- The enforcement pattern: the **output** gate in `McpTrigger.runWorkflow`
  (`:437-460`, `BLOK_VALIDATE_WORKFLOW_OUTPUT`). There is no input analogue
  anywhere in the codebase.
- The error shape: `zodErrorToGlobalError`
  (`core/runner/src/defineNode.ts:238-257`) → `GlobalError` with code 400 and
  structured `validation_errors: [{path, message, code}]`.
- The transport translation: HTTP renders `GlobalError` as a 400 JSON body;
  MCP's `dispatchTool` catch renders any throw as `{isError: true}`
  (`McpTrigger.ts:382-387`, already exercised by
  `McpTrigger.output-validation.test.ts`); gRPC maps to an error status.
- The hook point: every trigger funnels through `TriggerBase.run()`
  (`core/runner/src/TriggerBase.ts:917`) *after* its middleware chain — but
  `Configuration` currently drops `_config.input` on the floor, which is why
  no shared gate exists.

## Options

**A — Patch MCP only (`safeParse` in `dispatchTool`).** Fixes the reported
symptom, leaves HTTP/gRPC/rpc and every future trigger with the identical gap,
and duplicates the gate the day a second trigger wants it. Rejected — symptom
patch, not root cause.

**B — One shared gate in `TriggerBase.run()`, enforce-by-default when a schema
is declared.** `Configuration.init` starts carrying `_config.input`; the gate
runs once, at the top of `run()`, shared by every trigger — but *applies* only
to the request-shaped kinds whose body the schema describes (see **Scope** below).
Declaring a schema *means* enforcement — that is what MCP already advertises
and what the TS types already claim. **Chosen.**

**C — Opt-in env gate mirroring `BLOK_VALIDATE_WORKFLOW_OUTPUT` (off by
default).** Preserves today's behavior, but the default then remains
"advertise a contract and don't honor it," and every schema-declaring workflow
keeps silently accepting garbage. Rejected; an env var survives only as the
kill switch.

## Decision — Option B

1. **Resolve the schema from the live registry, not `Configuration`.**
   *Implementation deviation from the original plan, forced by a fact found
   while building:* `Configuration.init` deep-clones the workflow via
   `JSON.parse(JSON.stringify(...))` on the boot-scan path, which **destroys a
   Zod object** — so `Configuration` cannot carry the real schema. The live Zod
   only survives on the `WorkflowRegistry` entry (`entry.workflow._config.input
   ?? entry.workflow.input`), which is exactly where the MCP trigger already
   reads it to advertise the tool `inputSchema`. The gate resolves the schema
   the same way, by workflow name — one source of truth, no `Configuration`
   change. Unregistered workflow or no `input` → `undefined` → no-op.
   (`core/runner/src/workflow/validateWorkflowInput.ts`.)
2. **One gate in `TriggerBase.run()`.** At the top of the `try` block (before
   the scheduling/concurrency gates — a malformed request must not consume a
   debounce window or a concurrency slot), when `ctx.request` exists and the
   kill switch is off:
   - `schema.safeParse(ctx.request.body)`.
   - Failure → throw a `GlobalError` with code 400 and the same structured
     `validation_errors` body the node-level Zod gate produces. Rather than
     extract the *private* `zodErrorToGlobalError` off `FunctionNode` across a
     module boundary, the ~6-line builder is inlined in the helper (lazier,
     same shape). The run traces as failed through the normal catch path.
   - Success → **`ctx.request.body = parsed.data`**. Defaults and coercions
     apply; runtime behavior finally matches both the advertised JSON Schema
     and the compile-time `z.infer` types.
3. **Kill switch, not opt-in:** `BLOK_VALIDATE_WORKFLOW_INPUT=0` disables the
   gate globally (mirrors the naming of the output gate). No new per-workflow
   API surface.
4. **Transports change nothing.** HTTP → 400 JSON, MCP → `isError: true` with
   the validation detail in the text content, gRPC → error status: all via the
   existing `GlobalError` handling.

**Delivered:** `parseWorkflowInput` / `resolveDeclaredInputSchema` +
`TriggerBase.run` wire-in; unit test (`validateWorkflowInput.test.ts`) and
MCP end-to-end test (`McpTrigger.input-validation.test.ts`: malformed → `isError`,
valid → defaults applied, kill switch → passthrough); doc-comment fix on
`workflowV2.ts`, MCP trigger doc note, CHANGELOG `Unreleased` entry.

### Scope (corrected after the ctx-integrity audit)

The gate is **not** "every trigger." An adversarial audit of the first cut found
two real defects — both fixed by the pure predicate `shouldRunInputGate`
(`validateWorkflowInput.ts`), unit-tested in `validateWorkflowInput.test.ts`:

1. **Re-entry double-parse (MAJOR).** The gate mutates `ctx.request.body` in
   place. The first cut keyed only on `ctx.request` presence, so a deferred
   re-entry (delay / debounce / `onLimit:queue` / durable recovery — all
   re-enter `run(ctx)` with `_blokDispatchReentry=true` on the *same* ctx)
   re-parsed the already-parsed body. A non-idempotent `.transform()` then
   double-applied, and a *type-changing* transform threw 400 on the second
   pass — silently `failRun`-ing a run the client had already been told 202 for.
   **Fix:** skip the gate when `isReentryAtTrace` (the body was validated +
   normalized on the first pass). Mirrors the sibling scheduling gate, which was
   already re-entry-guarded.

2. **Wrong scope (MAJOR, fixed in two rounds).** Keying on `ctx.request`
   presence did **not** exclude worker/cron/pubsub — they all set `ctx.request`.
   A cron workflow declaring `input` would 400 every tick (its body is
   framework-generated `{ jobId, scheduledTime, … }`, never the schema's
   subject); a worker would silently strip `job.data` fields or hard-fail poison
   jobs. A first fix scoped by the workflow's *declared* trigger config
   (`"http" in cfg.trigger`) — but a second audit pass caught that this still
   mis-fires for a **multi-trigger** workflow (e.g. `{ http, worker }`, a
   supported pattern): fired via its worker side, `cfg.trigger` still contains
   `http`, so the gate would validate `job.data`. **Fix:** scope by the
   **invoking trigger**, not the declared config — `TriggerBase.validatesDeclaredInput()`
   (default `false`, overridden `true` only in HTTP/MCP/gRPC) reflects which
   trigger actually fired. A `{ http, worker }` workflow is validated on its HTTP
   side and not when a job fires it. Any trigger kind, present or future,
   defaults to not-validating until it opts in.

### Scope: which triggers validate, and why

For a trigger to safely body-validate, its `ctx.request.body` must genuinely be
the caller/producer payload the schema describes **and** a thrown 400 must reach
a real rejection rather than a retry loop or a swallowed 200. An initial attempt
to switch this on for *every* request-carrying trigger was adversarially audited
and reverted; the failure modes it surfaced were then **fixed**, which is what
lets worker/pubsub/webhook join the scope safely.

**IN — validates declared `input`:**

| Trigger | Body is caller input | What makes a 400 safe |
|---|---|---|
| **http / mcp / grpc** | request body / tool args / message | transports already render a 400 / `isError` / error status |
| **worker** | `job.data` | validation 400 is terminal → DLQ **without** burning the retry budget |
| **pubsub** | `message.body` | validation 400 → dead-letter (or ack-drop), never an unbounded nack loop |
| **webhook** | POST body (post-signature) | validation 400 → real 4xx + the delivery is **not** cached as processed |

**OUT — body is not caller input (validating would break them):**

| Trigger | Why excluded |
|---|---|
| **cron** | body is framework tick metadata (`{ jobId, scheduledTime, … }`) — a required-field schema would 400 **every tick**. Permanently out; a tick has no caller input. |
| **sse** | body is a hardcoded `{}`; the caller's data is in query/headers. A required-field schema would 400 **every connection**. Needs a *different* surface (validate query/params). |
| **websocket** | one workflow handles connect/message/disconnect, each a different framework-shaped body; only `message` carries caller data (enveloped). A single flag can't distinguish them, and a 400 on `connect` aborts the auth handler while the socket stays open. Needs per-event schemas. |

### Making worker/pubsub/webhook safe (the enabling work)

A shared classifier marks the gate's failure terminal, and each trigger routes it
instead of looping/swallowing:

- **`WORKFLOW_INPUT_VALIDATION` tag + `isNonRetryableValidationError`**
  (`core/shared/src/BlokError.ts`). The gate stamps `context.name` with the tag;
  the classifier matches **only** that. Deliberately narrow — a node's own
  `BlokError.validation()` keeps its existing retry/nack/200 handling, so this
  changes no pre-existing error semantics (and never surfaces a node error's
  stack/contextSnapshot through the webhook 4xx).
- **Worker** — `handleJob` routes a tagged failure to `job.fail(err, false)`
  (terminal) instead of the attempt-counter path. That contract was only honoured
  by some adapters, so three were fixed: **BullMQ** (`discard()` + re-throw, so
  BullMQ's own handler records the *real* error with its correct lock token —
  `moveToFailed` here always threw `Lock mismatch` because `job.token` is never
  set), **SQS** (DLQ-send then `DeleteMessage` instead of letting the visibility
  timeout redeliver), **pg-boss** (resolve instead of throw, so pg-boss does not
  retry). InMemory/NATS/RabbitMQ/Kafka/Redis were already terminal.
- **Pub/Sub** — `handleMessage` publishes to `deadLetterTopic` when configured,
  then **ACKs** (universally stops redelivery, incl. unblocking Kafka's partition
  head) rather than nacking into an unbounded loop. Non-validation errors still
  nack (at-least-once preserved).
- **Webhook** — `dispatchWorkflow` re-throws the tagged failure; `handleRequest`
  renders a real 4xx with `validation_errors` and returns **before** the
  dedup-cache write, so a corrected resend is not deduped. Other errors keep the
  "delivery received, the workflow owns its retry" 200 contract.

### Other edge cases

- **No schema declared** → gate is a no-op; zero behavior change and zero cost.
- **Sub-workflows** bypass `TriggerBase.run()` by design
  (`SubworkflowNode` direct dispatch); child inputs are author-mapped and
  compile-time typed. Out of scope.
- **Unknown-key stripping:** Zod object schemas strip unknown keys on parse,
  so replacing the body drops undeclared fields. This is the security-correct
  trust-boundary behavior, but it is a behavior change for workflows that
  declared a schema *and* read undeclared body fields via raw `ctx` paths —
  called out in the changelog; `.passthrough()` schemas opt out per workflow.
- **Middleware ordering:** triggers run `applyMiddlewareChain` before
  `this.run(ctx)` (e.g. `McpTrigger.ts:429-430`), so middleware that rewrites
  the body runs *before* validation — the gate validates what the workflow
  will actually see.

## Consequences

- Malformed MCP calls return `isError: true` with named fields immediately —
  no more silent runs with `undefined` inputs and no more opaque
  mapper/node-level failures for what is a caller error. Same for HTTP (400)
  and gRPC.
- The advertised MCP `inputSchema`, the TS entry-handle types, and runtime
  behavior become one contract instead of three.
- One shared gate, scoped to the request-shaped triggers (http/mcp/grpc); other
  kinds opt in later by name. MCP's output gate gains a symmetric home over time.
- **Behavior change** (the point): schema-declaring workflows that previously
  "worked" on non-conforming payloads now 400. Ship in a minor with a
  prominent changelog note; `BLOK_VALIDATE_WORKFLOW_INPUT=0` is the escape
  hatch. Per-request cost is one `safeParse`, only when a schema is declared.
- Tests to land with it: MCP malformed-args → `isError` + `validation_errors`;
  HTTP 400 body shape; defaults applied on success; kill switch; no-schema
  no-op. Docs: fix the `workflowV2.ts:78-83` doc comment, update
  `docs/d/triggers/mcp` + http, changelog entry.
