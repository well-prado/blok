Confirmed: `run: async (payload, { ctx }) => {}` — payload positional, `{ ctx, init, signal }` as second arg. I have everything for the brief.

---

## What they do (with real code)

**Task definition** — a task is a plain object literal passed to `task()`. The `id` is a string identity; `run` is where logic lives. Everything else (retry/queue/machine/maxDuration/ttl) is a flat sibling key. Real signature from `core/src/v3/types/tasks.ts:309`: `run: (payload: TPayload, params: RunFnParams) => Promise<TOutput>`.

```ts
import { task } from "@trigger.dev/sdk/v3";

export const resizeImage = task({
  id: "resize-image",                       // unique, stable across versions
  retry: { maxAttempts: 5, factor: 1.8, minTimeoutInMs: 500, maxTimeoutInMs: 30_000 },
  queue: { concurrencyLimit: 10 },
  machine: "medium-1x",                      // string preset OR { preset, cpu, memory }
  maxDuration: 300,                          // compute-seconds; abort fires on overrun
  ttl: "10m",                                // drop from queue if not started in time
  run: async (payload: { url: string }, { ctx, signal }) => {
    const res = await fetch(payload.url, { signal });   // signal aborts on maxDuration/cancel
    return { width: 800, bytes: await res.arrayBuffer() }; // <-- return value IS the output
  },
});
```

**`schemaTask()`** — same shape, adds a `schema` (Zod/Yup/etc.) that parses+types the payload at the boundary. Payload type is *inferred* from the schema, not declared twice.

```ts
export const sendEmail = schemaTask({
  id: "send-email",
  schema: z.object({ to: z.string().email(), subject: z.string() }),
  run: async (payload) => {                  // payload typed from schema, validated before run
    return { messageId: await mailer.send(payload) };
  },
});
```

**Data flow between tasks = return values + typed handles. There is no graph.** A parent calls a child and `await`s it. Composition is ordinary control flow — `if`, loops, `Promise.all`:

```ts
export const onboard = task({
  id: "onboard",
  run: async (payload: { userId: string }) => {
    const user = await fetchUser.triggerAndWait({ id: payload.userId }).unwrap(); // throws on child failure → typed output
    const img = await resizeImage.triggerAndWait({ url: user.avatar }).unwrap();   // consumes prior output directly

    const results = await sendEmail.batchTriggerAndWait([                          // fan-out, typed array back
      { payload: { to: user.email, subject: "Welcome" } },
      { payload: { to: user.manager, subject: "New hire" } },
    ]);
    return { ok: results.runs.every((r) => r.ok), avatar: img.bytes.byteLength };
  },
});
```

`triggerAndWait()` returns a `TaskRunResult` discriminated union — `result.ok ? result.output : result.error`. `.unwrap()` collapses it to the bare typed output (throwing on failure) so the happy path reads like a normal function call. `trigger()` (no wait) returns a `RunHandle` for fire-and-forget. Cross-file typing uses `tasks.triggerAndWait<typeof myTask>(...)` — import the *type* only, keep tasks decoupled.

**Durable waits** (only inside `run`): `await wait.for({ seconds: 30 })`, `await wait.until({ date })`, and `wait.createToken()` / `wait.forToken<T>(token)` for human-in-the-loop / external callbacks. These suspend the run without burning compute.

**Idempotency & metadata** are runtime calls, not config: `idempotencyKeys.create("user-123")` then pass `{ idempotencyKey }` to any trigger; `metadata.set("progress", 0.5)` / `metadata.append(...)` / `metadata.increment(...)` mutate live run metadata streamed to the dashboard.

## Readability verdict

**Very high, with one tradeoff.** Strengths worth naming:

- **One mental model: a task is a function.** `id` + `run(payload) → output`. No DSL, no proxy strings, no `$.state.x`. Data flow is the JS you already know — `const x = await child(...)`, then use `x`. A reader needs zero framework vocabulary to trace it.
- **Config is flat, declarative, and co-located.** `retry`, `queue`, `machine`, `maxDuration`, `ttl` are plain sibling keys with obvious meaning — readable at a glance, no nesting ceremony.
- **Types flow end-to-end with no restatement.** `schemaTask` infers payload from the schema; child output types propagate through `.unwrap()`. The compiler is the wiring diagram.
- **`.unwrap()` is a genuinely nice ergonomic** — opt into "throw on failure, give me the value" so orchestration code stays linear, or handle `result.ok` explicitly when you care.

The tradeoff: **there is no graph and no layout file at all** — orchestration is imperative code, so "see the whole DAG at a glance" is something you reconstruct by reading, not something rendered. For Blok (which wants a visual canvas) that's the gap to bridge: keep their function-call clarity for *data flow*, but Blok still needs a static, declarative step list a canvas can render without executing code.

## Lessons for Blok authoring

1. **Kill `$.state.x` / `js/ctx...` strings. Make data flow look like variable use.** Trigger.dev's killer property is that consuming a prior step is just `const user = ...; user.email`. Blok's cleanest path: have a step expose its output as a typed binding the next step references *by name*, not by stringly-typed path. Even staying declarative, `inputs: { to: steps.fetch.user.email }` (real object refs) beats `"$.state.fetch.user.email"` (opaque string) on both readability and tooling.
2. **A step = `{ id, use, inputs, run }` with flat config siblings.** Adopt their flat knobs verbatim — `retry`, `queue`/`concurrency`, `machine`, `maxDuration`, `ttl` as top-level step keys reads beautifully and Blok already has the runtime semantics for all of them. The shape Blok lacks is the *flat, obvious* presentation.
3. **Make `id` the single source of identity** (Trigger.dev has exactly one `id`, no name/node split). Blok already did this in v2 — keep it; it's why their workflows are scannable.
4. **`.unwrap()`-style ergonomics for sub-workflows.** Blok's `subworkflow:` step with `wait: true` already lands the child result in `state[id]`. Offer the same "bare typed output vs. `{ ok, error }` envelope" choice so author code doesn't drown in error-handling boilerplate.
5. **Separate config from orchestration like they separate config from `run`.** The founder wants canvas/layout in a separate file. Trigger.dev validates the instinct: the *declarative metadata* (id, retry, queue, machine) is registered separately (`resourceCatalog.registerTaskMetadata`) from the executable `run`. Blok can mirror this — workflow file holds the declarative step list (canvas-renderable, layout-free), a sidecar `.layout.json` holds positions, and neither pollutes the other.
6. **Idempotency/metadata as in-`run` calls, not workflow config.** `metadata.set("progress", x)` mid-run is far cleaner than declaring it up front. Worth stealing for Blok's progress/observability surface.
7. **Don't lose Blok's edge: the static graph.** Trigger.dev *can't* render a DAG because orchestration is opaque imperative code. Blok's win is keeping steps declarative enough to render a canvas *while* making references look like Trigger.dev's variable use. That's the synthesis: n8n's renderable structure + Trigger.dev's code-grade data-flow clarity, minus the proxy strings.

## Sources

Local source read (no web):
- `packages/trigger-sdk/src/v3/shared.ts` — `createTask`/`createSchemaTask`, `trigger`/`triggerAndWait`/`batchTriggerAndWait`, `TaskRunPromise`/`.unwrap()`
- `packages/core/src/v3/types/tasks.ts:90,173-322` — `RunFnParams` (`{ ctx, init, signal }`), `CommonTaskOptions` (retry/queue/machine/maxDuration/ttl), `run: (payload, params) => Promise<TOutput>`
- `packages/trigger-sdk/src/v3/wait.ts:393-467` — `wait.for` / `wait.until` / `createToken`/`forToken`
- `packages/trigger-sdk/src/v3/idempotencyKeys.ts`, `metadata.ts` — runtime idempotency + metadata APIs