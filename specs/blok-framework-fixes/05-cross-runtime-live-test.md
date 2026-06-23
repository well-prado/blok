# SPEC 05 — Cross-runtime examples: live test + fixes

**Status:** Fix #1 shipped · Finding #2 **fixed** (root cause was runner-side, not per-SDK — see below)
**Scope:** `examples/ts-workflows/runtime-<lang>-hello.ts` (the 7 cross-runtime examples)

## What this is

The 7 cross-runtime hello-world examples (`runtime-go-hello.ts`,
`runtime-rust-hello.ts`, … `runtime-python3-hello.ts`) dispatch to a language
SDK's built-in `hello-world` node over gRPC. They had only ever been
typecheck-verified — never run against a live sidecar. This SPEC records the
first **live** end-to-end test (Python3, the one SDK toolchain available on the
dev machine) and the issues it surfaced.

## How it was tested (reproducible)

The dispatch path is identical for all 7 runtimes; Python3 was used because
`grpcio` ships a wheel for the available interpreter (no compile).

1. **Sidecar** — Python 3.14 venv, `pip install -e "sdks/python3[grpc]"`, then:
   ```bash
   cd sdks/python3
   BLOK_TRANSPORT=grpc GRPC_PORT=10007 HOST=127.0.0.1 .venv/bin/python bin/serve.py
   # → "Blok gRPC server (NodeRuntime v1) listening on 127.0.0.1:10007 with 5 nodes registered"
   ```
2. **Runner / HTTP trigger** — monorepo dev server pointed at the sidecar:
   ```bash
   RUNTIME_PYTHON3_HOST=127.0.0.1 RUNTIME_PYTHON3_GRPC_PORT=10007 \
   BLOK_TRANSPORT=grpc PORT=4000 bun run http:dev
   ```
   (The example was registered for the test by dropping a JSON mirror into the
   auto-scanned `triggers/http/workflows/json/` — the monorepo dev server does
   not auto-register `examples/ts-workflows/*.ts`; scaffolded projects do, via
   `generateSharedWorkflowsFile`.)
3. **Request:**
   ```bash
   curl -X POST localhost:4000/runtimes/python3/hello -d '{"name":"Ada"}'
   ```

## Verified behavior ✅

The full chain works: HTTP body → runner → gRPC `NodeRuntime/Execute` →
Python3 `hello-world` node → response, with `language: "python3"` proving it
executed in the sidecar.

| Request body | Step inputs | Response message |
|---|---|---|
| `{"name":"Ada"}` | `{prefix:"Hello from the Python3 runtime"}` | `Hello from the Python3 runtime, Ada!` |
| `{}` | `{prefix:"Hello from the Python3 runtime"}` | `Hello from the Python3 runtime, World!` |

This confirms **both** data channels independently:
- `name` flows in via the request **body** (the node reads `ctx.request.body.name`).
- `prefix` flows in via the step **inputs** (resolved inputs become the node's `config`).

## Issue #1 — the example demonstrated the wrong data channel (FIXED)

**Symptom / root cause.** Every SDK's `hello-world` node reads `name` from the
request **body** and `prefix` from **config**:

| SDK | `name` source | `prefix` source |
|---|---|---|
| go / rust / java / csharp / php / ruby / python3 | request body | step config |

The original examples passed `inputs: { name: $.req.body.name }`. The node
**ignores** that — it reads `name` from the body, not config — so the input was
dead code. The example appeared to work only because the HTTP body happened to
carry `name`. A reader would reasonably conclude "step inputs feed `name`,"
which is false.

**Fix.** Pass `prefix` via `inputs` instead — a field the node *does* read from
config — and let `name` flow through the body. The example now demonstrates both
channels honestly, and the output visibly reflects the input (`Hello from the
<Lang> runtime, …`). Applied to all 7 examples with a clarifying comment:

```ts
{
  id: "greet",
  use: "hello-world",
  type: "runtime.python3",
  // Step inputs become the node's config. The hello-world node reads
  // `prefix` from there; `name` flows in separately from the request body.
  inputs: { prefix: "Hello from the Python3 runtime" },
}
```

**Validation.** Live-tested above — the custom prefix appears in the output,
which the old `inputs:{name}` form could never demonstrate.

## Finding #2 — `contentType` leaks into runtime-node response bodies (FOLLOW-UP)

**Symptom.** A `runtime.*` node whose output is emitted directly as the HTTP
response includes a spurious `contentType` field:

```json
{"message":"Hello from the Python3 runtime, Ada!","timestamp":"…","language":"python3","contentType":"application/json"}
```

In-process (`module`) nodes do **not** exhibit this — the earlier MCP greeter
(`@blokjs/expr`) returned clean JSON. So it is specific to the gRPC runtime path.

**Actual root cause (corrected).** The original hypothesis — that each SDK
serializes `contentType` *inside* `ExecuteResponse.data` — was **wrong**. Every
SDK (go / rust / java / csharp / php / ruby / python3) already serializes `data`
verbatim from the node's return and puts the content-type ONLY in the dedicated
proto `content_type` field. Proven for Python3 both by reading
`grpc_server._encode_execute_response` and empirically:
`json.loads(resp.data)` has **no** `contentType` key while `resp.content_type ==
"application/json"`. `GrpcCodec.decodeExecuteResponse` likewise keeps the two
fields separate, so `decoded.data` reaching the runner is clean.

The leak was **runner-side**, in the HTTP trigger. Runtime adapter nodes leave
their raw return value on `ctx.response` (no `BlokResponse` wrapper). The trigger
then ran `ctx.response.contentType = "application/json"` — mutating that raw
payload object IN PLACE (and, via the shared reference, the value stored in
`ctx.state[<id>]`). Because the mutated object now had a `contentType` key but
no `data` key, `emitWorkflowResponse`'s wrapper detection (`"data" in x &&
"contentType" in x`) treated it as a raw body and emitted the whole polluted
object. `RunnerSteps` had the same in-place stamp between steps, so a later step
could pollute an earlier runtime step's `$.state` too.

**Fix (shipped).** Runner-side, no SDK changes needed:

- `HttpTrigger` (and `GRpcTrigger`) now *wrap* a raw response into a fresh
  `{ data, contentType }` envelope via `normalizeResponseEnvelope()` instead of
  mutating it — so the node's return is emitted as the body verbatim and the
  content-type maps to the `Content-Type` header.
- The content-type is sourced from the SDK's proto `content_type`, threaded
  `GrpcCodec` → `GrpcRuntimeAdapter.toExecutionResult` (`ExecutionResult.contentType`)
  → `RuntimeAdapterNode` (ctx `_stepContentType` side-channel, reset per-step by
  `RunnerSteps`) → trigger. So a future SDK that emits a non-default
  `content_type` (binary/HTML) flows straight to the header.
- `RunnerSteps`' between-step stamp is guarded to wrapper-shaped responses only,
  so it can no longer pollute a raw runtime payload or its `$.state` slot.

Regression coverage: `RuntimeAdapterNode.test.ts` (no leak into data/state +
side-channel + multi-step state isolation), `responseEmitter.test.ts`
(`normalizeResponseEnvelope` + end-to-end clean body / mapped header), and the
Python3 SDK `test_encode_response_keeps_content_type_out_of_data`. Verified live
end-to-end against the Python3 sidecar: the body is now
`{"message":…,"language":"python3"}` with no `contentType` key and a correct
`Content-Type: application/json` header.

## Notes

- Cross-runtime examples are **not** auto-registered in the monorepo dev
  server (only scaffolded projects register them, by design). Live-testing in
  the monorepo requires a manual registration (JSON drop-in or `Workflows.ts`
  entry). Not a bug; documented here so the next person doesn't hunt for it.
- Only Python3 was live-tested (toolchain availability). The other 6 share the
  identical dispatch path and an identical node contract (verified by reading
  all 7 node sources), so the fix applies uniformly — but go/rust/java/csharp/
  php/ruby remain live-unverified on this machine.
