# Blok Error Codes — Reference

> **Status:** Closes master plan §17.4 + §17.11. The single source of
> truth for every stable error code shipped with the framework.

This document is the registry of every well-known `BlokError.code`
emitted by Blok itself or any of its 7 SDKs (TypeScript, Python, Go,
Rust, Java, C#, Ruby, PHP). It exists for two audiences:

- **Node authors** browsing for a code that already covers their
  failure mode — reuse over reinvent.
- **LLMs reading workflow trace output** — every entry below pins
  what the code means, when it fires, what `details_json` shape it
  carries, and what to do about it. With this file in context, an
  LLM looking at a failed `/__blok/runs/:id` response can articulate
  the failure and propose a fix without round-tripping to a human.

## Quick orientation

A `BlokError` has 19 fields on the wire (see proto
`blok.runtime.v1.NodeError`). The two that matter most for routing
and observability are:

| Field | Purpose |
|---|---|
| `category` | One of 12 enum values (`VALIDATION`, `DEPENDENCY`, `TIMEOUT`, …). Drives the default `http_status` and `retryable` hint. |
| `code` | A stable machine identifier (e.g. `POSTGRES_CONNECT_TIMEOUT`). Survives across SDK versions; the contract callers branch on. |

Categories are framework-fixed (see [the 12 categories](#categories)).
Codes are extensible — every node author can mint new ones, but the
codes listed below are reserved by Blok and behave consistently
across every SDK.

## How to use this registry

**Choosing a code.** Search this page (Cmd-F) for the failure mode
you're modelling. If a built-in code exists, use it — the
runner-side and Studio render paths already understand it.

**Inventing a code.** If nothing here fits, mint
`<DOMAIN>_<REASON>` (e.g. `STRIPE_API_DOWN`, `S3_OBJECT_NOT_FOUND`).
Codes must be:

- All-caps, underscore-separated, alphanumeric.
- Stable: never rename a code; deprecate by adding a successor and
  documenting the relationship in a release note.
- Namespaced: never reuse a built-in code (anything below) for a
  user error.

**Auto-generated codes.** When a node throws an unstructured error
(`raise ValueError(...)`, `throw new Error(...)`, etc.) the SDK's
auto-wrap layer produces `UNCAUGHT_<TYPE>` per §17.7 — see
[UNCAUGHT_*](#uncaught_-codes-auto-generated). These codes are still
machine-stable but carry less information than a typed BlokError.

---

## Categories

12 canonical categories, each with a default HTTP status and
retryable hint. Codes inherit their category's defaults unless the
node overrides them.

| Category | Default `http_status` | Default `retryable` | When to use |
|---|---|---|---|
| `VALIDATION` | 400 | false | Input failed schema/contract validation. The caller has to fix the input before retrying. |
| `CONFIGURATION` | 500 | false | Misconfiguration in the runner or node setup (missing env var, bad workflow JSON). |
| `DEPENDENCY` | 502 | true | External dependency unreachable (DB, third-party API). Worth retrying with backoff. |
| `TIMEOUT` | 504 | true | A deadline elapsed (network call, lock acquisition, computation). |
| `PERMISSION` | 403 | false | Caller lacks the role/scope to perform the operation. |
| `RATE_LIMIT` | 429 | true | A quota was exceeded. Combine with `retry_after_ms`. |
| `NOT_FOUND` | 404 | false | Resource doesn't exist. |
| `CONFLICT` | 409 | false | Idempotency violation, concurrent update, version mismatch. |
| `CANCELLED` | 499 | false | Caller cancelled before completion. |
| `INTERNAL` | 500 | false | SDK threw without classification. The default for `UNCAUGHT_*`. |
| `PROTOCOL` | 502 | false | Wire-format / framing / serialization error between runner and SDK. |
| `DATA` | 422 | false | Schema OK but values are unprocessable (e.g. out-of-range, malformed payload after schema validation passes). |

The framework-level table is identical across all SDKs (verified by
the parity matrix in
`core/runner/__tests__/integration/parity/matrix.integration.test.ts`).

---

## Built-in codes

These codes are emitted by the framework itself (the runner, the
gRPC adapter, every SDK's auto-wrap layer). They flow through
unchanged and Studio knows how to render them.

### `VALIDATION_FAILED`

| Field | Value |
|---|---|
| Category | `VALIDATION` |
| Default `http_status` | 400 |
| Retryable | false |
| Source | Any SDK whose handler validates input against a schema and rejects it. The `blok-error-demo` example node emits this in `mode="validation"`. |

**`details_json` shape:**

```json
{
  "issues": [
    { "path": ["email"], "message": "Required" },
    { "path": ["name"],  "message": "Required" }
  ]
}
```

**Remediation:** Fix the missing/invalid fields listed in
`details_json.issues` and resubmit.

---

### `POSTGRES_CONNECT_TIMEOUT`

| Field | Value |
|---|---|
| Category | `DEPENDENCY` |
| Default `http_status` | 502 |
| Retryable | true |
| Source | Demo node only (real applications would emit
custom `<DB>_CONNECT_TIMEOUT` codes per dependency). |

**`details_json` shape:**

```json
{
  "host": "db.internal",
  "port": 5432,
  "timeout_ms": 5000
}
```

**Cause chain:** typically rooted in the language's
network-connection-refused exception (Python `ConnectionError`,
Rust `std::io::ErrorKind::ConnectionRefused`, Go
`net.OpError`, etc.).

**Remediation:** check `DATABASE_URL`, network reachability, and the
connection pool's idle timeouts.

---

### `UPSTREAM_RATE_LIMITED`

| Field | Value |
|---|---|
| Category | `RATE_LIMIT` |
| Default `http_status` | 429 |
| Retryable | true |
| Source | Demo node + any third-party API integration that surfaces 429s. |

**`details_json` shape:**

```json
{
  "limit": 5000,
  "remaining": 0
}
```

`retry_after_ms` carries the suggested wait. If the upstream
provides an `X-RateLimit-Reset` header, convert it to milliseconds.

**Remediation:** wait `retry_after_ms` then retry. For long delays
(>30 s), consider scheduling via a worker trigger instead of
blocking the request.

---

## `UNCAUGHT_*` codes (auto-generated)

When a node throws an error without using the BlokError builder,
every SDK's auto-wrap layer (per §17.7) produces a code of the form
`UNCAUGHT_<TYPE>` where `<TYPE>` is the simple (un-namespaced) class
name, alphanumerics only, uppercased.

| Throw site | Generated code |
|---|---|
| `raise ConnectionError(...)` (Python) | `UNCAUGHT_CONNECTIONERROR` |
| `errors.New("timeout")` (Go) | `UNCAUGHT_ERRORSTRING` |
| `Err(io::Error::new(...))` (Rust) | `UNCAUGHT_ERROR` (or specific type) |
| `throw new IOException(...)` (Java) | `UNCAUGHT_IOEXCEPTION` |
| `throw new InvalidOperationException(...)` (C#) | `UNCAUGHT_INVALIDOPERATIONEXCEPTION` |
| `raise SocketError, ...` (Ruby) | `UNCAUGHT_SOCKETERROR` |
| `throw new \RuntimeException(...)` (PHP) | `UNCAUGHT_RUNTIMEEXCEPTION` |

| Field | Value |
|---|---|
| Category | `INTERNAL` |
| Default `http_status` | 500 |
| Retryable | false |
| `details_json` | varies — usually contains the original message, sometimes structured details. |

**Remediation:** the node should be migrated to the typed BlokError
builder. The `UNCAUGHT_*` codes are an escape hatch, not the
intended API. See `docs/error-handling.md` for the migration
recipe.

The legacy `<LANG>_NODE_ERROR` codes (e.g. `PHP_NODE_ERROR`,
`RUBY_NODE_ERROR`) shipped before §17.5 have been retired — every
SDK now emits `UNCAUGHT_<TYPE>`.

---

## Per-SDK code constants (recommended)

Pick the constant module idiomatic to your SDK rather than typing
the string literally. This catches typos at compile/lint time.

> **Status:** scaffolding shipped per SDK as part of §17.5. The
> built-in codes above are exported as constants by every SDK; user
> codes follow the same module convention. Scaffolds:
>
> - **TypeScript:** `import { BLOK_ERROR_CODES } from "@blokjs/shared";`
> - **Python:** `from blok.errors import codes`
> - **Go:** `import "github.com/nickincloud/blok-go/errors/codes"`
> - **Rust:** `use blok::errors::codes;`
> - **Java:** `import com.blok.blok.errors.Codes;`
> - **C#:** `using Blok.Core.Errors.Codes;`
> - **Ruby:** `require "blok/errors/codes"`
> - **PHP:** `use Blok\Blok\Errors\Codes;`

(Per-SDK exports of the constants above are tracked as the §17
follow-up work in `docs/error-handling.md`.)

---

## How `BlokError` flows through the system

```
Node handler
    │  throw BlokError.dependency()...build()
    ▼
SDK runtime (gRPC servicer)
    │  serializes 19 fields into proto NodeError
    ▼
gRPC wire (HTTP/2 framing)
    │
    ▼
TS runner (GrpcRuntimeAdapter)
    │  decodes into BlokError instance
    │  (preserves: category, severity, code, http_status, retryable,
    │   retry_after_ms, description, remediation, doc_url, details,
    │   context_snapshot, causes, stack, at, node, sdk, sdk_version,
    │   runtime_kind, message)
    ▼
RunnerSteps (step prefix prepends `[step N/M] (runtime.X, grpc)`)
    │
    ▼
RunTracker.failNode(error)
    │  records the full structured error for /__blok/runs/:id
    ▼
Studio
    │  renders category pill, code, message, remediation, doc_url
    │  link, causes drawer, context snapshot tree
```

Every link in this chain is verified by the parity matrix at
`core/runner/__tests__/integration/parity/matrix.integration.test.ts`.

---

## Adding a new built-in code

1. Open a discussion (or PR with rationale) describing the failure
   mode and why it deserves a framework-level code rather than a
   user-defined `<DOMAIN>_<REASON>`.
2. Add a section to this file under "Built-in codes" with all four
   of: category, default `http_status`, retryable hint, and
   `details_json` shape.
3. Wire the constant into every SDK's `errors/codes` module so
   authors can import it instead of typing the string.
4. Add a row to the parity matrix's `error-paths.ts` battery
   asserting the code round-trips identically across all 7 SDKs.
5. Add an example to the demo node (`blok-error-demo` in every SDK)
   so the parity matrix exercises it in CI.

---

## Related references

- `proto/blok/runtime/v1/runtime.proto` — the wire contract.
- `core/shared/src/BlokError.ts` — the runner-side type.
- `docs/error-handling.md` — the migration cookbook for node
  authors moving from unstructured throws to typed BlokErrors.
- `core/runner/__tests__/integration/parity/matrix.integration.test.ts`
  — the cross-language parity proof.
- `sdks/<lang>/.../BlokError*` — each SDK's typed builder.
