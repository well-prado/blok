# Workflow v2

The canonical authoring shape for Blok workflows — designed to be
LLM-friendly and human-friendly. v1 workflows continue to run unchanged
through a runner-side normalizer; new workflows should use v2.

---

## TL;DR

Six rules. Each fixes a real footgun in v1.

| Rule | Replaces |
|---|---|
| Each step has `id` + `use` + `inputs` (inline) | Separate `steps[].name` and `nodes[name].inputs` map written twice |
| Every step's output auto-persists to `ctx.state[id]` | `set_var: true` opt-in (forgotten, inconsistent across module/SDK nodes) |
| `branch({when, then, else})` — one primitive | `addCondition + new AddIf().addStep().build()` ceremony |
| `$.state.foo` / `$.req.body` typed proxy in TS | Hand-written `js/ctx.vars['foo']` strings |
| URL = file path under `workflows/` (or explicit `path`) | Filename-prefixed `/<workflow-key>/<sub-path>` |
| `"ANY"` for wildcard method | TS used `"ANY"`, JSON used `"*"` |

---

## Anatomy of a step

### Regular step

```ts
{
  id: "fetch-users",          // Stable identifier. Other steps read $.state["fetch-users"].
  use: "@blokjs/api-call",    // Node reference. Type inferred when omitted.
  type: "module",             // Optional — defaults to "module" for non-runtime nodes.
  inputs: {                   // Inputs passed to the node. Lives ON the step.
    url: "https://...",
    method: "GET"
  },
  // --- declarative persistence knobs (all optional) ---
  as: "users",                // Store at state[as] instead of state[id].
  spread: true,               // Shallow-merge result.data keys into state. Mutually exclusive with `as`.
  ephemeral: true,            // Skip persistence; only ctx.prev carries result to next step.
  // --- declarative control knobs (all optional) ---
  active: true,               // false = skip at runtime.
  stop: false,                // true = halt workflow after this step.
  stream_logs: true           // Per-step opt-in for live log streaming (runtime nodes only).
}
```

### Branch step

```ts
{
  id: "route",
  branch: {
    when: '$.req.method === "POST"',           // JS expression, truthy → `then`.
    then: [                                     // Steps to run when truthy.
      { id: "create", use: "...", inputs: {} }
    ],
    else: [                                     // Optional. Steps when falsy.
      { id: "read", use: "...", inputs: {} }
    ]
  },
  active: true,
  stop: false
}
```

---

## Persistence rules — `ctx.state`

Every step's `result.data` is automatically stored in `ctx.state[id]`
after execution. The runner owns this — node code never writes to
`ctx.state` directly.

| Knob | Effect | Use case |
|---|---|---|
| (default) | `state[id] = result.data` | The 95% case |
| `as: "name"` | `state[name] = result.data` (no `state[id]`) | Rename a noisy step id to a domain-natural name |
| `spread: true` | `Object.assign(state, result.data)` | Multi-output nodes / data-pipeline workflows |
| `ephemeral: true` | No persistence | Side-effects (logging, audit, telemetry) |

`as` and `spread` are mutually exclusive — caught at workflow load time.

### Reading state

```ts
// In TS workflows — typed proxy compiles to "js/ctx.state.<path>"
inputs: { user: $.state.users[0] }
inputs: { ids: $.state["users-list"] }   // hyphenated keys use bracket notation

// In JSON workflows — plain string
inputs: { "user": "$.state.users[0]" }
inputs: { "ids": "$.state['users-list']" }

// Adjacent step output (overwritten every step)
inputs: { previous: $.prev.data }

// Request envelope
inputs: { body: $.req.body, queryString: $.req.query.q }
```

The `$` proxy is just typed sugar — at definition time it compiles to a
`"js/ctx....."` string. The runner's existing `Mapper` resolves both
forms identically.

### `ctx.publish(name, value)` — explicit side-channel

When a node legitimately needs to publish a value other than its return
value (rare), use `ctx.publish` from inside `execute()`:

```ts
async execute(ctx, input) {
  ctx.publish("rate-limit-status", "degraded");   // → state["rate-limit-status"]
  return { items: [...] };                         // → state[<step-id>]
}
```

Most nodes shouldn't need this — return your output and let the runner
persist it.

---

## File-based routing

Opt-in via `BLOK_FILE_BASED_ROUTING=true` (or `BLOK_ROUTES=v2`).

When enabled, the URL is derived from each workflow's file location
under `workflows/json/` (or the TS workflows directory):

| File path | URL |
|---|---|
| `workflows/json/health.json` | `/health` |
| `workflows/json/index.json` | `/` |
| `workflows/json/users/list.json` | `/users/list` |
| `workflows/json/users/index.json` | `/users` |
| `workflows/json/users/[id].json` | `/users/:id` |
| `workflows/json/users/[id]/orders.json` | `/users/:id/orders` |

**Skipped:** files or folders whose name starts with `_` or `.` (utilities, drafts, hidden files).

**Explicit override:** when `trigger.http.path` is set on a workflow, that wins:

```json
{
  "trigger": { "http": { "method": "POST", "path": "/api/v2/payments/webhook" } }
}
```

**Method enum:** `"GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "ANY"`.
The legacy `"*"` is auto-converted to `"ANY"` at load time with a one-time deprecation warning.

**Collision detection** at boot:
- Exact `(method, path)` duplicate → throw with both source paths.
- `ANY` shadowing more-specific methods on the same path → throw.
- Param vs literal at the same depth → warn (Hono routes literal first).

---

## Authoring — TypeScript

```ts
import { workflow, branch, $ } from "@blokjs/helper";

export default workflow({
  name: "World Countries",
  version: "1.0.0",
  description: "Returns countries or a cat fact based on query param",
  trigger: { http: { method: "GET" } },   // path inferred from file location

  steps: [
    {
      id: "fetch",
      use: "@blokjs/api-call",
      inputs: { url: "https://countriesnow.space/api/v0.1/countries" },
    },

    branch({
      id: "route",
      when: $.req.query.kind,
      then: [
        { id: "respond", use: "@blokjs/respond", inputs: { body: $.state.fetch } },
      ],
      else: [
        { id: "fallback", use: "@blokjs/api-call",
          inputs: { url: "https://catfact.ninja/fact" } },
      ],
    }),
  ],
});
```

Notes:
- `workflow({...})` returns a tagged builder. Default-export it; the runner picks it up automatically.
- `branch()` factory returns a step shape. Compose it inside `steps[]` like any other step.
- `$.state.fetch` compiles to `"js/ctx.state.fetch"` at definition time (typed in TS, plain string at runtime).
- For equality comparisons in `when:`, use a string: `'$.req.method === "POST"'`. JavaScript's `===` operator can't be intercepted by the proxy.

### Data-pipeline pattern (`spread`)

```ts
{
  id: "load-user-and-profile",
  use: "fetch-user-with-profile",
  spread: true,                    // result.data = { user, profile }
                                   //  → state.user, state.profile
}
```

---

## Authoring — JSON

The JSON shape mirrors TS exactly. An LLM that learns one knows the other.

```json
{
  "name": "World Countries",
  "version": "1.0.0",
  "description": "Returns countries or a cat fact based on query param",
  "trigger": { "http": { "method": "GET" } },
  "steps": [
    {
      "id": "fetch",
      "use": "@blokjs/api-call",
      "inputs": { "url": "https://countriesnow.space/api/v0.1/countries" }
    },
    {
      "id": "route",
      "branch": {
        "when": "$.req.query.kind",
        "then": [
          { "id": "respond", "use": "@blokjs/respond", "inputs": { "body": "$.state.fetch" } }
        ],
        "else": [
          { "id": "fallback", "use": "@blokjs/api-call",
            "inputs": { "url": "https://catfact.ninja/fact" } }
        ]
      }
    }
  ]
}
```

### Editor support

The Blok VS Code extension ships a generated JSON Schema at
`packages/vscode-extension/schemas/workflow.schema.json` that matches
this shape exactly — every field has its description inline. Use the
extension or wire the schema into `json.schemas` settings to get
autocomplete + inline docs in any editor.

---

## Migration from v1

### Automatic (recommended)

```bash
blokctl migrate workflows                # converts every JSON workflow under ./workflows/json
blokctl migrate workflows --dry-run      # preview without writing
blokctl migrate workflows --no-backup    # skip .bak snapshots
blokctl migrate workflows --strip-legacy-path  # drop the URL preservation
```

What the migrator does:
- `steps[].name` → `steps[].id`
- `steps[].node` → `steps[].use`
- `nodes[stepName].inputs` → inlined onto the step
- `nodes[stepName].conditions` → `step.branch: { when, then, else }`
- `set_var: true` → dropped (now default)
- `set_var: false` → `ephemeral: true`
- `method: "*"` → `"ANY"`
- Injects `trigger.http.path = "/<filename-key>"` so existing consumers keep working at the legacy URL.

Backups land at `<name>.json.bak`. TS workflows are not migrated automatically — convert them manually using the v2 examples above.

### Manual (TS workflows)

Replace:

```ts
// Old
import { type Step, Workflow, AddIf, AddElse } from "@blokjs/helper";
const step: Step = Workflow({ name: "...", version: "1.0.0" })
  .addTrigger("http", { method: "GET", path: "/" })
  .addStep({ name: "fetch", node: "@blokjs/api-call", type: "module", inputs: {...} })
  .addCondition({
    node: { name: "router", node: "@blokjs/if-else", type: "module" },
    conditions: () => [
      new AddIf('ctx.request.query.kind === "a"').addStep({...}).build(),
      new AddElse().addStep({...}).build(),
    ],
  });
export default step;
```

with:

```ts
// New
import { workflow, branch, $ } from "@blokjs/helper";
export default workflow({
  name: "...",
  version: "1.0.0",
  trigger: { http: { method: "GET" } },
  steps: [
    { id: "fetch", use: "@blokjs/api-call", inputs: {...} },
    branch({
      id: "router",
      when: '$.req.query.kind === "a"',
      then: [{...}],
      else: [{...}],
    }),
  ],
});
```

---

## Backward compatibility

Zero hard breaks at v2 launch. Every legacy pattern is normalized at
workflow load time and continues to run. Deprecation warnings guide
migration:

| v1 pattern | After v2 ships | After migration |
|---|---|---|
| `steps[].name` + `nodes{}` | works (normalized) | replaced by `id`+`use`+inline `inputs` |
| `set_var: true` | no-op (default) | removed |
| `set_var: false` | translated to `ephemeral: true` | replaced |
| `js/ctx.vars[...]` | works (`vars` aliases `state`) | replaced by `$.state.x` |
| `js/ctx.response.data` | works (`response` aliases `prev`) | replaced by `$.prev.data` |
| `method: "*"` | works + warn | rewritten to `"ANY"` |
| URL `/<key>/<path>` | works only without `BLOK_FILE_BASED_ROUTING=true` | URLs from file location or explicit `path` |
| `addCondition + new AddIf().build()` | works (normalized to branch) | replaced by `branch({...})` |
| Direct `ctx.vars[k] = v` in node | works (state mutable) | discouraged in docs; works |

---

## Implementation references

- [`core/workflow-helper/src/components/workflowV2.ts`](../core/workflow-helper/src/components/workflowV2.ts) — `workflow()` factory
- [`core/workflow-helper/src/components/branch.ts`](../core/workflow-helper/src/components/branch.ts) — `branch()` primitive
- [`core/workflow-helper/src/proxy/$.ts`](../core/workflow-helper/src/proxy/$.ts) — typed `$` proxy
- [`core/workflow-helper/src/types/StepOpts.ts`](../core/workflow-helper/src/types/StepOpts.ts) — `V2StepSchema`, `V2BranchStepSchema`
- [`core/workflow-helper/src/types/WorkflowOpts.ts`](../core/workflow-helper/src/types/WorkflowOpts.ts) — `WorkflowV2Schema`
- [`core/runner/src/workflow/PersistenceHelper.ts`](../core/runner/src/workflow/PersistenceHelper.ts) — single source of truth for `state[id]` / `as` / `spread` / `ephemeral`
- [`core/runner/src/workflow/WorkflowNormalizer.ts`](../core/runner/src/workflow/WorkflowNormalizer.ts) — v1 → v2 shape converter at the load entry point
- [`triggers/http/src/runner/scanWorkflows.ts`](../triggers/http/src/runner/scanWorkflows.ts) — recursive directory scanner with `[id].json` → `:id` derivation
- [`triggers/http/src/runner/WorkflowRouter.ts`](../triggers/http/src/runner/WorkflowRouter.ts) — route table builder with collision detection
- [`packages/cli/src/commands/migrate/workflows.ts`](../packages/cli/src/commands/migrate/workflows.ts) — migration command
