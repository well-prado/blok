# Blok Elixir SDK

This package is the first-class Elixir/OTP sidecar for `runtime.elixir`. It
implements the canonical `NodeRuntime` gRPC v1 ABI and keeps node authors in
native Elixir modules: schemas are declared with `use Blok.Schema`, and nodes
with `use Blok.Node`.

## Local development

```sh
mix deps.get
mix proto.generate
mix format
mix test
mix run --no-halt
```

The default gRPC port is `10010`. Nodes are registered at compile time through
`config/nodes.exs`; generated projects write that file from
`blokctl runtime add elixir`.

## Authoring nodes

A node is a module with an input schema, an optional output schema, and an
`execute/2`. Upstream workflow values arrive as the second argument; the
context is for runtime concerns only.

```elixir
defmodule MyApp.Nodes.RiskScoreInput do
  use Blok.Schema

  field :account_id, :string, required: true
  field :window_days, :integer, default: 30
end

defmodule MyApp.Nodes.RiskScoreOutput do
  use Blok.Schema

  field :score, :number, required: true
  field :band, :string, required: true
end

defmodule MyApp.Nodes.RiskScore do
  use Blok.Node,
    name: "risk-score",
    description: "Scores an account over a rolling window",
    input: MyApp.Nodes.RiskScoreInput,
    output: MyApp.Nodes.RiskScoreOutput,
    capability_manifest: %{
      "version" => "1",
      "classification" => "agent-compatible",
      "effects" => [],
      "secrets" => []
    }

  @impl Blok.Node
  def execute(ctx, %MyApp.Nodes.RiskScoreInput{} = input) do
    Blok.Logger.info(ctx, "scoring", account_id: input.account_id)
    Blok.Context.check_cancelled!(ctx)

    {:ok, %MyApp.Nodes.RiskScoreOutput{score: 0.42, band: "low"}}
  end
end
```

Rules that the runtime enforces for you:

- Field names are compile-time atoms; JSON keys, headers, and node names stay
  binaries. Adversarial input cannot grow the atom table.
- Unknown wire keys are rejected with stable JSONPath issues (`$.account_id`).
- Returning `{:error, %Blok.Error{}}` (or raising) produces a canonical
  `NodeError`; returning a struct validates against the output schema.
- Capability manifests carry opaque secret *reference* names, never values.

The context projection is `ctx.request`, `ctx.response`, `ctx.vars`, `ctx.env`,
`Blok.Context.check_cancelled!/1`, `Blok.Context.remaining_ms/1`, and
`Blok.Logger`. Accumulated workflow state is not shipped to the sidecar.

## Testing

```sh
mix test                      # unit, config, telemetry, BEAM failure modes
mix format --check-formatted
```

`test/beam_failure_modes_test.exs` is the reference for how to exercise the
runtime: it drives `Blok.Runtime.execute/1` directly, and starts isolated
`Blok.Admission` instances (`name: nil`, small `max_concurrency`/`max_queue`,
own `task_supervisor`) when a test needs to saturate capacity deterministically.

## Supervision, concurrency, and cancellation

```
Blok.Supervisor (one_for_one)
├── Task.Supervisor  Blok.ExecutionTaskSupervisor   (ceiling: concurrency + queue)
├── Blok.Registry     compile-time node table
├── Blok.Admission    bounded concurrency + queue, deadlines, drain
└── GRPC.Server.Supervisor → Blok.Endpoint → Blok.Runtime.Service
```

- **Admission.** At most `BLOK_ELIXIR_MAX_CONCURRENCY` executions run at once
  and at most `BLOK_ELIXIR_MAX_QUEUE` wait. Past that, the runtime answers
  `RUNTIME_OVERLOADED` (`RATE_LIMIT`, retryable) instead of queueing without a
  bound. Because `Execute` is a blocking call, backpressure reaches the caller
  rather than the mailbox. The task supervisor's own ceiling sits above the
  admission bound so a task that is still terminating cannot masquerade as
  saturation.
- **Isolation.** Each execution is a monitored task. A node that raises,
  throws, exits, or is killed fails exactly one execution: `NODE_ERROR`,
  `NODE_THROW`, `NODE_EXIT`, or `NODE_PROCESS_CRASH`. The endpoint, the
  registry, and concurrent executions are untouched.
- **Deadlines.** `options.deadline_ms` (default 30s) arms a timer owned by
  admission. On expiry the execution process is killed and the caller gets
  `NODE_DEADLINE_EXCEEDED`. Anything the node linked — `Task.start_link`,
  `spawn_link` — dies with it, so a timed-out node leaves no orphans. Processes
  a node deliberately unlinks are its own responsibility.
- **Cooperative cancellation.** `Blok.Context.check_cancelled!/1` and
  `Blok.Context.remaining_ms/1` let long loops and I/O stop early instead of
  waiting to be killed.
- **Drain.** `Blok.Admission.stop_admission/0` stops accepting, answers queued
  work with `RUNTIME_DRAINING` instead of stranding it, and lets in-flight
  executions finish; `Health` reports `NOT_SERVING`. Application shutdown drains
  with a bounded grace before terminating.
- **Recovery.** The tree is `one_for_one`: if admission dies, it restarts and
  the gRPC endpoint keeps serving.
- **CPU-heavy work.** The BEAM preempts Elixir code but not NIFs. Long CPU work
  or a blocking NIF belongs behind your own dirty-scheduler/worker policy; the
  SDK cannot make an unknown NIF safe.

## Telemetry and logging

`:telemetry` events, all with metadata `%{node, run_id, workflow}` and nothing
else — no inputs, env values, headers, or outputs:

| Event | Measurements | Extra metadata |
| --- | --- | --- |
| `[:blok, :execution, :start]` | `system_time`, `queue_time_ms` | — |
| `[:blok, :execution, :stop]` | `duration_ms`, `queue_time_ms` | `result` (`:ok`/`:error`) |
| `[:blok, :execution, :exception]` | `duration_ms`, `queue_time_ms` | `kind`, bounded `reason` |

`Blok.Telemetry.events/0` returns the list for `:telemetry.attach_many/4`.
Logger metadata inside an execution carries `run_id`, `node`, and `workflow`.
`Blok.Logger` redacts values whose key looks secret (`secret`, `token`,
`password`, `credential`, `authorization`) and truncates large binaries;
`Blok.Logger.safe_inspect/1` bounds crash reasons before they reach an error
envelope. Per-request gRPC logging is `:debug`, so `BLOK_LOG_LEVEL=debug` is
the switch for tracing individual calls.

## Configuration

Every knob is an environment variable, parsed and validated at boot by
`Blok.Config`. A malformed value fails startup with a message naming the
variable rather than silently falling back to a default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address (IP literal). |
| `GRPC_PORT` / `RUNTIME_ELIXIR_GRPC_PORT` | `10010` | Listen port. |
| `BLOK_GRPC_MAX_MESSAGE_BYTES` | `16777216` | Maximum accepted request body. |
| `BLOK_GRPC_KEEPALIVE_TIME_MS` | `10000` | Connection idle ceiling. |
| `BLOK_GRPC_KEEPALIVE_TIMEOUT_MS` | `5000` | HTTP/2 settings/handshake ceiling. |
| `BLOK_GRPC_MAX_CONNECTIONS` | `256` | Concurrent connections. |
| `BLOK_GRPC_TLS_CERT` / `BLOK_GRPC_TLS_KEY` | unset | Server TLS pair — both or neither. |
| `BLOK_GRPC_TLS_CA` | unset | Client CA; enables mTLS (`verify_peer`). |
| `BLOK_ELIXIR_MAX_CONCURRENCY` | `16` | Concurrent executions. |
| `BLOK_ELIXIR_MAX_QUEUE` | `64` | Queued executions before overload. |
| `BLOK_ELIXIR_CANCELLATION_GRACE_MS` | `250` | Drain grace before forced termination. |
| `BLOK_LOG_LEVEL` | `info` | `debug`, `info`, `warning`, `error`, `none`. |
| `BLOK_BLOB_DIR` | unset | Enables the `blob-v1` claim-check capability. |
| `BLOK_BLOB_MAX_BYTES` | `268435456` | Claim-check read ceiling. |

TLS parity: the other Blok SDK sidecars terminate TLS at the platform, and the
runner dials them with `RUNTIME_<KIND>_TLS_*` / `BLOK_GRPC_TLS_*` client
settings. This sidecar additionally supports terminating TLS itself with the
cert/key pair above; point the runner at it with `RUNTIME_ELIXIR_TLS_CA`. The
BEAM server does not send HTTP/2 keepalive pings — the keepalive variables are
enforced as Cowboy idle/inactivity/settings ceilings.

## Benchmarks

```sh
GRPC_PORT=20010 mix blok.bench --concurrency 32 --duration 15
```

Boots the sidecar, drives `typed-greet` over real gRPC, and prints throughput,
p50/p95/p99 latency, admission queue time, peak process count, scheduler
utilisation, reductions, memory, and an error tally by code. Recorded runs live
in [`docs/architecture/runtime/elixir-conformance.md`](../../docs/architecture/runtime/elixir-conformance.md).

## Deployment

**Mix release.**

```sh
MIX_ENV=prod mix release
GRPC_PORT=10010 _build/prod/rel/blok/bin/blok start
_build/prod/rel/blok/bin/blok stop     # drains admission, then terminates
```

**Container.** The bundled `Dockerfile` is a multi-stage build that produces a
non-root release image:

```sh
docker build -t blok-elixir sdks/elixir
docker run --rm -e GRPC_PORT=10010 -p 10010:10010 blok-elixir
```

Readiness is the `Health` RPC: `SERVING` while admission accepts work,
`NOT_SERVING` while draining. `SIGTERM` runs `prep_stop`, which stops admission
and drains in-flight executions before the VM exits.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Boot fails with `ArgumentError: … must be a positive integer` | A malformed env var. The message names it; fix the value. |
| `RUNTIME_OVERLOADED` under load | Admission is saturated. Raise `BLOK_ELIXIR_MAX_CONCURRENCY`/`BLOK_ELIXIR_MAX_QUEUE`, or slow the caller — the error is retryable with `retry_after_ms`. |
| `RUNTIME_DRAINING` | The sidecar is shutting down or was drained. Expected during deploys. |
| `NODE_DEADLINE_EXCEEDED` on a long node | Raise the step's `maxDuration`, or make the node cooperative with `Blok.Context.check_cancelled!/1`. |
| `NODE_NOT_FOUND` | The node module is not in `config/nodes.exs`. Re-run `blokctl runtime add elixir` / `blokctl dev`. |
| `port already in use` at boot | Another process holds `GRPC_PORT`. |
| Node output rejected | The output struct does not match its schema; the issue path (`$.field`) names the field. |
| Need per-call tracing | `BLOK_LOG_LEVEL=debug` turns on the per-request gRPC log line. |
| `blob-v1` not advertised | `BLOK_BLOB_DIR` is unset or not a readable directory. |

See [`docs/architecture/adr-0017-elixir-beam-runtime.md`](../../docs/architecture/adr-0017-elixir-beam-runtime.md)
and [`docs/architecture/runtime/elixir-conformance.md`](../../docs/architecture/runtime/elixir-conformance.md)
for the governing design and executable evidence.
