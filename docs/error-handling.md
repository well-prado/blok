# Error Handling — Node Author Cookbook

> **Status:** Closes master plan §17.12. The migration recipe and
> day-to-day patterns for emitting `BlokError` from your nodes
> across every Blok SDK.

This guide is for **node authors** — anyone writing code that runs
inside a Blok runtime. It covers when to throw a typed `BlokError`,
how to choose a category and code, and how to migrate legacy
unstructured throws (`raise ValueError(...)`,
`throw new Error(...)`) to the typed builder per master plan §17.

If you're looking for the **list** of stable codes, that's
[docs/error-codes.md](./error-codes.md). If you're looking for the
**proto wire shape**, that's
[`proto/blok/runtime/v1/runtime.proto`](https://github.com/deskree-inc/blok/blob/main/proto/blok/runtime/v1/runtime.proto).

---

## TL;DR — the 90-second rule

Replace this:

```python
# ❌ Legacy: unstructured throw
raise Exception("Postgres unreachable")
```

With this:

```python
# ✅ Typed BlokError
raise BlokError.dependency(
    code="POSTGRES_CONNECT_TIMEOUT",
    message="Could not connect to Postgres within 5s",
    description=f"Tried host={host} port={port}; timeout={dur}ms",
    remediation="Check DATABASE_URL env var and network reachability",
    cause=exc,
    retryable=True,
    retry_after_ms=5000,
)
```

The runner, Studio, OpenTelemetry, retry policies, and downstream
callers all behave better when errors carry structure. Auto-wrap
falls back gracefully if you don't migrate, but you lose:

- The right HTTP status (auto-wrap defaults to 500).
- A useful `retryable` hint (auto-wrap defaults to `false`).
- Stable downstream branching (callers can't `switch (err.code)`).
- Studio's category pill, severity badge, doc-url link.

---

## When to throw a `BlokError`

**Throw a typed `BlokError`** whenever the failure has any of:

- A specific HTTP status that's not 500 (e.g. 404 NotFound, 429 RateLimit).
- A retry policy that should diverge from the default (retryable, retry-after).
- Structured details a caller could branch on
  (`{validation_issues: [...]}`, `{remaining_quota: 0}`).
- A documentation page that explains the failure.

**Let it auto-wrap** when the failure is genuinely unexpected — a
panic, an assertion fault, a "this should never happen". The
auto-wrap layer per §17.7 will produce a structured error with
`category=INTERNAL`, `code=UNCAUGHT_<TYPE>`, and the message
preserved. Studio still shows everything; you just don't get the
extra structure that informed authoring would.

---

## Choosing a category

Pick from the 12 canonical categories (full table:
[docs/error-codes.md#categories](./error-codes.md#categories)):

| If the failure is… | Use |
|---|---|
| Bad input from the caller | `VALIDATION` |
| Bad config in the workflow / env | `CONFIGURATION` |
| External system down | `DEPENDENCY` |
| Took too long | `TIMEOUT` |
| Auth/authz check failed | `PERMISSION` |
| Quota/rate-limit hit | `RATE_LIMIT` |
| Resource not found | `NOT_FOUND` |
| Concurrency conflict / version mismatch | `CONFLICT` |
| Caller cancelled before completion | `CANCELLED` |
| Wire-format / framing problem | `PROTOCOL` |
| Schema OK but values unprocessable | `DATA` |
| None of the above | `INTERNAL` |

The category drives the default `http_status` and the default
`retryable` hint. If neither default fits, override per-error.

---

## Choosing a `code`

A `code` is a stable machine identifier callers can branch on. The
contract: same code means same root cause, forever.

**Reuse a built-in code** when one fits — see
[docs/error-codes.md#built-in-codes](./error-codes.md#built-in-codes).
Built-in codes get framework-level treatment in Studio, parity tests,
and OTEL labelling.

**Mint a new code** when nothing built-in fits. The convention:

- `<DOMAIN>_<REASON>` — all-caps, underscore-separated, alphanumeric.
- Examples: `STRIPE_API_DOWN`, `S3_OBJECT_NOT_FOUND`,
  `INVENTORY_OUT_OF_STOCK`, `PAYMENT_DECLINED_INSUFFICIENT_FUNDS`.
- Stable forever — never rename. To deprecate, mint a successor and
  document the relationship in a release note.
- Namespaced — never reuse a built-in code (anything in
  [docs/error-codes.md#built-in-codes](./error-codes.md#built-in-codes))
  for a user error.

---

## Per-SDK reference — the same idiomatic shape

The fluent builder API is consistent across all 7 SDKs. The only
language-specific bits are:

- Constructor style (kwargs vs builder).
- Cause-chain mechanism (`__cause__` vs `getCause()` vs
  `Error::source()`).
- HTTP status type (`int` vs `int32` vs `i32`).

### TypeScript (in-process module nodes)

```typescript
import { BlokError } from "@blokjs/shared";

throw BlokError.dependency({
  code: "POSTGRES_CONNECT_TIMEOUT",
  message: "Could not connect to Postgres within 5s",
  description: `Tried host=${host} port=${port}; timeout=${dur}ms`,
  remediation: "Check DATABASE_URL env var and network reachability",
  cause: err,
  retryable: true,
  retryAfterMs: 5000,
});
```

### Python

```python
from blok.errors.blok_error import BlokError

raise BlokError.dependency(
    code="POSTGRES_CONNECT_TIMEOUT",
    message="Could not connect to Postgres within 5s",
    description=f"Tried host={host} port={port}; timeout={dur}ms",
    remediation="Check DATABASE_URL env var and network reachability",
    cause=exc,
    retryable=True,
    retry_after_ms=5000,
)
```

### Go

```go
import blok "github.com/nickincloud/blok-go"

return nil, blok.NewError(blok.CategoryDependency).
    Code("POSTGRES_CONNECT_TIMEOUT").
    Message("Could not connect to Postgres within 5s").
    Description(fmt.Sprintf("Tried host=%s port=%d; timeout=%s", host, port, dur)).
    Remediation("Check DATABASE_URL env var and network reachability").
    Cause(err).
    Retryable(true).
    RetryAfter(5 * time.Second).
    Build()
```

### Rust

```rust
use blok::BlokError;
use std::time::Duration;

return Err(Box::new(
    BlokError::dependency()
        .code("POSTGRES_CONNECT_TIMEOUT")
        .message("Could not connect to Postgres within 5s")
        .description(format!("Tried host={host} port={port}; timeout={dur:?}"))
        .remediation("Check DATABASE_URL env var and network reachability")
        .cause(&err)
        .retryable(true)
        .retry_after(Duration::from_secs(5))
        .build()
));
```

### Java

```java
import com.blok.blok.errors.BlokError;
import java.time.Duration;

throw BlokError.dependency()
    .code("POSTGRES_CONNECT_TIMEOUT")
    .message("Could not connect to Postgres within 5s")
    .description(String.format("Tried host=%s port=%d; timeout=%dms", host, port, dur))
    .remediation("Check DATABASE_URL env var and network reachability")
    .cause(e)
    .retryable(true)
    .retryAfter(Duration.ofSeconds(5))
    .build();
```

### C#

```csharp
using Blok.Core.Errors;

throw BlokError.Dependency()
    .Code("POSTGRES_CONNECT_TIMEOUT")
    .Message("Could not connect to Postgres within 5s")
    .Description($"Tried host={host} port={port}; timeout={dur}ms")
    .Remediation("Check DATABASE_URL env var and network reachability")
    .Cause(ex)
    .Retryable(true)
    .RetryAfter(TimeSpan.FromSeconds(5))
    .Build();
```

### Ruby

```ruby
require "blok/errors/blok_error"

raise Blok::Errors::BlokError.dependency(
  code: "POSTGRES_CONNECT_TIMEOUT",
  message: "Could not connect to Postgres within 5s",
  description: "Tried host=#{host} port=#{port}; timeout=#{dur}ms",
  remediation: "Check DATABASE_URL env var and network reachability",
  cause: e,
  retryable: true,
  retry_after_ms: 5_000,
)
```

### PHP

```php
use Blok\Blok\Errors\BlokError;

throw BlokError::dependency()
    ->code('POSTGRES_CONNECT_TIMEOUT')
    ->message('Could not connect to Postgres within 5s')
    ->description("Tried host={$host} port={$port}; timeout={$dur}ms")
    ->remediation('Check DATABASE_URL env var and network reachability')
    ->cause($e)
    ->retryable(true)
    ->retryAfterMs(5000)
    ->build();
```

---

## Migration recipes

### Recipe 1 — Bare exception → typed dependency error

**Before:**

```python
def fetch_user(user_id: str):
    try:
        return db.execute("SELECT * FROM users WHERE id = $1", user_id)
    except ConnectionError as e:
        raise Exception(f"DB unreachable: {e}")
```

**After:**

```python
from blok.errors.blok_error import BlokError

def fetch_user(user_id: str):
    try:
        return db.execute("SELECT * FROM users WHERE id = $1", user_id)
    except ConnectionError as e:
        raise BlokError.dependency(
            code="POSTGRES_CONNECT_TIMEOUT",
            message=f"Could not reach Postgres while fetching user {user_id}",
            cause=e,
            retryable=True,
            retry_after_ms=2000,
            details={"user_id": user_id, "operation": "fetch_user"},
        )
```

What changed:
- Caller gets `category=DEPENDENCY` → 502 (not the generic 500).
- `retryable=True` hint tells the runner-level retry policy this
  is worth retrying.
- `retry_after_ms` carries a backoff hint.
- `cause=e` preserves the original `ConnectionError` for the
  trace stack.
- `details` pin the failing operation for the trace UI.

### Recipe 2 — Validation: turn `assert` / `raise ValueError` into structured issues

**Before:**

```typescript
function validate(input: unknown) {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid input");
  }
  // ... manual checks ...
}
```

**After:**

```typescript
import { BlokError } from "@blokjs/shared";
import { z } from "zod";

const InputSchema = z.object({ email: z.string().email(), name: z.string() });

function validate(input: unknown) {
  const result = InputSchema.safeParse(input);
  if (!result.success) {
    throw BlokError.validation({
      code: "VALIDATION_FAILED",
      message: `${result.error.issues.length} validation issues`,
      details: { issues: result.error.issues },
    });
  }
  return result.data;
}
```

What changed:
- `category=VALIDATION` → 400, `retryable=false` (caller has to fix).
- `details.issues` is a list the caller can render in their UI
  field-by-field.

### Recipe 3 — Rate-limit: surface backoff hints

**Before:**

```go
resp, err := github.Get("/repos/foo")
if err != nil { return nil, err }
if resp.StatusCode == 429 {
    return nil, fmt.Errorf("rate limited")
}
```

**After:**

```go
resp, err := github.Get("/repos/foo")
if err != nil {
    return nil, blok.NewError(blok.CategoryDependency).
        Code("GITHUB_API_DOWN").Message(err.Error()).Cause(err).Build()
}
if resp.StatusCode == 429 {
    resetAt := resp.Header.Get("X-RateLimit-Reset")
    backoff := computeBackoff(resetAt)
    return nil, blok.NewError(blok.CategoryRateLimit).
        Code("UPSTREAM_RATE_LIMITED").
        Message("GitHub API returned 429").
        RetryAfter(backoff).
        Details(map[string]interface{}{
            "limit":     resp.Header.Get("X-RateLimit-Limit"),
            "remaining": resp.Header.Get("X-RateLimit-Remaining"),
            "reset":     resetAt,
        }).
        Build()
}
```

The runner reads `retry_after_ms` and (optionally) sleeps before
re-dispatching the failed step. Without the structured form, the
runner has no idea this is a rate-limit error worth backing off on.

### Recipe 4 — Wrapping a third-party SDK exception

When you call into an SDK that throws its own typed exception, the
typical pattern is:

```python
try:
    s3.get_object(Bucket=bucket, Key=key)
except s3.exceptions.NoSuchKey as e:
    raise BlokError.not_found(
        code="S3_OBJECT_NOT_FOUND",
        message=f"Object not found in s3://{bucket}/{key}",
        cause=e,
        details={"bucket": bucket, "key": key},
    )
except s3.exceptions.ClientError as e:
    # Generic AWS error — let the auto-wrap fall through, OR
    # categorize manually if the error is recoverable.
    if e.response["Error"]["Code"] == "RequestTimeout":
        raise BlokError.timeout(
            code="S3_TIMEOUT",
            message="S3 request timed out",
            cause=e,
            retry_after_ms=1000,
        )
    raise  # let auto-wrap categorize as INTERNAL with UNCAUGHT_CLIENTERROR
```

The pattern: **catch what you can categorize; let the rest auto-wrap**.

---

## Caller-side: branching on a `BlokError`

When a workflow step is a TypeScript module node, you receive a
typed `BlokError` if the dispatched step throws one:

```typescript
import { BlokError } from "@blokjs/shared";

try {
  await step.process(ctx, step);
} catch (err) {
  if (err instanceof BlokError) {
    if (err.category === "RATE_LIMIT" && err.retryable) {
      await sleep(err.retryAfterMs);
      // ... retry ...
    } else if (err.category === "PERMISSION") {
      // ... auth flow ...
    }
  }
  throw err;
}
```

Workflow-level retry policies (Phase 6) will read these fields
automatically. Until then, manual retry loops can branch on them.

---

## What auto-wrap gives you (and why you still want the typed form)

When a node throws something that's NOT a typed `BlokError`, the
SDK's auto-wrap layer (per §17.7) produces:

```json
{
  "category": "INTERNAL",
  "code": "UNCAUGHT_<TYPE>",
  "message": "<original message>",
  "http_status": 500,
  "retryable": false,
  "stack": "<full native stack>",
  "causes": [/* preserved original exception */]
}
```

Where `<TYPE>` is the exception class's simple name uppercased
(`UNCAUGHT_CONNECTIONERROR`, `UNCAUGHT_IOEXCEPTION`,
`UNCAUGHT_RUNTIMEEXCEPTION`, etc. — varies per language).

This means **legacy code keeps working** — but you give up:

| Field | Auto-wrap default | Typed form |
|---|---|---|
| `category` | `INTERNAL` always | The right one |
| `http_status` | `500` always | `400`/`429`/`502`/etc. as appropriate |
| `retryable` | `false` always | `true` for `DEPENDENCY`/`TIMEOUT`/`RATE_LIMIT` |
| `code` | `UNCAUGHT_<TYPE>` (varies per language) | Stable, cross-SDK |
| `description` | empty | rich context |
| `remediation` | empty | actionable next step |
| `doc_url` | empty | direct link |
| `details` | varies (sometimes a `{message}` echo) | structured payload |
| `context_snapshot` | usually null | bounded inputs+vars at the failure |

Studio renders both, but the typed form has dramatically more
useful affordances (category pill, retryable badge, remediation
callout, doc-url link).

---

## Anti-patterns

### ❌ Don't catch `BlokError` and re-wrap it as `Exception`

```python
# DON'T do this
try:
    do_thing()
except BlokError as e:
    raise Exception(str(e))  # loses 19 fields of structure
```

### ❌ Don't use `INTERNAL` to "be safe"

```python
# DON'T do this — INTERNAL is for genuinely-unexpected failures
raise BlokError.internal(
    code="USER_NOT_FOUND",
    message="No user matched the supplied id",
)
```

If the failure has a clear category (`NOT_FOUND` here), use it.
Defaulting to `INTERNAL` short-circuits the runner-level retry
policy and the Studio category filter.

### ❌ Don't invent codes that overlap built-ins

```python
# DON'T do this — VALIDATION_FAILED is reserved for the framework
raise BlokError.validation(
    code="VALIDATION_FAILED",  # collides with the built-in
    message="…",
)
```

If the framework code fits, use it AS-IS. If you need different
semantics, mint a new code (`MY_DOMAIN_VALIDATION_FAILED`).

### ❌ Don't include secrets in `details` or `context_snapshot`

The error envelope flows through tracing, logging, and Studio. If
you put a session token or password into `details`, it becomes
visible in every place a trace is rendered. Filter sensitive
fields BEFORE attaching them:

```python
safe_input = {k: v for k, v in input.items() if k not in {"password", "token", "secret"}}
raise BlokError.validation(
    code="VALIDATION_FAILED",
    message="...",
    details={"input": safe_input},
)
```

---

## Lint rules (recommended, not yet enforced)

The plan calls for per-SDK lint rules warning on `throw new
Error(...)` inside `execute()`. These aren't shipped yet — they're
tracked as future §17.12 follow-up. In the meantime, code review
should flag:

- `throw new Error(...)` in TS module nodes / SDK runtime nodes.
- `raise Exception(...)` / `raise ValueError(...)` in Python nodes.
- `errors.New(...)` / `fmt.Errorf(...)` returns from Go nodes.
- `Err(io::Error::new(...))` / bare `?` propagation in Rust nodes.
- `throw new RuntimeException(...)` in Java/C# nodes.
- `raise StandardError, ...` in Ruby nodes.
- `throw new \Exception(...)` in PHP nodes.

All of these auto-wrap to `INTERNAL` per §17.7 and are correct in
the sense that "the trace will show something" — but as covered
above, they sacrifice categorization and retry hints. A typed
builder is almost always the better choice in node code.

---

## Related references

- [docs/error-codes.md](./error-codes.md) — the registry of stable codes.
- [proto/blok/runtime/v1/runtime.proto](https://github.com/deskree-inc/blok/blob/main/proto/blok/runtime/v1/runtime.proto)
  — wire contract.
- `core/runner/__tests__/integration/parity/matrix.integration.test.ts`
  — the cross-language proof every SDK ships the same shape.
- `core/runner/__tests__/integration/parity/byte-identical.integration.test.ts`
  — §17.13 byte-equal proof.
- `sdks/<lang>/.../BlokErrorDemoNode.<ext>` — runnable example for
  every category.
