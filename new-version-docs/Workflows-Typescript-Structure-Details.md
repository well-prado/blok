# Workflows Typescript Structure Details

Here’s a **TypeScript‑only spec** for how workflows and `Context` work in Blok, grounded in real code and JSON workflow examples (not the prose docs). Every claim that references code has a citation.

---

## 1. How the Context is actually constructed at runtime (TypeScript + Python)

### 1.1 HTTP/TS runtime: `TriggerBase.createContext`

The core place where `Context` is created in TypeScript is `core/runner/src/TriggerBase.ts` via `createContext`. This is what every trigger (like HTTP) uses to build `ctx` before running a workflow. [32]

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

Key facts (from this code):

- `ctx.id` is a unique request ID (generated with `uuid()` if not passed). [32]  
- `ctx.workflow_name` is taken from the workflow configuration name. [32]  
- `ctx.workflow_path` is the blueprint path (typically the workflow file path). [32]  
- `ctx.config` is set to `this.configuration.nodes` (the workflow nodes config). [32]  
- `ctx.request` starts with `{ body: {} }` and is later enriched by the HTTP trigger. [32]  
- `ctx.response` has `data`, `contentType`, `success`, and `error` fields that nodes/workflows update. [32]  
- `ctx.error` is an error container. [32]  
- `ctx.logger` and `ctx.eventLogger` provide logging hooks. [32]  
- `ctx.env` is lazily attached via `Object.defineProperty`, pointing to `process.env`. [32]  

**Rule for Claude (TS workflows):**

- Assume `ctx: Context` always includes at least: `id`, `workflow_name`, `workflow_path`, `config`, `request`, `response`, `error`, `logger`, `env`. [32]  
- Do not invent new root properties on `ctx` in generated code; instead, consume what is actually present. [32]

### 1.2 Python runtime: `Runner.create_context`

The Python runner reconstructs a `Context` from a plain dict when calling Python nodes, showing the same conceptual fields. [10]

```py
# runtimes/python3/runner.py
def create_context(self, ctx: Dict[str, Any]) -> Context:
    context = Context()
    context.id = ctx.get('id', '')
    context.workflow_name = ctx.get('workflow_name', '')
    context.workflow_path = ctx.get('workflow_path', '')
    context.request = ctx.get('request', {})
    context.response = ctx.get('response', {})
    context.error = ctx.get('error', None)
    context.logger = ctx.get('logger', None)
    context.config = ctx.get('config', {})
    context.func = ctx.get('func', None)
    context.vars = ctx.get('vars', {})
    context.env = ctx.get('env', {})

    return context
``` [10]

Important details from Python side:

- `ctx.vars` is explicitly present in cross‑runtime context, even if not initialized in `TriggerBase`. [10][32]  
- `ctx.func` can be used for passing function handles into the runtime (Python‑specific). [10]  

**Rule for Claude:**

- When writing TS nodes or TS‑based workflows that refer to `ctx.vars`, assume it exists and is a plain `{ [key: string]: any }` used to exchange data between nodes. [10][32]

---

## 2. How nodes use `Context` in TypeScript

The canonical code example for node usage of `Context` is the conceptual node in `docs/d/introduction/context.mdx`. Even though it’s in docs, it’s real TS code and matches how `BlokService`‑based nodes behave. [5]

```ts
// conceptual example of a Node using Context
import { type IBlokResponse, BlokService, BlokResponse } from "@blok/runner";
import { type Context, GlobalError } from "@blok/shared";

type InputType = {
  message?: string;
};

export default class Node extends BlokService<InputType> {
  constructor() {
    super();
    this.inputSchema = {};
    this.outputSchema = {};
  }

  async handle(ctx: Context, inputs: InputType): Promise<IBlokResponse> {
    const response: BlokResponse = new BlokResponse();

    try {
      // 1. Get data from the request via context
      const userId = ctx.request.params.id;

      // 2. Get data set by a previous node
      const previousData = ctx.vars['previous-node-name'];

      // 3. Process the data
      const processedInfo = `Processed for ${userId} with ${previousData}`;

      // 4. Set data for subsequent nodes
      ctx.vars['current-node'] = processedInfo;

      // 5. Set the response data
      response.setSuccess({ message: inputs.message || processedInfo });
    } catch (error: unknown) {
      const nodeError: GlobalError = new GlobalError((error as Error).message);
      nodeError.setCode(500);
      nodeError.setStack((error as Error).stack);
      nodeError.setName(this.name);
      nodeError.setJson(undefined);

      response.setError(nodeError);
    }

    return response;
  }
}
``` [5]

From this:

- `ctx.request.params.id` is used to read a path parameter from the trigger. [5]  
- `ctx.vars['previous-node-name']` is used to read data written by a previous node. [5][10]  
- `ctx.vars['current-node']` is used to write data for future nodes. [5][10]  
- `response.setSuccess` is used to send success payload; `GlobalError` is used for standard error reporting. [5]  

**Rule for Claude (TS node code):**

- For HTTP workflows, prefer `ctx.request.params`, `ctx.request.query`, and `ctx.request.body` to read request‑derived data. [5][10][32]  
- Use `ctx.vars` to share intermediate values across nodes; keys should be descriptive (e.g., `"fetch-user.user"` or `"aggregation.result"`). [5][10]  
- Set `response.setSuccess` or `response.setError` from within nodes; do not mutate `ctx.response` directly unless that’s part of an advanced pattern. [5][32]

---

## 3. Workflow definition, focusing on the “docs generator” example

The most complete workflow example is `triggers/http/workflows/json/workflow-docs.json`. This is a JSON blueprint, but **TypeScript workflows must mirror this structure in typed form**: `trigger`, `steps`, `nodes`, and conditionals. [30][24][25][29]

### 3.1. Top‑level structure

```json
{
  "name": "Workflow Docs Generator",
  "description": "This workflow generates documentation for a given workflow in HTML format.",
  "version": "1.0.0",
  "trigger": {
    "http": {
      "method": "*",
      "path": "/:function?",
      "accept": "application/json"
    }
  },
  "steps": [
    {
      "name": "filter-request",
      "node": "@blok/if-else",
      "type": "module"
    }
  ],
  "nodes": {
    "filter-request": { ... },
    "workflow-ui": { ... },
    "get-workflows": { ... },
    "method-not-allowed": { ... },
    "get-workflow-content": { ... },
    "generate-docs": { ... }
  }
}
``` [30][25][24][29]

Key points:

- `name`, `description`, `version` identify the workflow. [30]  
- `trigger.http` describes how the HTTP trigger invokes this workflow (method, path, accept). [30]  
- `steps` is the ordered list of **entry steps**; here it’s a single control‑flow node `filter-request`. [30]  
- `nodes` is a map keyed by step names (`filter-request`, `workflow-ui`, etc.), holding per‑node config. [30][25]  

**TS parallel:**

In TypeScript, you would represent the workflow configuration with interfaces roughly like:

```ts
type HttpTrigger = {
  method: string;          // e.g. "*", "GET", "POST"
  path: string;            // e.g. "/:function?"
  accept: string;          // e.g. "application/json"
};

type WorkflowTrigger = {
  http: HttpTrigger;
};

type WorkflowStep = {
  name: string;
  node: string;
  type: "module";          // or other step types
};

type IfElseConditionStep = WorkflowStep;

type IfElseCondition = {
  type: "if" | "else";
  condition?: string;      // present only when type === "if"
  steps: IfElseConditionStep[];
};

type IfElseNodeConfig = {
  conditions: IfElseCondition[];
};

type SimpleNodeConfig = {
  inputs: Record<string, unknown>;
};

type WorkflowNodes = Record<string, IfElseNodeConfig | SimpleNodeConfig>;

type WorkflowConfig = {
  name: string;
  description: string;
  version: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  nodes: WorkflowNodes;
};
```

This mirrors the JSON structure of `workflow-docs.json`. [30][25]

---

## 4. Conditional workflows via `@blok/if-else` (with `ctx`)

The `filter-request` node in `workflow-docs.json` is a **router** built with a single `@blok/if-else` node. [30][25]

### 4.1. Conditions structure

```json
"nodes": {
  "filter-request": {
    "conditions": [
      {
        "type": "if",
        "steps": [
          {
            "name": "workflow-ui",
            "node": "workflow-ui",
            "type": "module"
          }
        ],
        "condition": "ctx.request.method.toLowerCase() === \"get\" && ctx.request.params.function === undefined"
      },
      {
        "type": "if",
        "steps": [
          {
            "name": "get-workflows",
            "node": "directory-manager",
            "type": "module"
          }
        ],
        "condition": "ctx.request.method.toLowerCase() === \"get\" && ctx.request.params.function === \"workflows\""
      },
      {
        "type": "if",
        "steps": [
          {
            "name": "get-workflow-content",
            "node": "file-manager",
            "type": "module"
          },
          {
            "name": "generate-docs",
            "node": "openai",
            "type": "module"
          }
        ],
        "condition": "ctx.request.method.toLowerCase() === \"get\" && ctx.request.params.function === \"workflow-doc\""
      },
      {
        "type": "else",
        "steps": [
          {
            "name": "method-not-allowed",
            "node": "error",
            "type": "module"
          }
        ]
      }
    ]
  },
  ...
}
``` [30][25]

Observations:

- Each `"if"` branch has:
  - `condition`: a JavaScript expression string evaluated against the **real `ctx` object**. [25][10][32]  
  - `steps`: the list of steps executed if this condition is true. [25]  
- The `condition` strings use `ctx.request.method.toLowerCase()` and `ctx.request.params.function` to route requests. [25]  
- The `"else"` branch has no `condition`, just `type: "else"` and `steps`. [25]  

**TS modeling for the condition expressions:**

At generation time, Claude must:

- Produce **valid JavaScript expressions** referencing only actual `ctx` fields (like `ctx.request.method`, `ctx.request.params.<name>`, `ctx.vars.<key>`, etc.). [25][5][10][32]  
- Not reference arbitrary properties that don’t exist on `Context` (e.g., no `ctx.user` unless your runtime attaches it). [32][10]  

Example TypeScript representation for the conditions:

```ts
const workflowDocsRouter: IfElseNodeConfig = {
  conditions: [
    {
      type: "if",
      condition: 'ctx.request.method.toLowerCase() === "get" && ctx.request.params.function === undefined',
      steps: [{ name: "workflow-ui", node: "workflow-ui", type: "module" }],
    },
    {
      type: "if",
      condition: 'ctx.request.method.toLowerCase() === "get" && ctx.request.params.function === "workflows"',
      steps: [{ name: "get-workflows", node: "directory-manager", type: "module" }],
    },
    {
      type: "if",
      condition: 'ctx.request.method.toLowerCase() === "get" && ctx.request.params.function === "workflow-doc"',
      steps: [
        { name: "get-workflow-content", node: "file-manager", type: "module" },
        { name: "generate-docs", node: "openai", type: "module" },
      ],
    },
    {
      type: "else",
      steps: [{ name: "method-not-allowed", node: "error", type: "module" }],
    },
  ],
};
```

This is a **direct TS encoding** of what exists in the JSON example. [30][25]

---

## 5. Node configurations inside a workflow (TS mirror of `nodes` block)

The rest of `workflow-docs.json` shows how individual nodes are configured with `inputs`. [24][25][29]

```json
"workflow-ui": {
  "inputs": {}
},
"get-workflows": {
  "inputs": {
    "path": "js/process.env.WORKFLOWS_PATH + '/json'"
  }
},
"method-not-allowed": {
  "inputs": {
    "message": "Method not allowed"
  }
},
"get-workflow-content": {
  "inputs": {
    "path": "${ctx.request.query.path}"
  }
},
"generate-docs": {
  "inputs": {
    "cache_key": "${ctx.request.query.path}",
    "system": [
      "You are an AI technical writer specializing in Blok workflow documentation.",
      "Your task is to generate a structured HTML document that fully documents the provided JSON workflow.",
      "The documentation must clearly explain the trigger, steps, and nodes, including each node’s function and its role in the workflow.",
      "Instructions:",
      "1. Generate a well-structured HTML document using <h1>, <h2>, <p>, <table>, and other relevant tags for readability.",
      "2. Include an overview of the workflow, explaining its name, description, and version.",
      "3. Describe the trigger section:",
      "- Explain how the workflow is initiated.",
      "- List all HTTP methods and parameters involved."
      // truncated...
    ]
  }
}
``` [24][25][29]

Patterns:

- `inputs` is always an object, even if empty (`workflow-ui`). [24]  
- Special forms:
  - `"js/...":` evaluated against `process.env` and possibly `ctx`. Example: `"path": "js/process.env.WORKFLOWS_PATH + '/json'"`. [25]  
  - `"${ctx.request.query.path}"`: simple interpolation that pulls from `ctx.request.query.path`. [24]  
- Arrays like `system` for the OpenAI node are passed as‑is to the node, expecting the node’s `InputType` or Zod schema to match. [24]  

**TS representation example:**

```ts
const workflowNodes: WorkflowNodes = {
  "workflow-ui": {
    inputs: {},
  },
  "get-workflows": {
    inputs: {
      path: "js/process.env.WORKFLOWS_PATH + '/json'",
    },
  },
  "method-not-allowed": {
    inputs: {
      message: "Method not allowed",
    },
  },
  "get-workflow-content": {
    inputs: {
      path: "${ctx.request.query.path}",
    },
  },
  "generate-docs": {
    inputs: {
      cache_key: "${ctx.request.query.path}",
      system: [
        "You are an AI technical writer specializing in Blok workflow documentation.",
        "Your task is to generate a structured HTML document that fully documents the provided JSON workflow.",
        "The documentation must clearly explain the trigger, steps, and nodes, including each node’s function and its role in the workflow.",
        "Instructions:",
        "1. Generate a well-structured HTML document using <h1>, <h2>, <p>, <table>, and other relevant tags for readability.",
        "2. Include an overview of the workflow, explaining its name, description, and version.",
        "3. Describe the trigger section:",
        "- Explain how the workflow is initiated.",
        "- List all HTTP methods and parameters involved."
      ],
    },
  },
  "filter-request": workflowDocsRouter, // the IfElseNodeConfig from earlier
};
```

This shows a **pure TS object** that is semantically identical to the JSON blueprint. [24][25][29]

**Rules for Claude:**

- For each `WorkflowStep`, there must be a corresponding entry in `nodes` keyed by that step’s `name`. [30][25][24]  
- Use `"js/...` strings only when you need environment or computed values; use `"${ctx....}"` interpolations for pulling from `ctx.request` or `ctx.vars` into node inputs. [24][25][10][32]  
- Make sure the shape of `inputs` matches the actual node’s TypeScript `InputType`/Zod schema (e.g., `generate-docs` expects `cache_key` and `system: string[]`). [24][5]

---

## 6. End‑to‑end TS view of a workflow (how Claude should generate it)

Putting it all together, a **TypeScript workflow definition** that mirrors `workflow-docs.json` would look like this (pseudo‑TS module):

```ts
// triggers/http/workflows/ts/workflow-docs.ts

type HttpTrigger = {
  method: string;
  path: string;
  accept: string;
};

type Trigger = { http: HttpTrigger };

type StepType = "module";

interface WorkflowStep {
  name: string;
  node: string;
  type: StepType;
}

interface IfElseCondition {
  type: "if" | "else";
  condition?: string;
  steps: WorkflowStep[];
}

interface IfElseNodeConfig {
  conditions: IfElseCondition[];
}

interface SimpleNodeConfig {
  inputs: Record<string, unknown>;
}

type NodeConfig = IfElseNodeConfig | SimpleNodeConfig;

interface WorkflowConfig {
  name: string;
  description: string;
  version: string;
  trigger: Trigger;
  steps: WorkflowStep[];
  nodes: Record<string, NodeConfig>;
}

// TS encoding of the JSON workflow-docs blueprint [30][25][24][29]
export const workflowDocsConfig: WorkflowConfig = {
  name: "Workflow Docs Generator",
  description: "This workflow generates documentation for a given workflow in HTML format.",
  version: "1.0.0",
  trigger: {
    http: {
      method: "*",
      path: "/:function?",
      accept: "application/json",
    },
  },
  steps: [
    {
      name: "filter-request",
      node: "@blok/if-else",
      type: "module",
    },
  ],
  nodes: {
    "filter-request": {
      conditions: [
        {
          type: "if",
          condition: 'ctx.request.method.toLowerCase() === "get" && ctx.request.params.function === undefined',
          steps: [
            {
              name: "workflow-ui",
              node: "workflow-ui",
              type: "module",
            },
          ],
        },
        {
          type: "if",
          condition: 'ctx.request.method.toLowerCase() === "get" && ctx.request.params.function === "workflows"',
          steps: [
            {
              name: "get-workflows",
              node: "directory-manager",
              type: "module",
            },
          ],
        },
        {
          type: "if",
          condition: 'ctx.request.method.toLowerCase() === "get" && ctx.request.params.function === "workflow-doc"',
          steps: [
            {
              name: "get-workflow-content",
              node: "file-manager",
              type: "module",
            },
            {
              name: "generate-docs",
              node: "openai",
              type: "module",
            },
          ],
        },
        {
          type: "else",
          steps: [
            {
              name: "method-not-allowed",
              node: "error",
              type: "module",
            },
          ],
        },
      ],
    },
    "workflow-ui": {
      inputs: {},
    },
    "get-workflows": {
      inputs: {
        path: "js/process.env.WORKFLOWS_PATH + '/json'",
      },
    },
    "method-not-allowed": {
      inputs: {
        message: "Method not allowed",
      },
    },
    "get-workflow-content": {
      inputs: {
        path: "${ctx.request.query.path}",
      },
    },
    "generate-docs": {
      inputs: {
        cache_key: "${ctx.request.query.path}",
        system: [
          "You are an AI technical writer specializing in Blok workflow documentation.",
          "Your task is to generate a structured HTML document that fully documents the provided JSON workflow.",
          "The documentation must clearly explain the trigger, steps, and nodes, including each node’s function and its role in the workflow.",
          "Instructions:",
          "1. Generate a well-structured HTML document using <h1>, <h2>, <p>, <table>, and other relevant tags for readability.",
          "2. Include an overview of the workflow, explaining its name, description, and version.",
          "3. Describe the trigger section:",
          "- Explain how the workflow is initiated.",
          "- List all HTTP methods and parameters involved."
        ],
      },
    },
  },
};
```

This is **exactly** the JSON from `workflow-docs.json` but as a typed TS object, grounded in the actual example. [30][25][24][29]

---

## 7. Concrete rules for Claude when generating TypeScript workflows

1. **Always model workflows as `WorkflowConfig`‑like objects** with `name`, `description`, `version`, `trigger`, `steps`, `nodes`. [30][21][27]  
2. **Triggers**:
   - For HTTP workflows, use `{ http: { method, path, accept } }`. [30]  
   - Make sure `path` parameters like `/:function?` are consistent with how you reference `ctx.request.params.function` in conditions. [30][25][32]  
3. **Steps**:
   - `steps` is an ordered array of entry steps; most HTTP flows start with a single router node like `@blok/if-else`. [30][25]  
4. **Conditional routing**:
   - Use `@blok/if-else` with `conditions: IfElseCondition[]`. [30][25]  
   - Conditions must be valid JS expressions referencing real `ctx` fields (e.g. `ctx.request.method`, `ctx.request.params`, `ctx.request.query`, `ctx.vars`). [25][5][10][32]  
   - Provide a final `"else"` branch with a fallback (e.g. `method-not-allowed`). [25]  
5. **Node configs**:
   - For normal nodes, define `inputs: { ... }` where keys match the node’s `InputType`/Zod schema. [24][5]  
   - Use `"js/...` strings for environment‑derived or computed values; use `"${ctx....}"` for pulling from `ctx`. [24][25][10][32]  
6. **Context usage semantics**:
   - Conditions and interpolations are always evaluated against the actual runtime `Context` built by `TriggerBase.createContext` and enriched by the HTTP trigger. [32][33][10]  
   - Never assume extra fields on `ctx` beyond what `createContext` and the runner actually set (`id`, `workflow_name`, `workflow_path`, `config`, `request`, `response`, `error`, `logger`, `env`, and `vars` as seen in the Python view). [32][10]  

If you want, next I can:

- Draft a **system prompt just for TS workflow generation** (like we did for `defineNode`) that tells Claude: “Given a description, emit a `WorkflowConfig` TypeScript module like `workflow-docs.ts` using correct `ctx` usage and `@blok/if-else` patterns,” grounded in this exact example. [30][25][32]

---
*Exported from Tetrix AI Space*
*Date: 2026-01-27T16:10:59.842Z*