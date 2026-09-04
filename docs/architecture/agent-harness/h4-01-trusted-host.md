# H4-01 — Trusted desktop host and sidecar supervision

Status: boundary slice

This slice establishes the narrow Rust/Tauri 2 boundary between the untrusted
WebView and the Blok/agent sidecar. It does not implement the desktop product,
model UI, filesystem adapter, PTY backend, secure-keychain integration, or
runtime-pack installer.

## Host contract

`apps/desktop/src-tauri/src/host.rs` owns:

- a cryptographically random, process-local control-plane credential;
- a loopback-only endpoint descriptor using control-plane contract version `1`;
- structured `Command::args` sidecar launch with an empty ambient environment;
- readiness polling, bounded exponential restart backoff, crash observation, and
  graceful shutdown with a kill fallback;
- strict host command decoding and the existing control-plane operation allow-list;
- separate model and PTY event variants in one bounded, monotonically sequenced
  queue that reports backpressure rather than dropping events.

The public endpoint returned to the WebView contains only address, port, and
contract version. The token is injected into the sidecar environment and is
redacted from `Debug`; frontend storage, URLs, status responses, and logs are
not credential stores. Production platform secret persistence belongs in the
host-owned Keychain/Secret Service/DPAPI adapter when non-ephemeral values are
introduced.

Readiness is intentionally transport-level in this slice: a loopback TCP probe
must succeed before the sidecar is reported ready. The sidecar remains
responsible for the authenticated `@blokjs/control-plane` gRPC health/readiness
contract, so a later integration should add the health RPC check without
changing the host boundary.

## Conformance evidence

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

The suite covers public-address rejection, token non-disclosure, command and
payload allow-lists, shell-free argv/NUL validation, empty ambient environment,
ordered bounded channels with backpressure, readiness before success, restart
backoff, crash/failure reporting, and shutdown cleanup.

The portable no-default-features mode is intentional for Linux CI without
Tauri/WebKit system libraries. Tauri feature compilation, signed Linux/macOS/
Windows bundles, process-tree termination on Windows, platform secure stores,
and runtime-pack signature/checksum/rollback tests require their respective
native release runners and remain follow-up integration work.

## Governing decisions

- [ADR 0001 — Layered harness boundaries](adr/0001-layered-harness-boundaries.md)
- [ADR 0003 — Capabilities, effects, and policy](adr/0003-capabilities-effects-and-policy.md)
- [ADR 0006 — Harness control plane](adr/0006-harness-control-plane.md)
- [ADR 0009 — Desktop packaging and runtime packs](adr/0009-desktop-packaging.md)
- [ADR 0010 — Security and behavioral conformance](adr/0010-security-and-behavioral-conformance.md)
