# ADR 0009 — Desktop packaging and runtime packs

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

Tauri provides a small cross-platform shell and a Rust trust boundary. Blok is
TypeScript-first and supports seven additional language sidecars. Bundling every
runtime in the first desktop application would increase download size, update
complexity, startup time, and attack surface.

## Decision

The Tauri Rust host supervises a self-contained Blok/agent sidecar, owns endpoint
credentials, ordered UI channels, PTY/process handles, filesystem watching,
secure storage, updates, and shutdown. The WebView receives narrowly scoped IPC
commands.

The first release bundles only the runtime required by the agent kernel and
TypeScript workflows. Other Blok language runtimes are separately versioned,
verified runtime packs installed on demand. Fixed runtime ports are not exposed
as the desktop control plane.

## Consequences

- Build/release matrices cover each supported OS and architecture.
- Runtime packs require checksums/signatures, provenance, compatibility
  metadata, atomic installation, and rollback.
- A missing optional runtime produces an actionable capability error rather
  than silently installing or executing software.
- Headless and cloud distributions can reuse the sidecar and control-plane
  contracts without Tauri.
