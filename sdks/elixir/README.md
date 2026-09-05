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

The default gRPC port is `10010`. Set `GRPC_PORT`, `HOST`, and the bounded
admission settings (`BLOK_ELIXIR_MAX_CONCURRENCY`, `BLOK_ELIXIR_MAX_QUEUE`) through the
environment. `BLOK_BLOB_DIR` enables the shared `blob-v1` claim-check
capability for large payloads.

Nodes are registered at compile time through `config/nodes.exs`; generated
projects write that file from `blokctl runtime add elixir`. The runtime owns
OTP supervision, bounded admission, deadlines, cancellation tokens, crash
isolation, structured errors, and gRPC reflection metadata. Node code should
return values and use the context projection for request, logging, and
cancellation concerns.

See [`docs/architecture/adr-0017-elixir-beam-runtime.md`](../../docs/architecture/adr-0017-elixir-beam-runtime.md)
and [`docs/architecture/runtime/elixir-conformance.md`](../../docs/architecture/runtime/elixir-conformance.md)
for the governing design and executable evidence.
