I have everything. Writing the brief.

---

## What they do (with real code)

Trigger.dev's thesis: **a workflow is a plain async function, not a graph.** There is no DSL, no expression strings, no `$.state.x`. Every task is an exported `task({...})` object whose `run` is ordinary TypeScript. Data flows the way every JS dev already understands it — variables and return values.

**1. A task is an options object + a `run` function.** All operational concerns are *declarative siblings* of `run` (retry, queue, machine, ttl, maxDuration, lifecycle hooks); the *logic* is imperative inside `run`:

```ts
import { task } from "@trigger.dev/sdk";

export const comprehensiveTask = task({
  id: "comprehensive-task",
  retry: { maxAttempts: 10, factor: 1.8, minTimeoutInMs: 500, maxTimeoutInMs: 30_000 },
  machine: { preset: "large-1x" },
  maxDuration: 300,          // seconds
  queue: { concurrencyLimit: 1 },
  ttl: "10m",
  onSuccess: async ({ payload, output, ctx }) => { /* ... */ },
  onFailure: async ({ payload, error, ctx }) => { /* ... */ },
  run: async (payload, { ctx }) => {
    return { result: "success" };
  },
});
```

The full `CommonTaskOptions` surface (from `core/src/v3/types/tasks.ts`): `id`, `run`, `retry`, `queue`, `machine`, `maxDuration`, `ttl`, plus lifecycle hooks `init`/`cleanup`/`onStart`/`onStartAttempt`/`onSuccess`/`onFailure`/`catchError`/`onCancel`/`middleware`. Every knob is a key on one flat object — readable top-to-bottom, no builder chain.

**2. Typed, validated payloads via `schemaTask` + Zod.** This is their answer to "what shape is the input?" — the schema *is* the contract, validated at trigger time before the run executes:

```ts
import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

export const myTask = schemaTask({
  id: "my-task",
  schema: z.object({ name: z.string(), age: z.number() }),
  run: async (payload) => {            // payload is fully typed from the schema
    console.log(payload.name, payload.age);
  },
});
```

Bad payload → task fails with `TaskPayloadParsedError`, skips retries, never runs. Zod's "schema-in / schema-out" inference means `coerce`/`default` give the trigger caller a looser type than the `run` body sees. Validators are pluggable (Zod, Valibot, Yup, ArkType, etc.).

**3. Orchestration = calling functions and reading return values.** Composition reads like normal code because it *is* normal code. No graph, no edges:

```ts
export const parentTask = task({
  id: "parent-task",
  run: async (payload: string) => {
    const result = await childTask.triggerAndWait("some-data");
    if (result.ok) console.log(result.output);
    else console.error(result.error);

    // or unwrap to a value/throw:
    const output = await childTask.triggerAndWait("x").unwrap();

    // fan-out:
    const results = await childTask.batchTriggerAndWait([
      { payload: "a" }, { payload: "b" },
    ]);
  },
});
```

The result is a discriminated union (`result.ok`), or `.unwrap()` to collapse to value-or-throw (`SubtaskUnwrapError` carries `runId`/`taskId`/`cause`). Heterogeneous fan-out uses `batch.triggerAndWait<typeof a | typeof b>([...])` with `result.taskIdentifier` to switch — still fully typed.

**4. Scheduling is just another task variant** — cron lives in the options object, not a separate trigger file:

```ts
export const firstScheduledTask = schedules.task({
  id: "first-scheduled-task",
  cron: { pattern: "0 5 * * *", timezone: "Asia/Tokyo", environments: ["PRODUCTION"] },
  run: async (payload) => { /* ... */ },
});
```

**5. Versioning & deploy are out-of-band — zero version metadata in code.** No `version: "1.0.0"` field anywhere. `npx trigger.dev deploy` creates an immutable, date-stamped version (`20240313.1`). In-flight runs stay locked to the version they started on; new runs take the latest; `triggerAndWait` children lock to the parent's version (deterministic), bare `trigger()` children float to latest. The author never writes or bumps a version.

**6. Local dev + inspector.** `npx trigger.dev dev` runs each task in a **separate Node process** with hot reload; the terminal prints each run plus a deep link into the dashboard for full traces/spans. Same trace UI locally and in prod.

## Readability verdict

**A newcomer who knows TypeScript can read a Trigger.dev task with zero framework onboarding.** The win is that there is *nothing to decode*: data flow is `const x = await foo()`, branching is `if`, fan-out is `await Promise`-shaped batch calls. No proxy syntax, no `js/ctx...` strings, no mental model of a `state` bag keyed by step id. The options object reads like a config sheet (retry here, machine there, schedule there), cleanly separated from the imperative `run` body. Typed payloads mean the editor tells you the shape — you don't grep upstream steps to learn what's in scope.

**The trade-off is real and singular: there is no visual graph, and non-coders cannot author or read these workflows.** n8n's value is that a domain expert (ops, marketing) can *see* and *edit* the flow on a canvas. Trigger.dev gives that up entirely — readability is for *developers only*. There's also no at-a-glance topology: to know which tasks a parent fans out to, you read the code (though traces reconstruct the actual DAG at runtime). For Blok, whose pitch includes a visual Studio for non-coders, this is the line you cannot simply copy — Trigger.dev's model is the "code-first" pole, n8n is the "visual" pole.

## Lessons for Blok authoring

Concrete, liftable patterns that fix the founder's three complaints (`$.state.x`, `js/ctx...`, canvas-in-workflow):

1. **Kill `$.state`/`js/ctx` by making step outputs real bindings, not a string-keyed bag.** Trigger.dev's `const r = await childTask.triggerAndWait(...)` is the model: a step's output should be a *value you name*, referenced by that name, type-checked. Blok's `$.state.fetch` exists only because steps are config records the runner stitches at runtime. A code-first Blok layer where `const fetched = await apiCall({ url })` returns a typed value eliminates the proxy entirely. (Keep the JSON/declarative form for the visual editor — but generate it from, or compile it to, this.)

2. **Adopt the flat declarative-options object for operational knobs.** Blok already has the right knobs (`retry`, `idempotencyKey`, `maxDuration`, `concurrencyKey`, `ephemeral`) — Trigger.dev's lesson is to keep them as plain sibling keys on one object next to the logic, never as expression strings. Blok's per-step knobs are already close; the gap is the *logic/data-flow* layer, not the options layer.

3. **`schemaTask` is exactly the right node-input contract.** Blok nodes already use `defineNode({ input: z.object(...) })`. Extend the same Zod-in/Zod-out validation to *workflow trigger payloads* and to *step inputs at author time*, so a typo'd field is a compile error, not a runtime `MapperResolutionError`. This is the single biggest readability+safety win and it's nearly free given Blok's existing Zod usage.

4. **Move versioning out of the workflow file.** Blok requires `version: "1.0.0"` in every workflow. Trigger.dev proves authors should never hand-write versions — deploy assigns an immutable stamp. This directly supports the founder's "clean file" goal: drop the field, let the toolchain version.

5. **Separate canvas/layout into a sidecar file (this is the founder's explicit ask, and Trigger.dev validates it by having *no* layout in code at all).** The runtime artifact (logic + options) should be 100% layout-free. Store node positions/edges in a `*.layout.json` next to the workflow, owned by Studio, ignored by the runner. Trigger.dev reconstructs topology from *traces* at runtime rather than persisting a graph — Blok can do the same and treat canvas purely as an editor convenience.

6. **The strategic synthesis for Blok: be bi-directional, not one-pole.** Trigger.dev = readable for coders, invisible to non-coders. n8n = visible to non-coders, opaque/locked-in for coders. Blok's differentiator is a **clean code-first authoring model (Trigger.dev-grade) that compiles to/from the declarative JSON the visual Studio edits.** The code form gives developers the `await`/return-value readability; the JSON+sidecar-layout gives non-coders the canvas; neither contains `$.state` or `js/ctx`. The expression-string syntax was only ever the seam between them — replace it with typed bindings and that seam disappears.

## Sources

- [schemaTask — Trigger.dev](https://trigger.dev/docs/tasks/schemaTask)
- [Tasks overview — Trigger.dev](https://trigger.dev/docs/tasks/overview)
- [Triggering (triggerAndWait / batch / unwrap) — Trigger.dev](https://trigger.dev/docs/triggering)
- [Scheduled tasks — Trigger.dev](https://trigger.dev/docs/tasks/scheduled)
- [CLI dev / local run inspector — Trigger.dev](https://trigger.dev/docs/cli-dev)
- [Versioning — Trigger.dev](https://trigger.dev/docs/versioning)
- Local source read: `research-repos/trigger.dev/packages/trigger-sdk/src/v3/tasks.ts`, `core/src/v3/types/tasks.ts` (CommonTaskOptions / TaskWithSchemaOptions definitions)