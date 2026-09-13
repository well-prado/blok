# ADR 0003 — Zig runtime: transport decision (deferred pending proof)

Status: **Deferred** (2026-09-12). Governs issue #938.

## Context

Issue #938 asks for a first-class Zig SDK and sidecar at `runtime.zig`. Its
first gate is a *transport proof*: the sidecar must speak the canonical
`proto/blok/runtime/v1/runtime.proto` service over real gRPC (HTTP/2 +
protobuf) so the runner's existing `GrpcRuntimeAdapter` drives it unchanged,
exactly as the eleven shipped SDKs do. Zig is not a gRPC-supported language
(grpc.io lists none), so a maintainable, standards-compatible transport has to
be proven before any SDK work is justified; a bespoke protocol that merely
resembles gRPC is unacceptable.

## Options evaluated (September 2026)

| Option | What it is | Standing | Risks for Blok |
| --- | --- | --- | --- |
| `ziglana/gRPC-zig` | Pure-Zig client + server, HTTP/2 with flow control, TLS, gzip/deflate, streaming | Community package on Zigistry; single-org project | Wire compatibility with grpc-js/Go clients unproven for our service; deadline/cancellation and `grpc-status` trailer semantics must be verified; tracks Zig language churn (0.14 → 0.16 breaking releases). |
| `zaxified/zig-libs` (gRPC module) | Pure-Zig HTTP/2 + gRPC client/server, all four call shapes, no codegen | Part of a large monolithic module set pinned to Zig 0.16 | Pulling one module drags a wide dependency surface; same compatibility proof required; single maintainer. |
| `hendriknielaender/zRPC` | Zig bindings over the gRPC **C core** (`libgrpc`) | Community; depends on building the C/C++ core with the Zig toolchain | Most likely wire-exact (it *is* gRPC), but the build becomes a C++ toolchain problem (Docker image size, cross-compilation, ABI drift), and the issue's guardrail forbids claiming "official gRPC support" for C-core bindings. |
| `Arwalk/zig-protobuf` | Protobuf 3 codegen for Zig; generates service *interfaces* only | Active | No transport; would be paired with one of the above for message encoding and generated stubs from the canonical proto. |

None of the candidates has been exercised against Blok's runner. The other
sidecars proved compatibility only by booting under `tests/e2e/cross-runtime/`
and passing the strict SPEC-B harness (Health, ListNodes, Execute, streaming
events, deadlines, structured errors, 2 MiB claim-check).

## Decision

1. **Defer the Zig SDK.** No `sdks/zig`, `runtime.zig` kind, CLI vocabulary,
   or CI lane is added until a transport proof exists. Registering the kind
   without a working sidecar would violate the "no partial SDK" guardrail and
   the fail-closed runtime policy.
2. **Proof gate (the next slice, if resumed):** a minimal Zig server built with
   the preferred pure-Zig option (`ziglana/gRPC-zig` first, `zaxified/zig-libs`
   second; `zRPC` only if both fail) plus `zig-protobuf` codegen from the
   canonical proto, exposing Health, ListNodes and a `typed-greet` Execute. It
   must pass the SPEC-B harness driven by the unmodified runner client, with a
   pinned Zig toolchain, from the cross-runtime Docker compose. Only then does
   the full SDK (capability manifests, claim-check, streaming, CLI, deployment)
   proceed, structured like `sdks/kotlin`.
3. **Toolchain policy for the proof:** pin one Zig release in `build.zig.zon`
   and the Dockerfile; upgrade deliberately, never track master.

## Consequences

- #938 stays open as *blocked on transport proof*; the runtime matrix and
  docs continue to list eleven sidecars.
- The C-core route is explicitly last: it is the most compatible but the least
  maintainable for a small native sidecar, and Blok would not be allowed to
  describe it as official gRPC support.

## References

- [ziglana/gRPC-zig](https://github.com/ziglana/gRPC-zig)
- [zaxified/zig-libs](https://github.com/zaxified/zig-libs/)
- [hendriknielaender/zRPC](https://github.com/hendriknielaender/zRPC)
- [Arwalk/zig-protobuf](https://github.com/Arwalk/zig-protobuf)
- [gRPC supported languages](https://grpc.io/docs/languages/)
- Canonical contract: `proto/blok/runtime/v1/runtime.proto`
