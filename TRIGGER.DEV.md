Below is a “single‑source” document that explains how **workflows** (i.e. tasks + runs + orchestration) work in Trigger.dev, based directly on the official docs you have in the repo.

You can treat this as an internal reference or adapt it into your own docs.

---

# Trigger.dev Workflows – Deep Architecture & Lifecycle Guide

> In Trigger.dev v3/v4, what you would intuitively call a *workflow* is modeled as a composition of **tasks** and **runs**:
> - A **task** is the unit of logic you define (code + configuration).
> - A **run** is a single execution instance of that task.
> - Complex workflows are built by chaining tasks, subtasks, waits, and retries together.

This guide explains:

1. Core concepts (projects, tasks, runs)
2. How you **define** workflow logic (tasks)
3. How you **trigger** workflows
4. The **run lifecycle** (states, retries, TTL, etc.)
5. The **Checkpoint–Resume System** and durable execution
6. Idempotency and subtask orchestration
7. How this surfaces in the UI and the SDK

---

## 1. Core Concepts

### 1.1 Projects and Environments

- A **Project** is the top‑level unit in Trigger.dev where your tasks live.
- Each project has one or more **environments**:
 - `dev` (via `npx trigger.dev dev`)
 - `staging`
 - `prod`
- You deploy tasks into environments with the CLI:

```sh
npx trigger.dev@latest login
npx trigger.dev@latest init
npx trigger.dev@latest dev     # local dev mode
npx trigger.dev@latest deploy # deploy to staging/prod
```

Each environment has its own API keys and runs independently.

### 1.2 Tasks

Tasks are the **building blocks** of workflows:

- Defined with `task({ id, run, ...options })` from `@trigger.dev/sdk`.
- They live in your `/trigger` folder (so the builder can find them).
- They can:
 - Run arbitrary TypeScript/Node.js code
 - Call external APIs (OpenAI, S3, etc.)
 - Use waits (`wait.for`, `wait.until`) to pause without consuming compute
 - Trigger other tasks and wait for their results

Example (from `how-it-works.mdx`):

```ts
// /trigger/video.ts
import { logger, task } from "@trigger.dev/sdk";
// ...imports omitted

export const convertVideo = task({
 id: "convert-video",
 retry: {
    maxAttempts: 5,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
    factor: 2,
 },
 run: async ({ videoId }: { videoId: string }) => {
    // 1) Load video from DB + storage
    // 2) Process via ffmpeg
    // 3) Upload to S3
    // 4) Update DB
    // 5) Send email
    // 6) Return result
 },
});
```

This is one logical *workflow* for “video processing”.

### 1.3 Runs

Every time you trigger a task, you get a **run**:

- A run has:
 - A unique `runId`
 - The **task identifier** (e.g. `"convert-video"`)
 - Payload (input)
 - Status (Pending, Queued, Executing, Completed, Failed, etc.)
 - Metadata: timing, attempts, logs, etc.

From `runs.mdx`:

> “A run is created when you trigger a task (e.g. calling `yourTask.trigger({ foo: "bar" })`). It represents a single instance of a task being executed…”

Runs are how workflows show up in the dashboard and SDK.

---

## 2. Defining Workflows as Tasks

### 2.1 Regular Tasks

From `tasks-regular.mdx`:

> “Regular tasks are the simplest type of task which can be triggered from elsewhere in your code.”

They are defined via `task()` and typically:

- Take a well‑typed `payload` argument.
- Return structured output (also strongly typed).
- May apply `retry`, `queue`, `ttl`, etc.

Example: email sequence workflow (simplified):

```ts
// /trigger/email-sequence.ts
import { task, retry, wait } from "@trigger.dev/sdk";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_ASP_KEY);

export const emailSequence = task({
 id: "email-sequence",
 run: async (payload: { userId: string; email: string; name: string }) => {
    // 1) Send initial email (with retry.onThrow)
    // 2) wait.for({ days: 3 })
    // 3) Send follow‑up email
 },
});
```

This is a clear example of a *multi‑step workflow* encoded as a single task with waits.

### 2.2 Multi‑task Workflows (Parent–Child)

You can break workflows into multiple tasks to get:

- Better durability (subtasks can be retried independently)
- Clearer traces and metrics
- Reusable components

Pattern:

- Parent task uses `childTask.triggerAndWait(...)` to orchestrate steps.
- Each child is an independent task with its own retry/queue config.

From `how-it-works.mdx`, durable video workflow:

```ts
import { idempotencyKeys, logger, task } from "@trigger.dev/sdk";
import { processVideo, sendUserEmail, uploadToS3 } from "./tasks.js";

export const convertVideo = task({
 id: "convert-video",
 retry: { maxAttempts: 5, minTimeoutInMs: 1000, maxTimeoutInMs: 10000, factor: 2 },
 run: async ({ videoId }: { videoId: string }) => {
    const idempotencyKey = await idempotencyKeys.create(videoId);

    const { processedContent } = await processVideo
      .triggerAndWait({ videoId }, { idempotencyKey })
      .unwrap();

    const { s3Url } = await uploadToS3
      .triggerAndWait({ processedContent, videoId }, { idempotencyKey })
      .unwrap();

    await sendUserEmail.trigger({ videoId, s3Url }, { idempotencyKey });

    return { success: true, s3Url };
 },
});
```

Here, the *workflow* is “convert video and notify user”, implemented as:

- `convertVideo` (parent) orchestrating:
 - `processVideo` subtask
 - `uploadToS3` subtask
 - `sendUserEmail` subtask

---

## 3. Triggering Workflows

From `triggering.mdx`, there are two main perspectives:

1. **From outside tasks** – typically your app/backend.
2. **From inside tasks** – composing workflows from smaller pieces.

### 3.1 From your backend (`tasks.trigger`)

Use `tasks.trigger()` (and friends) to start workflows from your backend:

```ts
// app route / handler
import { tasks } from "@trigger.dev/sdk";
import type { convertVideo } from "./trigger/video";

export async function POST(request: Request) {
 const body = await request.json();

 // Start workflow, don’t wait for completion
 const handle = await tasks.trigger<typeof convertVideo>("convert-video", body);

 return Response.json(handle); // contains run handle/ID
}
```

Key functions:

- `tasks.trigger()` – single run of one task.
- `tasks.batchTrigger()` – many runs of one task.
- `batch.trigger()` – runs of multiple different tasks.

### 3.2 From inside a task (`yourTask.trigger*` and `triggerAndWait`)

From `triggering.mdx`:

- `yourTask.trigger()` – fire‑and‑forget subtask.
- `yourTask.triggerAndWait()` – trigger child and **wait** for result; parent will be checkpointed & resumed.
- `yourTask.batchTrigger()` / `yourTask.batchTriggerAndWait()` – fan‑out/fan‑in workflows.

Example:

```ts
export const parentTask = task({
 id: "parent-task",
 run: async (payload: string) => {
    const result = await childTask.triggerAndWait("some-data").unwrap();
    // use child result to continue workflow
 },
});
```

`triggerAndWait()` is one of the main building blocks for multi‑step workflows.

### 3.3 Trigger options (how you shape run behavior)

All trigger functions accept options (per `triggering.mdx`):

- `delay`: schedule for later (e.g. `"1h"`, `"2024-12-01T00:00:00"`)
- `ttl`: time‑to‑live; expire if run doesn’t start by then
- `idempotencyKey` / `idempotencyKeyTTL`
- `debounce`: collapse multiple triggers into one delayed run
- `queue`, `concurrencyKey`: control concurrency across runs (per queue and per key)
- `maxAttempts`: per‑run retry override
- `tags`, `metadata`
- `maxDuration`, `priority`, `region`, `machine`

These knobs let you “shape” the workflow’s operational behavior without changing core logic.

---

## 4. Run Lifecycle (How workflows actually execute)

From `runs.mdx`, a run goes through **states** and **attempts**.

### 4.1 Run states

Typical simple path:

1. **Pending version** – waiting for a valid deployed task version.
2. **Delayed** – scheduled for future time (via `delay`).
3. **Queued** – ready to run, in the queue.
4. **Dequeued** – being handed to a worker.
5. **Executing** – task code running.
6. **Waiting** – paused via `triggerAndWait`, `batchTriggerAndWait`, or `wait.*`.
7. **Final states**:
 - Completed
 - Canceled
 - Failed
 - Timed out
 - Crashed
 - System failure
 - Expired (TTL hit before start)

The dashboard visualizes these and the docs reference them with icons.

### 4.2 Attempts

Each run can have multiple **attempts**:

- On failure, retry rules decide if/when another attempt is made.
- Attempts track:
 - Attempt ID
 - Status
 - Output or error
- When all attempts are done:
 - If last attempt succeeded → run is **Completed**
 - If retries exhausted → run is **Failed**

This is where `retry` options on tasks and per‑trigger `maxAttempts` come into play.

### 4.3 TTL, delay, replay

- **TTL**:
 - Can be set globally (config), per task, or per trigger.
 - Run becomes **Expired** if not started before TTL.
- **Delay**:
 - Start the run later (`{ delay: "1h" }`).
 - Useful for scheduled or deferred workflows.
- **Replay**:
 - `runs.replay(runId)` re‑triggers a run with the same payload but **latest task code version**.
 - Great for debugging, data reprocessing, or backfills.

### 4.4 Runs API & realtime

From `runs.mdx`:

- `runs.list()` – list/filter runs (status, taskIdentifier, time range, tags, batch, schedule, version).
- `runs.retrieve()` – fetch one run; can be typed with task type.
- `runs.cancel()` – cancel a run.
- `runs.replay()` – replay.
- `runs.reschedule()` – change `delay` on delayed runs.
- `runs.subscribeToRun()` – async iterator for realtime run updates.

This API is how external systems or dashboards integrate with the workflow system programmatically.

---

## 5. Checkpoint–Resume & Durable Workflows

From `how-it-works.mdx`:

Trigger.dev uses a **Checkpoint–Resume System** that allows tasks (workflows) to:

- Run for an effectively unbounded amount of time.
- Pause without consuming CPU/RAM.
- Resume exactly where they left off.

### 5.1 High‑level process

1. Task starts in an isolated worker.
2. It hits a “wait point”:
 - `wait.for`, `wait.until`, etc.
 - `triggerAndWait`/`batchTriggerAndWait` for a subtask.
3. The runtime uses CRIU (Checkpoint/Restore In Userspace) to:
 - Snapshot memory, CPU registers, open file descriptors.
 - Compress snapshot and store it (persistent storage).
4. The task’s container/process is torn down → resources freed.
5. When the wait completes or subtask finishes:
 - Snapshot is restored into a new worker.
 - Execution resumes from the next line after the wait.

This is the key to **durable, serverless‑like** workflows without timeout issues.

### 5.2 Durable execution + idempotency

The “Durable execution” section shows how you break a workflow into subtasks and assign **idempotency keys**:

- Each subtask is given a key (often using `idempotencyKeys.create(run-scoped-key)`).
- Results of each subtask are **cached** against that key.
- On retry:
 - Already‑completed subtasks return cached results.
 - Only failed/remaining parts are rerun.

This gives you:

- Strong guarantees around exactly‑once or at‑most‑once semantics for substeps.
- Much faster retries (no repeated heavy operations if they already succeeded).

---

## 6. Trigger Patterns Inside Workflows

Workflows often chain tasks together. From `triggering.mdx`:

- **Single child**:
 - `childTask.triggerAndWait(payload)` – parent pauses until child finishes.
- **Fan‑out / fan‑in**:
 - `childTask.batchTriggerAndWait([{ payload }, ...])` – run many children in parallel, then aggregate.
 - `batch.triggerAndWait([...])` – multiple different tasks.

These are the patterns for building:

- Pipelines (ETL)
- Multi‑step AI workflows
- Multi‑email sequences
- Complex back‑office processes

---

## 7. Operational Controls: Concurrency, Queues, Debounce

Workflows don’t just exist logically; they must behave correctly under load.

From `triggering.mdx` and `queue-concurrency.mdx`:

### 7.1 Queues and concurrency

- Each task can define a default queue and `concurrencyLimit`.
- Per‑trigger, you can override:

```ts
await generatePullRequest.trigger(data, {
 queue: { name: "main-branch", concurrencyLimit: 10 },
});
```

Or use `concurrencyKey` to get per‑user (or per‑tenant) sub‑queues:

```ts
await generatePullRequest.trigger(data, {
 queue: { name: "paid-users", concurrencyLimit: 10 },
 concurrencyKey: data.userId,
});
```

This is crucial for multi‑tenant or priority workloads.

### 7.2 Debounce

Debounce is a workflow‑shaping primitive:

- Multiple triggers with same `debounce.key` merge into one delayed run.
- `mode: "leading"` – use first payload.
- `mode: "trailing"` – use last payload.
- Optional `maxDelay` to cap total delay window.

Useful for:

- Document indexing after user stops typing.
- Throttled background syncs.
- Rolling up bursts of events into a single workflow run.

---

## 8. How Workflows Appear in the Trigger.dev UI

In the webapp UI (routes we mapped earlier):

- **Runs pages**:
 - Show individual workflow runs, their status, attempts, and timeline.
- **Traces & logs**:
 - Powered by OpenTelemetry; each run has a trace timeline with spans.
 - Auto‑instrumentation via Prisma, AWS SDK, etc. as configured in `trigger.config.ts`.
- **Dashboards / metrics**:
 - Aggregated view of runs, latency distribution, error rates.
- **Errors, logs, schedules, queues**:
 - Each has its own env/project‑scoped views.

These UIs are just frontends on top of the concepts above: tasks, runs, attempts, checkpointing, and triggers.

---

## 9. Summary – “Workflows” in Trigger.dev

Putting it all together:

- A **workflow** in Trigger.dev is a *graph of tasks and runs*.
- You express workflow logic by:
 - Defining tasks (`task({ id, run, ... })`).
 - Chaining them with `trigger*` and `wait.*`.
 - Using options (delay, ttl, idempotency, queues, debounce) to control behavior.
- The platform:
 - Turns each trigger into a **run**.
 - Moves runs through a **lifecycle** with attempts, retries, and TTL.
 - Uses **Checkpoint–Resume** to pause and resume execution.
 - Caches subtask results with **idempotency keys** for durable retries.
 - Exposes everything through:
 - The **dashboard** (runs, traces, metrics).
 - The **SDK** (`runs.*`, `tasks.*`, `batch.*`).

If you want, next I can:

- Map this model 1:1 to Blok’s terminology and suggest how to expose similar concepts (tasks, runs, workflows) in **Blok Studio**’s UI and SDK, or
- Zoom into one advanced topic (e.g. idempotency keys and durable subtask orchestration) with concrete examples you can mirror in Blok.

Let’s zoom in on **durable subtask orchestration with idempotency** – it’s one of the most powerful advanced patterns in Trigger.dev, and it maps very naturally to what you’re building in Blok.

I’ll:

- Explain how Trigger.dev uses idempotency + subtasks to make workflows durable.
- Walk through a concrete pattern step‑by‑step.
- Show two example workflows with code you can mirror in Blok:
 - A data processing / ETL pipeline.
 - An AI multi‑step pipeline.

I’ll keep the Trigger.dev code idiomatic, and then highlight how you can adapt the *patterns* into Blok, not necessarily the exact APIs.

---

## 1. Why this pattern exists

Problem Trigger.dev solves:

- Workflows are often multi‑step and long‑running:
 - e.g. fetch → process → store → notify.
- Failures can happen anywhere:
 - Network errors, API limits, worker crashes, timeouts.
- Simple retries can re‑do expensive or non‑idempotent work (double‑sending emails, double‑charging, re‑processing huge files).

Desired behavior:

- Break workflows into smaller subtasks.
- Cache subtask outputs.
- On failure, **only rerun the parts that failed**, not the entire pipeline.

This is exactly what the “Durable execution” section in `how-it-works.mdx` is about.

---

## 2. Core Trigger.dev pattern

At a high level:

1. Parent workflow task is triggered.
2. It creates an **idempotency key** (unique per logical workflow).
3. It calls sub‑tasks using `triggerAndWait(..., { idempotencyKey })`.
4. Trigger.dev:
 - On **first** success of a subtask, stores the result keyed by `idempotencyKey`.
 - On **retries** of the parent, reuses the cached outputs for already‑succeeded subtasks.

From `how-it-works.mdx` (simplified):

```ts
import { idempotencyKeys, task } from "@trigger.dev/sdk";
import { processVideo, uploadToS3, sendUserEmail } from "./tasks";

export const convertVideo = task({
 id: "convert-video",
 retry: { maxAttempts: 5, minTimeoutInMs: 1000, maxTimeoutInMs: 10000, factor: 2 },
 run: async ({ videoId }: { videoId: string }) => {
    // 1) Scope an idempotency key to this logical workflow
    const idempotencyKey = await idempotencyKeys.create(videoId);

    // 2) Process video: cached on success
    const { processedContent } = await processVideo
      .triggerAndWait({ videoId }, { idempotencyKey })
      .unwrap();

    // 3) Upload to S3: cached on success
    const { s3Url } = await uploadToS3
      .triggerAndWait({ processedContent, videoId }, { idempotencyKey })
      .unwrap();

    // 4) DB updates (idempotent) + notifications (fire‑and‑forget)
    await updateVideoUrl(videoId, s3Url);
    await sendUserEmail.trigger({ videoId, s3Url }, { idempotencyKey });

    return { success: true, s3Url };
 },
});
```

Behavior on a failure “late” in the workflow:

- Suppose `sendUserEmail` fails after `processVideo` and `uploadToS3` succeeded.
- Parent `convertVideo` throws → run fails → gets retried.
- On retry:
 - `processVideo` with same `idempotencyKey` returns cached result **instantly**.
 - `uploadToS3` returns cached result **instantly**.
 - Only `sendUserEmail` runs again.

This turns your workflow into a **stateful DAG** with memoized edges, without you managing persistence manually.

---

## 3. Example 1 – Data Processing / ETL Workflow

Scenario:

- You ingest raw data from an external API.
- You transform/enrich it.
- You store it to your data warehouse.
- You send a Slack summary.

### 3.1 Trigger.dev version

```ts
// /trigger/dataPipeline.ts
import { task, idempotencyKeys } from "@trigger.dev/sdk";
import { fetchRawData, transformData, storeRecords, notifySlack } from "./etlTasks";

export const dataPipeline = task({
 id: "data-pipeline",
 retry: { maxAttempts: 5 },
 run: async ({ jobId }: { jobId: string }) => {
    // Scoped idempotency key for this ETL job
    const idem = await idempotencyKeys.create(`etl:${jobId}`);

    const raw = await fetchRawData
      .triggerAndWait({ jobId }, { idempotencyKey: idem })
      .unwrap();

    const enriched = await transformData
      .triggerAndWait({ jobId, raw }, { idempotencyKey: idem })
      .unwrap();

    const { rowCount } = await storeRecords
      .triggerAndWait({ jobId, enriched }, { idempotencyKey: idem })
      .unwrap();

    // Fire‑and‑forget notification – failures don’t break the pipeline
    await notifySlack.trigger({ jobId, rowCount }, { idempotencyKey: idem });

    return { jobId, rowCount };
 },
});
```

Subtasks (simplified):

```ts
// /trigger/etlTasks.ts
import { task } from "@trigger.dev/sdk";

export const fetchRawData = task({
 id: "fetch-raw-data",
 run: async ({ jobId }: { jobId: string }) => {
    // call external API, paginate, etc.
    return { records: [...] };
 },
});

export const transformData = task({
 id: "transform-data",
 run: async ({ jobId, raw }: { jobId: string; raw: any }) => {
    // heavy CPU or ML transforms
    return { enrichedRecords: [...] };
 },
});

export const storeRecords = task({
 id: "store-records",
 run: async ({ jobId, enriched }: { jobId: string; enriched: any }) => {
    // write to DB / warehouse; code should be idempotent
    return { rowCount: enriched.length };
 },
});

export const notifySlack = task({
 id: "notify-slack",
 run: async ({ jobId, rowCount }: { jobId: string; rowCount: number }) => {
    // send Slack message
 },
});
```

### 3.2 How this would map to Blok

In Blok, think in terms of:

- **One Blok workflow** that orchestrates nanoservices (or nodes).
- Sub‑steps implemented as separate nanoservices or steps within the same workflow.
- A stored **“workflow idempotency key”** that:
 - Is passed to each step.
 - Lets you memoize results in your own persistence (or via a built‑in store).

Concrete mapping ideas:

- In your Blok runtime/service layer:
 - Introduce an `idempotencyKey` concept similar to Trigger.dev.
 - For each node execution, record `(workflowId, nodeId, idempotencyKey, outputHash/outputPayload)`.
 - Before executing a node, check if `(workflowId, nodeId, idempotencyKey)` exists → reuse.

- In the Studio UI:
 - In a run’s detail view, show:
 - “Subtask reused cached result from run X due to idempotency”.
 - Distinct icon/label for “cache hit vs executed”.

You wouldn’t necessarily copy the exact API, but you can borrow the structure:

- Parent step orchestrating smaller nodes.
- Idempotent caching of sub‑steps.

---

## 4. Example 2 – AI Multi‑step Workflow

Scenario:

- User sends a prompt.
- Workflow:
 1. Generate a draft with an LLM.
 2. Critically evaluate/refine.
 3. Generate final content.
 4. Store in DB and send a notification.

We want to avoid:

- Calling OpenAI multiple times on retries.
- Re‑storing or sending duplicates.

### 4.1 Trigger.dev version

```ts
// /trigger/contentPipeline.ts
import { task, idempotencyKeys } from "@trigger.dev/sdk";
import { draftContent, reviewDraft, finalizeContent, storeAndNotify } from "./contentTasks";

export const contentPipeline = task({
 id: "content-pipeline",
 retry: { maxAttempts: 4 },
 run: async ({ requestId, prompt }: { requestId: string; prompt: string }) => {
    const key = await idempotencyKeys.create(`content:${requestId}`);

    const draft = await draftContent
      .triggerAndWait({ prompt }, { idempotencyKey: key })
      .unwrap();

    const reviewed = await reviewDraft
      .triggerAndWait({ draft }, { idempotencyKey: key })
      .unwrap();

    const final = await finalizeContent
      .triggerAndWait({ reviewed }, { idempotencyKey: key })
      .unwrap();

    await storeAndNotify.trigger({ requestId, final }, { idempotencyKey: key });

    return { requestId, final };
 },
});
```

Subtasks:

```ts
// /trigger/contentTasks.ts
import { task, logger } from "@trigger.dev/sdk";
// imagine using OpenAI here, omitted for brevity

export const draftContent = task({
 id: "draft-content",
 run: async ({ prompt }: { prompt: string }) => {
    logger.info("Generating draft");
    // const llmDraft = await openai.chat.completions.create(...);
    return { text: `Draft for: ${prompt}` };
 },
});

export const reviewDraft = task({
 id: "review-draft",
 run: async ({ draft }: { draft: { text: string }) => {
    logger.info("Reviewing draft");
    // run critique/QA agent over draft.text
    return { text: draft.text + " [reviewed]" };
 },
});

export const finalizeContent = task({
 id: "finalize-content",
 run: async ({ reviewed }: { reviewed: { text: string }) => {
    logger.info("Finalizing content");
    // maybe another LLM call to polish
    return { text: reviewed.text + " [final]" };
 },
});

export const storeAndNotify = task({
 id: "store-and-notify",
 run: async ({ requestId, final }: { requestId: string; final: { text: string }) => {
    // store in DB and notify user (email, Slack, etc.)
 },
});
```

Workflow behavior:

- If `storeAndNotify` fails (e.g., DB is down), retry runs will not repeat LLM calls.
- `draftContent`, `reviewDraft`, and `finalizeContent` use cached outputs from prior attempt.

### 4.2 Mirroring in Blok

For Blok, this is very close to the use cases you described (AI + traces):

- Each “step” (draft → review → finalize → store/notify) is:
 - A **node** in the Blok workflow graph.
 - Or a nanoservice within a chain.

Patterns to mirror:

1. **Explicit sub‑steps** with small, composable functions.
 - Keep each node focused: one LLM call, one DB write, etc.

2. **Idempotent sub‑step caching** keyed by:
 - `(workflowRunId, nodeName, stableKey)`, where `stableKey` might be derived from user input or requestId.

3. **Trace integration**:
 - For each node, create spans similar to Trigger.dev’s `logger.trace("ffmpeg", ...)` pattern.
 - In Studio, show:
 - When a node executed vs when it reused cached output.
 - Each sub‑span for external calls (OpenAI, DB, HTTP).

4. **Retry semantics**:
 - On parent workflow retry, re‑evaluate only the steps that actually depend on changed input or that previously failed.

Practical UI ideas for Blok Studio:

- In the **Run detail**:
 - For each node:
 - Status: Executed / Cached / Skipped due to idempotency.
 - Show original attempt and reuse markers (like a small “reused result” tag).
- In the **Node detail** sidebar:
 - A list of runs that reused this node’s output via idempotency key.

---

## 5. How to position this in Blok’s design

When you document or expose this in Blok:

1. **Concept name**: You can call it:
 - “Durable sub‑workflows with idempotent steps” or
 - “Idempotent node execution” (if you want to stay closer to your node/nanoservices language).

2. **Developer‑facing API** (pseudocode):

 ```ts
   // Blok-flavored pseudocode
   const workflow = defineWorkflow({
     id: "etl-pipeline",
     run: async (ctx) => {
       const idem = await ctx.idempotency.create(ctx.payload.jobId);

       const raw = await ctx.call("fetchRaw", ctx.payload, { idempotencyKey: idem });
       const enriched = await ctx.call("transformData", raw, { idempotencyKey: idem });
       const stored = await ctx.call("storeRecords", enriched, { idempotencyKey: idem });

       await ctx.call("notifySlack", stored, { idempotencyKey: idem, fireAndForget: true });

       return stored;
     },
   });
   ```

3. **Studio visualization**:
 - Show **which nodes are idempotent** and what key they used.
 - Indicate cached vs executed steps on each run.

This gives Blok a very strong story for **safe retries, long‑running workflows, and cost‑efficient AI/data pipelines**, closely aligned with what Trigger.dev is doing under the hood.

---

If you tell me whether you want to prioritize **ETL/data** workflows or **AI workflows** in Blok first, I can next:

- Draft a Blok‑style API for those workflows, plus
- Sketch how that would appear in **Blok Studio’s graph + run view** (components, props, and layout).