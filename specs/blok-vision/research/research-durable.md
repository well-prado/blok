I have everything needed. Writing the brief.

---

# Brief: Inngest & Temporal — DX and durable-execution lessons for Blok

## How they do it (concrete)

**Inngest — durable execution via step memoization, no determinism rules.**
- A function is plain `async`/`await` code. Side-effecting work is wrapped in `step.run("id", async () => {...})`. Each step has a string **id**, is independently retried on throw, and on success its return value is persisted to a state store and never re-runs ([inngest-steps](https://www.inngest.com/docs/learn/inngest-steps)).
- Execution model: the function **re-invokes from the top** on each step boundary. Already-completed steps are skipped — the SDK looks them up by hashed id+index and **injects the stored result** instead of re-running. Execution proceeds until it hits the first un-completed step, runs it, persists, halts ([how-functions-are-executed](https://www.inngest.com/docs/learn/how-functions-are-executed)).
- Other primitives are all "just await a method": `step.sleep("id","2d")` (sleeps without burning compute), `step.sleepUntil`, `step.waitForEvent("id",{event,timeout})` (pause until a matching event), `step.waitForSignal`, `step.invoke({function, data})` (call another function), `step.sendEvent` ([steps-workflows](https://www.inngest.com/docs/features/inngest-functions/steps-workflows)).
- **Branching/looping use native language control flow** — `if/else`, `for`, `Promise.all` over steps — because there is no determinism sandbox. The only rule: anything non-deterministic or side-effecting must live *inside* a step, and code *outside* steps re-runs on every invocation ([how-functions-are-executed](https://www.inngest.com/docs/learn/how-functions-are-executed)).
- **Local DX:** one command `npx inngest-cli@latest dev` starts the Dev Server at `localhost:8288`. It auto-discovers apps on common ports / `/api/inngest`, needs no Redis or separate workers, and gives production-parity execution. UI at `/runs` shows an **OpenTelemetry-style waterfall trace** per run with each step timed and inspectable; you can **Invoke** a function with a payload modal, send/replay test events, and it exposes an **MCP endpoint** (`/mcp`) so Claude Code/Cursor can drive and debug functions ([local-development](https://www.inngest.com/docs/local-development), [enhanced-observability](https://www.inngest.com/blog/enhanced-observability-traces-and-metrics)).

**Temporal — durable execution via deterministic replay of an event history.**
- Code is split into **Workflows** (deterministic orchestration) and **Activities** (arbitrary side-effecting I/O). You write the happy path; Temporal applies declarative retry policies and recovery ([durable-execution tutorial](https://learn.temporal.io/tutorials/go/background-check/durable-execution/)).
- Recovery is **full replay**: every run is a durable **Event History** log (WorkflowStarted, ActivityScheduled/Completed, TimerFired…). On worker restart the workflow code re-runs from the top; already-completed activities are *not* re-executed — their recorded results are resolved from history ([event-history](https://docs.temporal.io/encyclopedia/event-history)).
- This forces **strict determinism in workflow code**: same API calls, same order, same input. `random()`, clocks, threading, direct I/O in a workflow cause a `DeterminismViolationError`. SDKs ship a **sandbox** to catch this, but it's explicitly best-effort, not foolproof ([python-sdk-sandbox](https://docs.temporal.io/develop/python/python-sdk-sandbox), [workflow-definition](https://docs.temporal.io/workflow-definition)).
- **Local DX:** `temporal server start-dev` (formerly temporalite) — single process, server on `:7233`, **Web UI on `:8233`**, ships with every CLI release. UI shows workflow state, args, return values, and clickable event-history entries for debugging ([web-ui](https://docs.temporal.io/web-ui)).
- **Replay debugging is a first-class workflow:** download a run's history as JSON (CLI/UI), feed it to `worker.runReplayHistory`, and a **VS Code extension** lets you set breakpoints and step through the replay. Replaying a new code version against old history is how you detect breaking (non-deterministic) changes before deploy ([VS Code extension](https://dev.to/temporalio/temporal-for-vs-code-4lcb), [replay testing](https://www.bitovi.com/blog/replay-testing-to-avoid-non-determinism-in-temporal-workflows)).

## Patterns worth stealing for Blok

1. **Branch/loop in the host language, not in a bespoke DSL.** Inngest's biggest ergonomic win is that `if/else`, `for`, and `Promise.all` are *just code*. Blok's `branch({when, then, else})` / `switch` primitives and the `$.`/`js/` expression strings are a parallel mini-language authors must learn — and per the memory note, `branch.when` must be raw `ctx.*` and silently 500s otherwise. Inngest has no such footgun because there's no separate condition grammar.
2. **Stable string step ids are the durability key — Blok already has this.** Both Inngest (`step.run("id")`) and Temporal (activity identity in history) key memoization/replay on step identity. Blok's `id` → `ctx.state[id]` is the same idea; lean into it as *the* mental model and document the "id is the cache key" invariant the way Inngest does.
3. **Waterfall trace UI inspired by OTel.** Both ship a per-run waterfall where every step is timed and clickable, separating **queue/wait time from execution time**. Blok Studio's run detail should adopt the waterfall layout and explicitly surface wait-vs-run, retries-per-attempt, and the persisted `ctx.state[id]` payload inline.
4. **One-command local server with production parity + auto-discovery.** `inngest-cli dev` / `temporal server start-dev` give a zero-config local UI. `blokctl dev` already does this; the lesson is the **trace UI is part of the same binary** and apps are auto-discovered — no separate setup.
5. **Invoke / replay-from-UI as a debugging loop.** Inngest's "Invoke with payload modal" + event replay, and Temporal's "download history → replay with breakpoints," both close the edit-debug loop without re-triggering production. Blok Studio should let you **re-run a workflow (or a single step) from a recorded run's inputs**.
6. **MCP endpoint on the dev server.** Inngest exposes `/mcp` so an AI agent can list runs, read traces, and invoke functions. This is directly on-vision for Blok's AI-native goal — Studio should expose an MCP surface over runs/traces/invoke.
7. **`waitForEvent` / `sleep` as durable, compute-free primitives.** Inngest's pause-on-event and long sleeps are cleaner than building this from triggers + concurrency keys. Blok's delay/ttl/debounce trigger knobs cover scheduling, but a **mid-workflow `waitForEvent`/`sleep` step** would be a strong addition.

## Pitfalls / criticisms to avoid

- **Temporal's determinism tax.** Splitting code into deterministic workflows vs. activities, plus a leaky sandbox and `DeterminismViolationError`s on innocuous changes, is the single most-cited Temporal complaint and the thing Inngest markets against ("plain async/await, no determinism constraints"; "hours to days" vs "minutes" to first run) ([compare-to-temporal](https://www.inngest.com/compare-to-temporal)). **Blok's runner already resolves expressions before node execution and persists on success — do NOT adopt a replay-determinism model.** Blok's "every step output is persisted, steps don't re-run" is closer to Inngest and is the right side of this trade-off.
- **"Code outside a step re-runs every invocation."** Inngest's replay-from-top model means un-stepped code silently re-executes — a real gotcha. Blok avoids this because nodes are discrete units, but the equivalent trap is **input expressions with side effects**; keep mapper expressions pure (the docs already warn against `js/` double-eval on `@blokjs/expr`).
- **Step explosion + state-size limits.** Inngest caps **1000 steps/function, 32MB run state, 4MB/step return**; a `step` per loop item blows the limit, so they tell you to loop *inside* one step or fan out ([usage-limits](https://www.inngest.com/docs/usage-limits/inngest)). Blok's `forEach`/sub-workflow patterns should document the same guidance and watch `ctx.state` growth — auto-persisting every step output is convenient but unbounded.
- **Inter-step durability latency.** Persisting state between steps adds latency; Inngest had to add "checkpointing" for near-zero inter-step latency ([introducing-checkpointing](https://www.inngest.com/blog/introducing-checkpointing)). Blok's synchronous SQLite persistence per step has the same cost — keep an `ephemeral`/batching escape hatch (Blok already has `ephemeral: true`).
- **Temporal's worker fleet.** Even on Temporal Cloud you run your own workers — heavy infra. Inngest's "call your existing HTTP endpoints" is lighter. Blok's runtime-container model sits between; don't push users toward a separate worker fleet for the common case.

## Specific lessons for the Blok vision

- **Authoring ergonomics (if-else/switch/branch):** Inngest proves that *native control flow beats a condition DSL*. Two concrete moves for Blok: (a) make the visual canvas the primary place to express branching (n8n-style), and **compile canvas branches down to the existing `branch`/`switch` primitives** so the string-condition grammar becomes an implementation detail authors rarely hand-write; (b) if hand-authoring stays, the `eq/ne/gt`… helpers (already shipped per memory) are the correct fix — push authors to those and away from raw `when` strings. Evaluating whether `.ts` is the right format (vision item 8): Inngest's answer is "it's just functions in your language" — the durability is in the *runtime*, not the file format. That argues Blok's value is the **runtime + Studio**, and the definition format can be TS *or* JSON *or* canvas-generated, all compiling to the same normalized v2 shape Blok already has.
- **Studio debugging:** adopt the **OTel waterfall** (queue-vs-exec split, per-attempt retry rows, inline persisted `ctx.state[id]` and step inputs), plus **re-run-from-recorded-inputs** at both run and single-step granularity, and an **MCP surface** over runs/traces/invoke for AI-native debugging. These are table-stakes that both Inngest and Temporal ship and that map cleanly onto Blok's existing run/trace records.
- **Durable primitives to consider adding:** mid-workflow `sleep`/`waitForEvent` steps (compute-free pause/resume), since Blok already has the trigger-side scheduling machinery (delay/ttl/debounce, DeferredRunScheduler) to build them on.

**Uncertainty flags:** Inngest's exact branching/parallel code samples were not on the doc pages fetched (the multi-step guide redirected); the `Promise.all`/`if-else` claims are inferred from the consistent "plain async/await, no determinism constraints" framing across [steps](https://www.inngest.com/docs/learn/inngest-steps), [how-functions-are-executed](https://www.inngest.com/docs/learn/how-functions-are-executed), and [compare-to-temporal](https://www.inngest.com/compare-to-temporal) — high confidence but I did not see a literal `Promise.all(step.run(...))` snippet. The "40% fewer lines" / "minutes vs hours" figures come from Inngest's own competitive marketing page and should be treated as vendor claims, not independent benchmarks. Temporalite is archived/renamed to `temporal server start-dev`; the local-UI behavior is current but the binary name in older docs differs.

## Sources (URLs)

- https://www.inngest.com/docs/learn/inngest-steps
- https://www.inngest.com/docs/learn/how-functions-are-executed
- https://www.inngest.com/docs/features/inngest-functions/steps-workflows
- https://www.inngest.com/docs/local-development
- https://www.inngest.com/blog/enhanced-observability-traces-and-metrics
- https://www.inngest.com/docs/usage-limits/inngest
- https://www.inngest.com/blog/introducing-checkpointing
- https://www.inngest.com/compare-to-temporal
- https://docs.temporal.io/web-ui
- https://docs.temporal.io/encyclopedia/event-history
- https://docs.temporal.io/workflow-definition
- https://docs.temporal.io/develop/python/python-sdk-sandbox
- https://learn.temporal.io/tutorials/go/background-check/durable-execution/
- https://dev.to/temporalio/temporal-for-vs-code-4lcb
- https://www.bitovi.com/blog/replay-testing-to-avoid-non-determinism-in-temporal-workflows
- https://github.com/temporalio/temporalite-archived