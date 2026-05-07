---
"blokctl": patch
---

Bump scaffold template tag to v0.3.0.

`blokctl create project` now clones the repo at the v0.3.0 release tag,
so new projects scaffold with the gRPC SDK transport, Workflow v2 DSL,
the full Tier 1 + Tier 2 reliability surface, the security threat-model
docs, and the production-readiness fixes that landed in PR #50.

No CLI behavior changes — internal configuration only.
