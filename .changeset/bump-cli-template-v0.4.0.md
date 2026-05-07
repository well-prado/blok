---
"blokctl": patch
---

Bump scaffold template tag to v0.4.0.

`blokctl create project` now clones the repo at the v0.4.0 release
tag, so new projects scaffold with the explicit-path-only routing
model (`trigger.http.path` required), the `blokctl migrate paths`
codemod, and the rest of the v0.4 surface.

No CLI behavior changes — internal configuration only.
