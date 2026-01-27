# Trigger Details

Here is a **code‑level, TypeScript‑focused spec** of how triggers work in Blok, so you can design new ones (HTTP, gRPC, pub/sub, queues, workers) correctly.

I’ll anchor everything in the actual trigger classes, helper types, and workflow helper APIs. Every code claim has a citation.

---

## 1. Big picture: what a Trigger does in code

At runtime, a Trigger is a long‑lived process that:  

1. Starts an interface server or consumer (HTTP server, gRPC server, queue consumer, etc.). [38][14]  
2. Loads the global Node map and Workflow map into memory. [38]  
3. Listens for an event (HTTP request, gRPC call, message, cron tick). [38][12]  
4. For each event:
   - Selects the right workflow (from `this.nodeMap.workflows`). [38]  
   - Reads the workflow’s `trigger` section (e.g. `workflowModel.trigger.http`). [20][22]  
   - Builds a `Context` instance via `TriggerBase.createContext`. [32][38]  
   - Populates `ctx.request` (or equivalent) from the incoming event. [38][32]  
   - Executes the workflow through the runner, then maps `ctx.response` back to the external interface. [32][38]  

HTTP and gRPC triggers are concrete examples of this pattern. [38][14]

---

## 2. Trigger types and workflow helper: how TS represents a trigger

The workflow helper and types give you the “source of truth” for valid trigger names and configuration.

### 2.1. Allowed trigger names

`core/workflow-helper/src/types/TriggerOpts.ts` defines a Zod enum of trigger names: [34]

```ts
export const TriggersSchema = z.enum(["http", "cron", "manual", "grpc"]);
``` [34]

This tells you valid trigger keys today: `"http"`, `"cron"`, `"manual"`, `"grpc"`. [34]

If you add new trigger types (e.g. `"queue"`, `"pubsub"`), this is one place you must extend. [34]

### 2.2. Setting the trigger in a workflow via helper

`core/workflow-helper/src/components/Trigger.ts` has a `Trigger` class with `addTrigger`, used by the high‑level workflow builder. [18][24]

```ts
// core/workflow-helper/src/components/Trigger.ts
addTrigger(name: TriggersEnum, config?: TriggerOpts): StepNode {
  TriggersSchema.parse(name);

  if ((config as unknown as string) === "http") {
    TriggerOptsSchema.parse(config);
  }
  this._config.trigger = { [name]: config || {} };

  const helperResponse = new StepNode();
  helperResponse.setConfig(this._config);
  return helperResponse;
}
``` [24]

Key behaviors:

- `name` must be one of the enum values `"http" | "cron" | "manual" | "grpc"` or workflow building fails. [34][24]  
- `this._config.trigger = { [name]: config || {} }` writes the workflow’s `trigger` block as a single‑key object, e.g. `{ http: { method, path, accept } }` or `{ cron: { ... } }`. [24]  
- For HTTP, it also validates `config` via `TriggerOptsSchema`. [24]  

**Rule for new triggers:**

- Extend `TriggersSchema` with your new name (e.g. `"queue"`). [34]  
- Extend `TriggerOptsSchema` with the configuration shape for that trigger (e.g. topic, subscription, ack timeout). [24]  
- `addTrigger` will then be able to build `{ queue: { ... } }` into workflow config. [24][34]

---

## 3. How the HTTP Trigger works (pattern to copy for new triggers)

`triggers/http/src/runner/HttpTrigger.ts` is your best template. [38]

### 3.1. Class structure

```ts
// triggers/http/src/runner/HttpTrigger.ts
export default class HttpTrigger extends TriggerBase {
  private app: Express = express();
  private port: string | number = process.env.PORT || 4000;
  private initializer = 0;
  private nodeMap: GlobalOptions = <GlobalOptions>{};
  protected tracer = trace.getTracer(
    process.env.PROJECT_NAME || "trigger-http-workflow",
    process.env.PROJECT_VERSION || "0.0.1",
  );
  private logger = new DefaultLogger();

  constructor() {
    super();

    this.initializer = this.startCounter();
    this.loadNodes();
    this.loadWorkflows();
  }

  loadNodes() {
    this.nodeMap.nodes = new NodeMap();
    const nodeKeys = Object.keys(nodes);
    for (const key of nodeKeys) {
      this.nodeMap.nodes.addNode(key, nodes[key]);
    }
  }

  loadWorkflows() {
    this.nodeMap.workflows = workflows;
  }

  getApp(): Express {
    return this.app;
  }

  listen(): Promise<number> {
    return new Promise((done) => {
      this.app.use(express.static("public"));
      this.app.use(bodyParser.text({ limit: "150mb" }));
      this.app.use(bodyParser.urlencoded({ extended: true }));
      this.app.use(bodyParser.json({ limit: "150mb" }));
      this.app.use(cors());

      this.app.use("/health-check", (req: Request, res: Response) => {
        res.status(200).send("Online and ready for action 💪");
      });

      this.app.get("/metrics", (req: Request, res: Response) => {
        try {
          metricsHandler(req, res);
        } catch (error) {
          // ...
        }
      });

      // ... route wiring that reads workflows + trigger config ...

    });
  }
}
``` [38]

Key patterns:

- `HttpTrigger` extends `TriggerBase`, inheriting `createContext`, counters, etc. [38][32][29]  
- In `constructor`, it calls `loadNodes()` and `loadWorkflows()` to build an in‑memory `nodeMap` with `nodes` and `workflows`. [38]  
- `listen()` starts the external interface (Express) and wires global routes like `/health-check` and `/metrics`. [38]  

For your own triggers (queue, pub/sub, workers):

- You will extend `TriggerBase` the same way. [15][29][38]  
- Instead of Express, you’ll create a consumer or worker loop (e.g. queue client, cron scheduler). [38]  
- You’ll still call `loadNodes()` and `loadWorkflows()` in the constructor to get access to all nodes and workflow blueprints. [38]

### 3.2. Reading trigger config from workflow

In both gRPC and HTTP triggers, you see the same pattern for reading the workflow’s `trigger` section. [20][22][19][21]

```ts
// triggers/http/src/runner/HttpTrigger.ts
const trigger = Object.keys(workflowModel.trigger);
const trigger_config =
  ((workflowModel.trigger as unknown as ParamsDictionary)[trigger] as unknown as TriggerOpts) || {};
``` [20][22]

// triggers/grpc/src/GRpcTrigger.ts
const trigger = Object.keys(workflowModel.trigger);
const trigger_config =
  ((workflowModel.trigger as unknown as ParamsDictionary)[trigger] as unknown as TriggerOpts) || {};
``` [19][21]

Key details:

- The `workflowModel.trigger` object is assumed to have exactly one key (e.g. `http`, `grpc`, `cron`, `manual`). [20][19][34]  
- `trigger` is the trigger name string (`"http"` or `"grpc"`). [20][19]  
- `trigger_config` is the typed config object for that trigger (e.g. `{ method, path, accept }` for HTTP). [20][22][19][21]  

**Rule for new triggers:**

- Your event dispatcher must:
  - Read `workflowModel.trigger` the same way. [20][22][19][21]  
  - Filter or select workflows where `trigger === "queue"` (or your new type) and `trigger_config` meets your criteria (topic, subscription, etc.). [20][22][34]  

---

## 4. TriggerBase: common building block for all triggers

We already looked at `TriggerBase.createContext`, which is crucial. [32]

```ts
// core/runner/src/TriggerBase.ts
createContext(logger?: LoggerContext, blueprintPath?: string, id?: string): Context {
  const requestId: string = id || uuid();
  const ctx: Context = {
    id: requestId,
    workflow_name: this.configuration.name,
    workflow_path: blueprintPath || "",
    config: this.configuration.nodes,
    request: { body: {} },
    response: { data: "", contentType: "", success: true, error: null },
    error: { message: [] },
    logger: logger || new DefaultLogger(this.configuration.name, blueprintPath, requestId),
    eventLogger: null,
    _PRIVATE_: null,
  };

  Object.defineProperty(ctx, "id", {
    value: requestId,
    enumerable: true,
  });

  Object.defineProperty(ctx, "env", {
    value: process.env,
    enumerable: true,
  });

  return ctx;
}
``` [32]

This ensures every trigger gets a consistent `Context` skeleton. [32]

**For new triggers**:

- You must call `this.createContext(...)` to get `ctx` for each incoming event. [32]  
- Then you enrich `ctx.request` or another section with event‑specific data (headers, payload, metadata) before invoking the workflow runner. [32][38]  

---

## 5. gRPC Trigger: second concrete example

There is a gRPC trigger implementation in `triggers/grpc/src/GRpcTrigger.ts`. [14][12]

We don’t see the full code in the snippet, but:

- It constructs `const trigger = new GRpcTrigger();` in `triggers/grpc/src/GrpcServer.ts`. [12]  
- `GRpcTrigger` extends the same pattern as `HttpTrigger` but for gRPC calls. [14][12]  
- It reads `workflowModel.trigger` and `trigger_config` exactly as HTTP does, using `Object.keys(workflowModel.trigger)` and typed `TriggerOpts`. [19][21]  

**Lesson:**

- Every new trigger type should mimic HTTP/gRPC:
  - Extend `TriggerBase`. [15][29][38]  
  - Load nodes and workflows. [38][14]  
  - For each event, match workflows based on `workflowModel.trigger`. [20][22][19][21]  
  - Build `ctx` and call into the workflow runner. [32][38]

---

## 6. How trigger config lives inside workflow models

From workflows (like `workflow-docs.json` earlier), the trigger section is serialized into the `workflowModel.trigger` object that triggers read. [30][20][22]

For example, an HTTP workflow has: [30]

```json
"trigger": {
  "http": {
    "method": "*",
    "path": "/:function?",
    "accept": "application/json"
  }
}
``` [30]

And `HttpTrigger` reads: [20][22]

```ts
const trigger = Object.keys(workflowModel.trigger); // "http"
const trigger_config =
  ((workflowModel.trigger as unknown as ParamsDictionary)[trigger] as unknown as TriggerOpts) || {};
``` [20][22]

So for a queue trigger you’d expect workflows like:

```json
"trigger": {
  "queue": {
    "topic": "user-events",
    "subscription": "user-events-worker",
    "ack": true
  }
}
```

And your `QueueTrigger` would access config in the same way. [20][22][34]

---

## 7. Designing NEW triggers (pub/sub, queues, workers) – concrete checklist

To add new trigger types (e.g. `"queue"`, `"pubsub"`, `"worker"`), follow this pattern:

### 7.1. Extend trigger types and helper

1. **Extend the enum of trigger names** in `core/workflow-helper/src/types/TriggerOpts.ts`: [34]

   ```ts
   export const TriggersSchema = z.enum(["http", "cron", "manual", "grpc", "queue"]);
   ```

2. **Extend `TriggerOptsSchema`** with your new config shape (not shown in the snippet, but it lives alongside `TriggersSchema`): [24][34]

   ```ts
   export const TriggerOptsSchema = z.union([
     // existing "http" options, "cron", "grpc"...,
     z.object({
       type: z.literal("queue").optional(), // if you tag it
       topic: z.string(),
       subscription: z.string().optional(),
       ack: z.boolean().optional(),
     }),
   ]);
   ```

3. Now `addTrigger("queue", { topic: "...", subscription: "..." })` becomes valid and writes `trigger: { queue: { ... } }` into workflow config. [24][34]

### 7.2. Implement a new Trigger class

Create `triggers/queue/src/QueueTrigger.ts`:

- **Extend `TriggerBase`**. [15][29][38]

  ```ts
  export default class QueueTrigger extends TriggerBase {
    private nodeMap: GlobalOptions = <GlobalOptions>{};

    constructor() {
      super();
      this.loadNodes();
      this.loadWorkflows();
    }

    loadNodes() {
      this.nodeMap.nodes = new NodeMap();
      const nodeKeys = Object.keys(nodes);
      for (const key of nodeKeys) {
        this.nodeMap.nodes.addNode(key, nodes[key]);
      }
    }

    loadWorkflows() {
      this.nodeMap.workflows = workflows;
    }

    async startConsumer() {
      // connect to queue, subscribe...
    }
  }
  ```

  This mirrors `HttpTrigger.loadNodes()` and `HttpTrigger.loadWorkflows()`. [38]

- **For each incoming message**:
  - Iterate configured workflows in `this.nodeMap.workflows`. [38]  
  - For each `workflowModel`:
    - Extract trigger name and config: [20][22][19][21]

      ```ts
      const triggerName = Object.keys(workflowModel.trigger);
      if (triggerName !== "queue") continue;

      const trigger_config =
        ((workflowModel.trigger as unknown as ParamsDictionary)[triggerName] as unknown as TriggerOpts) || {};
      ```

    - Match on `topic`, `subscription`, etc. in `trigger_config` vs the message metadata. [20][22][34]  
    - When matched:
      - Call `const ctx = this.createContext(..., workflowModel.path, messageId);`. [32]  
      - Populate `ctx.request` (or define `ctx.message`) with the message body & headers:

        ```ts
        ctx.request = {
          body: message.body,
          headers: message.headers,
          query: {},
          params: {},
        };
        ``` [32][10]

      - Invoke the workflow runner with `(ctx, workflowModel, this.nodeMap.nodes)` (same pattern as HTTP/gRPC; the exact call signature is in runner code not shown here). [32][38]  
      - Map `ctx.response` back to queue semantics (ack, nack, reply). [32][10]

### 7.3. Map trigger data into Context consistently

For all triggers:

- HTTP sets `ctx.request.body`, `ctx.request.headers`, `ctx.request.query`, and `ctx.request.params`. [32][38][36]  
- gRPC sets an equivalent shape (not fully shown, but uses same `Context`). [14][12][32]  
- Queue / PubSub / Worker should:
  - Put primary payload into `ctx.request.body` (or another clearly defined property if you standardize `ctx.message`). [32][10][36]  
  - Put message metadata into `ctx.request.headers` or a dedicated `ctx.message.meta`. [32][10]  

This is necessary so workflows and nodes can safely read from `ctx.request.*` without caring which trigger fired. [5][32][38]

---

## 8. Summary rules for Claude when generating / reasoning about triggers

1. **Triggers are classes extending `TriggerBase`** that:
   - Load nodes into `this.nodeMap.nodes` via `NodeMap`. [38]  
   - Load workflow blueprints into `this.nodeMap.workflows`. [38]  
   - Listen to some external system and, per event, select applicable workflows based on `workflowModel.trigger`. [20][22][19][21]  

2. **Workflow trigger config is always a single‑key object** like `{ http: {...} }`, `{ grpc: {...} }`, or `{ cron: {...} }`. [30][20][22]  

3. **Trigger implementations read the config exactly like**:

   ```ts
   const trigger = Object.keys(workflowModel.trigger);
   const trigger_config =
     ((workflowModel.trigger as unknown as ParamsDictionary)[trigger] as unknown as TriggerOpts) || {};
   ``` [20][22][19][21]

4. **Context is constructed via `TriggerBase.createContext`**, which pre‑fills `id`, `workflow_name`, `workflow_path`, `config`, `request`, `response`, `error`, `logger`, `env`. [32]  

5. **Each trigger must then enrich `ctx.request` (or equivalent) with event data** before executing the workflow. [32][38][10]  

6. **To add new trigger types (pub/sub, queue, workers)**:
   - Extend `TriggersSchema` and `TriggerOptsSchema` in workflow helper. [34][24]  
   - Implement a new `*Trigger extends TriggerBase` that follows the HTTP/gRPC pattern. [38][14]  
   - Decide how its config looks in workflows (`trigger: { queue: { ... } }`) and how that maps to your external system. [20][22][34]  

If you’d like, next I can draft a **“Trigger System Prompt”** for Claude that says:

> “Given a new trigger type (e.g. queue), generate the `*Trigger` class, config types, and workflow helper wiring consistent with `HttpTrigger`, `GRpcTrigger`, and `TriggersSchema`…”

and base it directly on the patterns above.

---
*Exported from Tetrix AI Space*
*Date: 2026-01-27T16:11:02.725Z*