# Blok desktop host

This directory contains the first H4-01 desktop-host boundary. The Rust crate
under `src-tauri` is the trusted side of a Tauri 2 application; the WebView is
not given shell, filesystem, network, secret, or process APIs.

The host owns an ephemeral control-plane credential, launches the Blok/agent
sidecar with structured argv, waits for its authenticated loopback endpoint to
be ready, and supervises shutdown and bounded restarts. The credential is held
in host memory and is never returned by a Tauri command, written to frontend
storage, included in a URL, or emitted in host status.

The TypeScript surface in `src` provides the H4-02 reference coding-harness
workflow. It runs `understand -> plan -> approve -> implement -> test ->
review` through the authenticated control plane, keeps mutations in a task
worktree, and exposes ordered session events, approval callbacks, trusted test
evidence, and the review diff to a renderer or headless client. See
`docs/architecture/agent-harness/h4-02-desktop-vertical-slice.md` for the
boundary and conformance contract.

## Local development

The core host tests do not require a graphical desktop or Tauri system
libraries:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

When the platform toolchain is installed, the Tauri application can be run
with `cargo tauri dev` from `apps/desktop/src-tauri`. The frontend and actual
agent binary are intentionally placeholders in this boundary slice; the
sidecar contract is documented in `src-tauri/src/host.rs` and reuses the
versioned `@blokjs/control-plane` protocol.

## Packaging responsibilities

| Target | Host responsibility | CI/release note |
| --- | --- | --- |
| Linux | Bundle the Tauri host and the self-contained TypeScript/agent sidecar; keep the control plane on loopback and use the desktop secret store for any persisted installation metadata. | Validate AppImage/deb permissions, CSP, and sidecar executable bits on Ubuntu. |
| macOS | Sign and notarize the `.app`; ensure the sidecar is in the app bundle and receives no ambient environment; use Keychain for non-ephemeral update metadata. | Build separately for Apple Silicon and Intel; notarization requires Apple credentials and is not run in this repository's Linux CI. |
| Windows | Sign the executable/MSI; launch the sidecar without shell parsing and terminate its process tree during shutdown. | Build separately for x64/ARM64; Windows signing and process-tree validation require a Windows runner. |

The first bundle contains the TypeScript/agent runtime only. Optional Blok
language runtimes are separate runtime packs. A runtime-pack installer must
verify a signed manifest and checksum, validate host/Blok compatibility,
install into a staging directory, atomically swap the versioned directory,
and restore the previous version on activation failure. That installer is
outside this minimal host boundary and must not silently install a missing
runtime.

## Governing architecture

- `docs/architecture/agent-harness/adr/0001-layered-harness-boundaries.md`
- `docs/architecture/agent-harness/adr/0003-capabilities-effects-and-policy.md`
- `docs/architecture/agent-harness/adr/0006-harness-control-plane.md`
- `docs/architecture/agent-harness/adr/0009-desktop-packaging.md`
- `docs/architecture/agent-harness/adr/0010-security-and-behavioral-conformance.md`

Conformance evidence is in `src-tauri/src/host.rs` tests: command allow-list
and payload bounds, loopback endpoint validation, structured process argument
validation, credential non-disclosure, ordered bounded channels, readiness
failure/backoff, crash observation, and graceful shutdown.
