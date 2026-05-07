---
"@blokjs/trigger-http": minor
"blokctl": minor
---

**Breaking change** — `trigger.http.path` is now REQUIRED on every
HTTP-triggered workflow. The legacy URL-derivation systems
(filename-to-URL mapping, `/<workflow-key>/<sub>` catch-all) are gated
behind `BLOK_ROUTING_LEGACY=1` and will be removed in v0.5.

Migration: run `blokctl migrate paths` to auto-fill missing paths from
the file location. Idempotent — re-running on a fully-migrated repo is
a no-op. See the migration guide for details.

The CLI ships a new `migrate paths` subcommand alongside the existing
`migrate workflows` and `migrate node`. blokctl bumped minor since
this is a new feature.

`@blokjs/trigger-http` exports a new `MissingExplicitPathError` that
fires when a workflow loads without an explicit path and the legacy
flag isn't set. Error message includes a pointer to the codemod.
