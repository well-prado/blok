---
"@blokjs/runner": patch
---

`defineNode()` nodes keep the thrown error reachable on `cause`, so
`retry.nonRetryableErrorNames` can actually match them (#893).

`FunctionNode.mapErrorToGlobalError` rebuilt a plain thrown `Error` as a fresh
`GlobalError` carrying the NODE's name and nothing else — the original
`Error.name` and the whole `cause` chain were dropped before the step-retry loop
ever saw the failure. Two of the three documented matching semantics of
`retry.nonRetryableErrorNames` (`Error.name`, a wrapped `cause`) were therefore
unreachable from `defineNode()`, the recommended authoring path: a step
declaring `nonRetryableErrorNames: ["Boom"]` and throwing a `Boom` still burned
its entire retry budget, and — since #679 — the worker job replayed on top of
that. Only a hand-thrown `GlobalError` + `setName(...)` ever matched.

The original error is now attached to the rebuilt `GlobalError` as `cause`, with
the same non-enumerable descriptor `new Error(msg, { cause })` produces. The
existing bounded cause-walk in `isNonRetryableError` finds the real name one hop
down, and the same applies to a value thrown that is not an `Error` at all.

Error envelopes are unchanged: `context.name` still carries the node name (the
HTTP trigger's `origin`, `BlokError.fromUnknown`'s `node`), and `context.message`
/ `context.code` / `context.json` / `context.stack` are untouched. Inside a
`tryCatch` catch arm, `ctx.error.name` and `ctx.error.stack` now report the
author's actual error class and stack rather than a flat `"Error"` — the values
`ctx.error` was always documented to carry.
