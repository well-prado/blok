# Blok as a pattern: packages, example app and experiments

Spec-stage material, started 2026-11-21. It tests one idea: that Blok can be a small pattern you apply inside any stack, with one folder per node so that parallel branches never collide.

How a whole app is put together from features that share no file, so that many agents can build it at once without regressing each other, is on one page in [LEGO.md](LEGO.md).

Since phase 1 of [PLAN.md](PLAN.md) this folder holds two installable packages and an example app that uses them. Phase 3 added what starts a workflow besides an HTTP request: a schedule, a queue, a signed webhook and a tool for AI agents. Phase 4 added a second language: the same pattern in Python, on one page in [PATTERN.md](PATTERN.md), with shared tests that both kernels pass.

| Folder | Is |
|---|---|
| `packages/kernel/` | `@blokjs/kernel`: the runtime you call from your own server, with a small adapter each for Fastify, Hono, Express, schedules, queues and tools for agents. The core has no dependencies. |
| `packages/cli/` | `blokctl` 3.0.0-next.0: 15 commands, from `init` to `mcp`. Development only. |
| `python/` | `blok-kernel` 3.0.0a0: the same runtime in Python, with Pydantic for contracts and adapters for FastAPI, schedules, queues and tools for agents. |
| `conformance/` | The shared tests: JSON files that say what a kernel must do. The TypeScript kernel and the Python kernel run the same ones. |
| `prototype/` | The example app: 17 nodes and 12 workflows, built on the two packages. |
| `e2e/` | A run from an empty folder to a server that answers, with the packages installed as packed tarballs. It runs on each of the three servers, and once in Python with no Node on the machine's PATH. |
| `factory/` | The AI loop run for real: one design agent, then one build agent per node on its own branch, then every branch merged. |
| `merge-experiment/` | 16 branches, two layouts, real git merges, written by a script. |

Both packages are marked `private` so nothing can publish them by accident. Nothing here is published.

How the workflow format got here, all on the same day:

1. A flow written in code. Rejected by the owner: it is an ordinary endpoint handler. Removed in phase 1, when the kernel got tests of its own.
2. A new JSON format built on `{"$ref": ...}` objects. Rejected. Removed.
3. The original Blok JSON workflow, from `deskree-inc/blok`, modernized: a step carries its node and its inputs in one place. Accepted.
4. The same structure written in Pkl, with typed steps generated from the node contracts. The owner asked for this to be the default. This is what the folder holds now.

The first design write-up is an Artifact that is private to the repo owner: https://claude.ai/artifact/XWRmUMEa49bBFSn7YKcv7Z. It still describes attempt 1.

This folder is outside the workspace on purpose. The monorepo's build, test and publish scripts do not touch it. Biome does lint it.

## Workflows are written in Pkl

A workflow is a list of steps. A step names a node and gives it its inputs. A step is declared once with `local`, so later steps can read its result through typed references, and `steps` lists the order they run in.

```pkl
amends "blok/Workflow.pkl"

import "blok/billing.pkl"
import "blok/orders.pkl"

name = "Checkout"
version = "1.0.0"

trigger {
  http = new {
    method = "POST"
    path = "/orders"
    errors { ["card_declined"] = 402 }
  }
}

local order = new orders.ValidateOrder {
  name = "order"
  inputs {
    customerId = "${request.body.customerId}"
    items = "${request.body.items}"
  }
}

local price = new orders.PriceOrder {
  name = "price"
  inputs { items = order.outputs.items }
}

local flag = new orders.FlagVip {
  name = "flag"
  `if` = price.outputs.totalCents.gt(10000)
  inputs { customerId = order.outputs.customerId }
}

local charge = new billing.ChargeCard {
  name = "charge"
  inputs {
    orderId = order.outputs.orderId
    amountCents = price.outputs.totalCents
    token = "${request.body.token}"
  }
  onError {
    new orders.ReleaseStock {
      name = "release"
      inputs { orderId = order.outputs.orderId }
    }
  }
}

steps {
  order
  price
  flag
  charge
}

result {
  orderId = order.outputs.orderId
  receiptId = charge.outputs.receiptId
}
```

These files make it work. `blokctl` writes all of them, and git ignores all of them, so no two branches ever edit one:

| File | Is |
|---|---|
| `workflows/blok/Workflow.pkl` | The schema. Its source is `packages/cli/assets/Workflow.pkl`. |
| `workflows/blok/<module>.pkl` | The typed steps for one node module: `nodes/billing/` becomes `billing.pkl`, and a workflow writes `billing.ChargeCard`. Generated from the node contracts. |
| `workflows/blok/workflows.pkl` | A typed step for every workflow, such as `workflows.Checkout`, for using one workflow as a step in another. Generated from what each workflow reads and answers with. |
| `.blok/workflows/*.json` | The JSON the server loads. A runner in another language reads these. |

### How a node is named in a workflow

A node is written by its module and its name. The owner chose this on 2026-11-21, so that a node's name never depends on which other nodes exist.

| Node | Import | Step |
|---|---|---|
| `billing/charge-card@1` | `import "blok/billing.pkl"` | `billing.ChargeCard` |
| `billing/charge-card@2` | the same file | `billing.ChargeCardV2` |
| `user-accounts/create@1` | `import "blok/userAccounts.pkl"` | `userAccounts.Create` |
| `shop/cart/add@1` | `import "blok/shop/cart.pkl"` | `cart.Add` |
| The workflow `place-order.pkl` | `import "blok/workflows.pkl"` | `workflows.PlaceOrder` |

`blokctl list` prints the step name beside every node, and `list --json` gives the import too.

Two things follow from this:

- A step variable cannot have the name of a module the file imports. With `import "blok/billing.pkl"`, write `local charge = ...`. `local billing = ...` is refused by Pkl as a duplicate definition, with the line.
- A node module cannot be called `workflow` or `workflows`, and two modules cannot differ only by a hyphen. `blokctl check` says so.

Before this, every node was in one `nodes.pkl`, and two nodes with the same name in different modules renamed each other.

The server never runs Pkl. `blokctl build` evaluates the `.pkl` files, runs the check, and writes the JSON. `blokctl dev` does that on every change and restarts the server.

A workflow can also be a `.json` file written by hand in the same folder. It goes through the same check and the same build, and needs no Pkl at all.

### What the types catch

Pkl checks a file when it is evaluated. The table says where each mistake is caught. Every row is covered by a test in `workflows/pkl.test.ts` or `workflows/workflows.test.ts`.

| Mistake | Caught by |
|---|---|
| An input the node does not take, or a required one left out | Pkl |
| A literal of the wrong type, such as `amountCents = "12"` | Pkl |
| A literal outside an enum, such as `lane = "courrier"` | Pkl |
| A node that does not exist, such as `billing.ChargeCrd` | Pkl |
| A misspelled key, a malformed condition, an HTTP status that is not an error | Pkl |
| A result field that does not exist | Pkl. The load-time check when it is written as a string, `"${order.itemz}"`. |
| A string result wired into a number input | Pkl. The load-time check when it is written as a string. |
| `>` used on a value that is not a number | Pkl. The load-time check when it is written as a string. |
| Reading a field off a step that produces a list | The load-time check |
| Reading a step that may have been skipped | The load-time check |
| `${prev}` where there is no single previous step | The load-time check |

### Pointing at an earlier result

Typed references are the house style. The owner chose them on 2026-11-21, because they are what the editor can check.

| Write | Means | Kind |
|---|---|---|
| `price.outputs.totalCents` | One field of the step's result | The field's own kind: `IntRef`, `StringRef`, `BoolRef`, `ListRef`, `ObjectRef` |
| `order.value` | The step's whole result | `AnyRef` |
| `price.outputs.totalCents.gt(10000)` | A condition. Numbers have `gt`, `gte`, `lt`, `lte`. Everything has `eq` and `ne`. | `Condition` |
| `catalog.outputs.complete` | A boolean field, used as a condition as it is | `BoolRef` |

They render to the same `"${price.totalCents}"` strings in the generated JSON.

A placeholder string is still how you read something that has no type yet. The load-time check verifies these:

- The request: `"${request.body.token}"`, `"${request.query.countries} == 'true'"`.
- The current element inside `each`: `"${item.sku}"`.
- The error inside `onError`: `"${error.code}"`.
- Text with a value in it: `"feedback:${request.body.id}"`.

Two things to know when writing them:

- A `local` cannot have the name of an input it is used in. Inside `inputs { lines = ... }`, the name `lines` means the input itself. `quote.pkl` calls its step variable `pricedLines` for this reason.
- A step with `each` produces a list, so use its `value`. Reading `outputs` on it passes Pkl, and the load-time check refuses it.

### In the editor

Pkl's VS Code extension underlines most of these mistakes as you type. It runs the Pkl language server, which analyses the file without evaluating it.

Setup, as done on the owner's Mac on 2026-11-21:

```bash
brew install pkl openjdk
gh release download 0.24.0 --repo apple/pkl-vscode --pattern '*.vsix'
code --install-extension pkl-vscode-0.24.0.vsix
```

The extension is not in the marketplace, and it needs Java 22 or higher to run the language server. Homebrew's `openjdk` is not put on the `PATH`, so VS Code's user settings point at it:

```json
{
  "pkl.lsp.java.path": "/opt/homebrew/opt/openjdk/bin/java",
  "pkl.cli.path": "/opt/homebrew/bin/pkl"
}
```

What the language server reported when it was run directly on probe files (extension 0.24.0, Java 27). The VS Code window itself was not looked at:

| Mistake | Underlined | Message |
|---|---|---|
| An input the node does not take | Yes | Unresolved property `orderID` |
| A literal of the wrong type, `amountCents = "12"` | Yes | Constraint violation, quoting the placeholder pattern |
| A literal outside an enum, `lane = "courrier"` | Yes | Constraint violation, quoting the placeholder pattern |
| A node that does not exist | Yes | Unresolved reference `ChargeCrd` |
| A misspelled key on a step | Yes | Unresolved property `nam` |
| A condition that is not one | Yes | Constraint violation |
| An HTTP status that is not an error | Yes | Constraint violation. Required: isBetween(400, 599) |
| Typed reference: a result field that does not exist | Yes | Unresolved reference `itemz` |
| Typed reference: a string wired into a number input | Yes | Type mismatch. Required: IntIn Actual: StringRef |
| Typed reference: `.gt()` on a string | Yes | Unresolved reference `gt` |
| A syntax error | Yes, in three of four tries | Invalid syntax |
| A required input left out | No | `blokctl check` reports it |
| A wrong placeholder inside a string, `"${order.itemz}"` | No | The load-time check reports it |

The ten example workflows produced no diagnostics, so there are no false alarms on valid files.

This was run again after steps became `<module>.<Node>`. Nothing was underlined on the ten workflows, and five planted mistakes were all underlined: a misspelled node, a node taken from the wrong module, an import of a module that does not exist, a result field that does not exist, and a string wired into a number.

The typed steps in `workflows/blok/` have to exist for the editor to resolve `billing.ChargeCard`. Run `blokctl check` once after cloning. `blokctl dev` keeps them fresh while you work.

## The AI loop

An app is built in two passes, and the tool has a command for each step. Phase 2 of [PLAN.md](PLAN.md) built these.

| Step | Who | Command |
|---|---|---|
| Get the brief for designing an app | The person | `blokctl prompt design` |
| Write ports, node contracts, tests and workflows. No logic: every node is `run: todo` | One design agent | `blokctl new node`, `blokctl new workflow`, `blokctl check` |
| Write down what every node promised | The design agent | `blokctl lock` |
| See what is left to write | Whoever runs the agents | `blokctl status --json` |
| Get the brief for one node | Whoever runs the agents | `blokctl prompt build <node>` |
| Write one node, in its own folder, on its own branch | One build agent per node, all at once | `blokctl check <node>` says when it is done |
| Merge every branch and check the whole app | Whoever runs the agents | `blokctl check --tests`, `blokctl build` |

Three things keep the build agents out of each other's way:

- **One folder each.** A build agent changes files in its node's folder and nowhere else.
- **`contract.json`.** `blokctl lock` writes it beside each node: its input, its output and its errors, as JSON Schema. From then on `blokctl check` refuses a node that differs from it, so an agent cannot make its job easier by changing what the rest of the app relies on. A contract changes by `blokctl new version`. It is one file per node, so it never causes a merge conflict.
- **The test is written first.** The design agent writes each node's test. The build agent's job is to make it pass.

`blokctl mcp` serves `list`, `show`, `status`, `check` and `prompt` as tools over the Model Context Protocol, for an agent that works through tools instead of a terminal. The test drives it with the official MCP client.

`factory/factory.ts` runs the loop on real git branches. `start` makes an app in its own repository with the two packages installed. `fan-out` commits the design and gives every empty node a branch and a worktree. `join` commits each agent's work, records any file changed outside its folder, merges every branch, and runs the checks.

### The pilot run

Run on 2026-11-22: one design agent, then one build agent for each of the 10 nodes it designed, all on Claude Opus. The app is a lending library with five endpoints. It is in `.blok/factory/pilot/app`, in a git repository of its own, with `report.json` beside it.

| Measured | Result |
|---|---|
| Nodes designed, each with a locked contract and a failing test | 10, in 3 modules, with 5 workflows and 27 tests |
| Nodes whose gate passed on the build agent's first try | 10 of 10 |
| Build agents that changed a file outside their folder | 0 of 10 |
| Branches merged, one at a time | 10 clean, 0 conflicts |
| After merging: `blokctl check --tests`, `blokctl build`, and the TypeScript compiler | All pass, with 32 tests |
| The merged app over HTTP | All five endpoints answer, and every error has the status its workflow gave it |

What it cost: about 169,000 tokens and 8 minutes for the design agent, and about 96,000 tokens and 20 to 60 seconds for each build agent. That is about 1.13 million tokens in all. A build agent made 4 to 10 tool calls, so most of its tokens were its starting context, not the work.

Every agent was asked to list what was wrong or missing in its instructions. Those lists changed the tool:

| An agent reported | What changed |
|---|---|
| An error with no status in the trigger quietly became a 500 | `blokctl check` now refuses a workflow that leaves one out. It found 4 such gaps in this folder's own example workflows |
| A bare `blokctl` on this machine ran a globally installed 2.x | The briefs and the rules page say `npx blokctl` or `bunx blokctl`, the project's own copy |
| 7 of 10 could not tell whether the gate checks types | `blokctl check <node>` now runs the project's TypeScript compiler on the node's folder |
| A step variable named `open` gave a raw Pkl error | The rules page lists the words Pkl keeps for itself |
| Nothing showed how to test an error | The rules page and the test template show it |
| A shared `ports` object leaks data between tests | The scaffold exports `memoryPorts()`, and tests call it for a fresh set |
| A check and the write it protects were designed as two steps | The design brief and the rules page say they belong in one node |
| `run workflows/add-book` was refused while `add-book` worked | Both work now |

One bug was mine and was caught by not trusting a report. The first `join` said 9 nodes were still empty while 10 agents said they were done. The join script had misread git's output and committed nothing. The agents' work was intact, and the numbers above are from the corrected script.

### The full-size run

Run on 2026-11-22, with the tool as the pilot left it: one design agent, then 16 build agents at once, all on Claude Opus. The app is the back end of a small online shop with 13 endpoints: customers, a catalog, coupons, a cart, and orders with checkout, shipping and cancelling. It is in `.blok/factory/full/app`, with `report.json` and `drive.ts` beside it.

| Measured | Result |
|---|---|
| Nodes designed, each with a locked contract and a failing test | 28, in 8 modules, with 13 workflows and 68 tests |
| How the nodes were dealt out | 12 agents wrote 2 nodes each, 4 wrote 1 |
| Nodes whose gate passed on the build agent's first try | 28 of 28 |
| Build agents that changed a file outside their folders | 0 of 16 |
| Branches merged, one at a time | 28 clean, 0 conflicts |
| After merging: `blokctl check --tests`, `blokctl build`, and the TypeScript compiler | All pass, with 71 tests |
| The merged app over HTTP | 47 of 47 checks pass, on the first attempt |

The HTTP checks include the hard path. A declined card answers 402, and the stock that an earlier step took is given back by a node another agent wrote. A coupon takes 10% off 7,500 cents and the order totals 6,750. A shipped order cannot be cancelled, and a cancelled one gets its stock back.

What it cost: about 219,000 tokens and 13 minutes for the design agent, and about 1.63 million tokens for the 16 build agents, each of which finished in 16 to 39 seconds. That is about 1.85 million tokens in all. A node cost about 58,000 tokens here against 96,000 in the pilot, because an agent that writes two nodes pays for its starting context once.

What the agents reported this time, and what changed:

| An agent reported | What changed |
|---|---|
| The example node and the example test in the rules page did not agree with each other | They agree now, and the page says they are only an example |
| Nothing said whether `run` gets its input already checked, or what happens to an extra field | The rules page says both |
| The gate said "its tests pass" without saying how many | It says the number |
| `check --tests` did not check types | It does now |
| The rules page said every mistake is reported as a full sentence | It now says a mistake Pkl finds is reported in Pkl's words, one at a time |

What they found that is not fixed is in "What this is not" below.

## The format, in detail

The generated JSON keeps the feel of the original Blok workflow. What changed from the original:

| Original | Now | Why |
|---|---|---|
| `${ctx.request.body.id}` | `${request.body.id}` | `ctx.` carried no information. |
| `js/ctx.response.data`, `js/ctx.vars['x']`, `"set_var": true` | `${x.field}`, or `${prev}` for the previous step | One way to read a result. Every step's result is readable by the step's name. |
| `js/` strings holding any JavaScript | Gone. Only a path may sit inside `${ }`. | Nothing in a workflow is evaluated as code. Logic lives in a node. |
| `"condition": "ctx.request.query.countries === \"true\""` | `"if": "${request.query.countries} == 'true'"` | A condition compares one value: `==`, `!=`, `>`, `>=`, `<`, `<=`. There is no `&&` or `||`. |
| `"type": "module"` on every step | Gone | Where a node runs is not the workflow's business. |
| `@nanoservice-ts/api-call` | `http/api-call@1` | `<module>/<node>@<version>` is the folder the node lives in. |
| A step in `steps`, and its `inputs` in a separate `nodes` block | `inputs` sits in the step | A step is defined in one place. |
| `conditions` hidden in `nodes`, behind an if-else step | `conditions` sits in `steps` | The step list shows the branching. |
| Routing by method inside `conditions` | One workflow per route | The trigger routes. |
| Wrong references fail when a request hits them | Checked when the workflow loads | The check reads the node contracts. |

What a step can carry besides `name`, `node` and `inputs`:

| Key | Meaning |
|---|---|
| `if` | Run this step only when the condition holds. |
| `each` | Run this step once per element. Inputs read the element as `${item}`. The result is the list of results. `concurrency` bounds how many run at once. |
| `onError` | Steps to run when this step fails. They can read `${error.code}`. The workflow still fails afterwards. |

Two blocks can sit in a list of steps: `Conditions` (a list of `If` branches with an optional `Else`) and `Parallel`.

What a placeholder can read:

| Root | Is |
|---|---|
| `request` | What the workflow was started with. Every way of starting it gives it a `body`. Only an HTTP request also has `query`, `params`, `headers` and `method`. A workflow used as a step receives its inputs as `request.body`. |
| A step name | That step's result. |
| `prev` | The result of the step that ran just before. |
| `item` | The current element, inside a step with `each`. |
| `error` | `code`, `message` and `node`, inside `onError`. |
| `env` | Environment values the host passes in. |

A string that is one placeholder and nothing else keeps the value's type. `"${order.items}"` is the list. `"feedback:${request.body.id}"` is text.

The workflow's answer is the `result` block. Left out, the workflow answers with the result of the last step that ran.

### Loops and branches

The rule: the workflow loops over data it already has. A node loops when it has to find out when to stop.

| You want | Write | Status |
|---|---|---|
| For each item, run one node | `each` on the step | Built: `quote.pkl` |
| For each item, run several steps | `each` on a step whose `node` is another workflow | Built: `fulfil-batch.pkl` |
| Several at a time | `concurrency = 4` next to `each` | Built |
| Switch | `Conditions` with one `If` per case and an `Else` | Built: `fulfil.pkl`. The first branch that holds wins. |
| Run steps at the same time | `Parallel` | Built: `place-order.pkl` |
| Retry a step | `retries` on the node's contract | Built in the kernel, only for nodes marked idempotent |
| Loop until something is true: paging, polling | Inside a node | Built: `catalog-sync.pkl`, where `http/fetch-pages@1` pages inside the node |
| Repeat N times | A node, or `each` over a list a node produced | No syntax of its own |

There is no `while`, no counting `for`, and no separate `switch` key. The owner decided on 2026-11-21 that until-style loops stay inside nodes.

### Failing well

The two agent runs found five places where the format fell short of common practice for a backend. The owner asked on 2026-11-22 for each to follow that practice, and each was changed.

| Practice | Write | Before |
|---|---|---|
| A create answers 201 | `status = 201` in the trigger, beside `method` and `path` | Every success was 200 |
| Every error is documented | `errors: { card_declined: "The provider refused the card." }` on the node. It reaches `show`, the build brief and `contract.json` | A bare list of codes |
| A guard refuses early, in the orchestration | `new Fail { fail = "order_not_paid"; if = ...; message = "..." }` in the steps | A node whose only job was to say no |
| A later failure takes back what was done: compensation, as in the saga pattern | `undo { ... }` on a step. Undo steps run when a later step fails, the newest first, and the workflow still fails with that step's error | Only `onError`, which covers the step it is on |
| Types are checked all the way through | Nothing to write. The check compares a step's result with the next step's input into the fields of an object and the items of a list, and says when a value may be null or missing | Only the outermost kind was compared |

```pkl
local charge = new billing.ChargeCard {
  name = "charge"
  inputs { token = "${request.body.token}"; amountCents = total.outputs.totalCents }
  undo {
    new billing.RefundPayment {
      name = "refund"
      inputs { paymentId = charge.outputs.paymentId }
    }
  }
}

steps {
  new Fail { fail = "cart_is_empty"; `if` = cart.outputs.lineCount.eq(0); message = "The cart is empty." }
  charge
  order
}
```

If `order` fails here, `refund` runs and the caller gets `order`'s error. `onError` is still there for the other case: steps to run when the step it is on fails.

What each does and does not do:

- **`undo` is best effort.** An undo step that fails is logged and the others still run. Nothing is stored, so a server that dies half-way undoes nothing.
- **A step with `each` that fails part-way is not undone by its own `undo`**, because it never finished. A node that must be all or nothing takes the whole list in one call.
- **Steps that run in `parallel` are all left to finish before anything is undone**, so a step that was still running is taken back too.
- **A `Fail` code is an error like any other.** It needs a status in the trigger, and a workflow that uses this one as a step has to give it one too.
- **A condition still compares one value.** A `Fail` cannot say "the list is empty": the node that makes the list answers with its length.

The deep check found a real mistake in this folder's own example app the first time it ran: `orders/validate-order` answered quantities as any number, and `orders/price-order` takes whole numbers. It found nothing in the two apps the agents built.

### What starts a workflow

A workflow's `trigger` says what starts it from outside. It may have one of each kind, and a workflow with none is only a step in other workflows.

| Trigger | Starts the workflow | The workflow reads |
|---|---|---|
| `http` | On a request to its route | `request.body`, `query`, `params` and `headers` |
| `http` with a `signature` | The same, after the request's signature is checked. A request that fails the check gets a 401 and nothing runs | The same |
| `cron` | On a schedule | The `body` written in the trigger |
| `queue` | Once per message | The message, as `request.body` |
| `mcp` | When an AI agent calls it as a tool | The tool's arguments, as `request.body` |

```pkl
trigger {
  http = new {
    method = "POST"
    path = "/webhooks/payments"
    status = 202
    signature = new { scheme = "standard"; secret = "PAYMENTS_WEBHOOK_SECRET" }
  }
}

trigger { cron = new { schedule = "0 2 * * *"; body { region = "eu" } } }

trigger { queue = new { name = "orders.paid"; concurrency = 4 } }

trigger { mcp = new { tool = "quote_order" } }
```

Nobody declares what a tool takes. It is the request body the check already works out from the node inputs the workflow wires it into, and the same shape is the body of the route in the OpenAPI file.

Each kind is served by one small file in the kernel, and the app calls it where it starts:

```ts
import { loadApp } from "@blokjs/kernel";
import { startCron } from "@blokjs/kernel/cron";
import { blokFastify } from "@blokjs/kernel/fastify";
import { startQueues } from "@blokjs/kernel/queue";

const blok = await loadApp({ dir: import.meta.dirname, ports, env: process.env });
await app.register(blokFastify, blok);      // every http trigger. Hono: app.route("/", await blokHono(blok))
await startCron(blok);                       // every cron trigger
await startQueues(blok, { subscribe });      // every queue trigger. `subscribe` connects your broker
```

`loadApp` loads the project once. The one-line form, `app.register(blokFastify, { dir, ports })`, still works for an app that only serves HTTP. Tools are served by `blokMcp(blok, { name, version })`, which returns a server from the official MCP library, so it speaks whatever transport you connect it to.

What the check knows about triggers:

- **A schedule's body has everything the steps need.** Nobody sends a schedule anything, so a required field that is not in the trigger's `body` is a problem, and so is one of the wrong kind.
- **A schedule can be read and happens.** `0 25 * * *` is refused, and so is `0 0 31 2 *`, which reads fine and never happens.
- **Only HTTP has a query, path parameters and headers.** A workflow with another trigger that needs one of them is a problem.
- **A tool has a description.** It is how an agent chooses a tool.
- **A route, a queue and a tool name each belong to one workflow.** Two agents each adding a workflow can pick the same one, and the second is refused.
- **A signature needs a body.** A signed `GET` is refused.

What each does and does not do:

- **A query string, a path parameter and a header arrive as text.** Where the node asks for a number, true/false or a list, text that reads as one becomes one. `?page=2` reaches the node as the number 2. Text that does not read as one is left alone, and the node refuses it with a 400. Before phase 3, `?page=2` was refused by a node that asked for a number.
- **A signature is an HMAC-SHA256 of the body as it arrived.** Four schemes: `standard` (Standard Webhooks), `stripe`, `github`, and `hmac` with a header you name. The first two also carry a time, and a request more than five minutes old is refused. `secret` names an environment variable, and an app that lacks it refuses to start.
- **A failure nobody planned for answers 500 with no detail.** What was thrown goes to the server's log. Before phase 3 the caller got the message of whatever was thrown.
- **The three servers give the same answers.** One test sends the same twelve requests to Fastify, Hono and Express and compares status and body.
- **A schedule runs inside the app, in UTC unless it names a time zone.** A run that is still going when the next one is due is not joined by a second one. An app that runs as several copies starts its schedules in one of them, or every copy runs every job.
- **A queue hands a message over at least once.** A message the workflow refuses, because it lacks a field or a step fails with a business error, is not handed over again. A failure of the machine's is. The queue itself is yours: `subscribe(queue, handle, { concurrency })` is the one function that connects a broker. `memoryQueue()` is a queue inside the process, for development and tests.
- **A tool call that is refused tells the agent why**, with the error code and its message. What breaks inside goes to the log.
- **`blokctl build` writes `.blok/openapi.json`**, an OpenAPI 3.1 description of every route: its parameters, its body, what it answers with, and each error with its status and the sentence its node wrote for it. `blokctl openapi` prints the same.

### The examples

| File | Shows |
|---|---|
| `countries.pkl` | The original example: one step |
| `countries-vs-facts.pkl` | The original example: `Conditions`, and the answer is whichever step ran |
| `feedback-create.pkl`, `feedback-list.pkl` | The original `feedback.json`, split by route |
| `checkout.pkl` | `if` on a step, `onError`, `result` |
| `quote.pkl` | `each` with `concurrency`, and `${prev}`. Also a tool for agents: `quote_order` |
| `fulfil.pkl` | `Conditions` with three branches, used as a switch, and a function that writes three similar steps |
| `fulfil-batch.pkl` | `each` over a workflow: a loop whose body has several steps |
| `catalog-sync.pkl` | One step whose node loops until the feed ends, with its own limit. Started by a route and by a schedule |
| `payment-webhook.pkl` | A signed webhook that puts the event on a queue and answers 202 |
| `payment-events.pkl` | A queue trigger. Its node applies an event once, however often it arrives |
| `place-order.pkl` | Workflows used as nodes, then `Parallel` |

## A second language: Python

A Python project has the same folders, the same workflows and the same commands. What changes is the node file:

```python
from pydantic import BaseModel, Field

from blok import Ctx, node
from ports import Ports


class Input(BaseModel):
    sku: str
    qty: int = Field(gt=0)


class Output(BaseModel):
    total_cents: int


def run(input: Input, ctx: Ctx[Ports]) -> Output:
    each = ctx.ports.catalog.price_of(input.sku)
    if each is None:
        raise ctx.fail("unknown_sku", f'There is no product "{input.sku}".')
    return Output(total_cents=each * input.qty)


price = node(
    id="shop/price@1",
    description="Prices a quantity of one product.",
    input=Input,
    output=Output,
    errors={"unknown_sku": "Nothing with that name is sold."},
    run=run,
)
```

It lives at `nodes/shop/price/v1/node.py`, and a workflow writes it as `shop.Price`, exactly as it would a TypeScript node. The app is three lines on a FastAPI server:

```python
blok = load_app(Path(__file__).parent, ports=ports, env=os.environ)
app = FastAPI()
blok_fastapi(app, blok)
```

```bash
blokctl init my-api --lang python
cd my-api
uv sync
blokctl dev -- uv run python app.py
```

How the two languages meet:

- **`blokctl` reads no Python.** It asks the project's own kernel, `python -m blok contracts`, which prints every node's contract as JSON. From there on `check`, `list`, `show`, `status`, `lock`, `build`, `openapi`, `prompt` and the typed Pkl steps are the same code for both languages.
- **The check stays in one place.** The Python kernel runs workflows and does not check them. `blokctl build` does, and writes what it learned to `.blok/app.json`: the shape of the request each workflow reads, and a fingerprint of each node's contract. When the app loads, the kernel compares those fingerprints with its own nodes and refuses to start if a contract changed after the build. It names the node and says to build again.
- **`blokctl` is one file.** `bun run binary` builds it with everything inside, so a Python project needs no Node.
- **A contract means the same in both.** An input is checked as JSON, so `"5"` is refused where the model says `int`, which is stricter than Pydantic is on its own. A whole number is a whole number however Python holds it: `2.0` is written as `2`.
- **A plain `def` runs on a thread** and an `async def` on the event loop, as FastAPI does it.

The rules of the pattern are on one page, [PATTERN.md](PATTERN.md), and [conformance/README.md](conformance/README.md) says how the shared tests read and how to add a third language.

## The other terms

| Term | Meaning |
|---|---|
| Node | One capability with a contract: id, input schema, output schema, declared errors, declared effects. Reaches the outside world only through ports. |
| Port | A capability the host injects, such as a database or a payment client. |
| Contract | The language-neutral form of a node, generated as JSON Schema. The typed Pkl steps and the load-time check are both built from it. |

The path is the id: `nodes/billing/charge-card/v1` is `billing/charge-card@1`.

## What is here

```
packages/kernel/src/
  kernel.ts               node(), call, todo, contract(). The boundary every node runs through.
  workflow.ts             runs a workflow, and checks workflows against the node contracts
  project.ts              finds nodes by their folders, loads the built workflow JSON, loadApp
  schedule.ts             reads a cron schedule and works out when it next happens
  http.ts                 what the three servers share: the signature check, statuses, the JSON answer
  fastify.ts, hono.ts, express.ts
                          one call each that mounts every HTTP trigger
  cron.ts                 runs every cron trigger on its schedule
  queue.ts                runs every queue trigger once per message, and a queue for development
  mcp.ts                  serves every mcp trigger as a tool, on the official MCP library
packages/cli/src/
  analyze.ts              reads a project: nodes, Pkl and JSON workflows, typed steps, problems
  commands.ts             check, build, list
  openapi.ts              the routes as an OpenAPI 3.1 document
  inspect.ts              status and show
  lock.ts                 contract.json: what a node promised, and whether it still keeps it
  prompt.ts               the design brief and the brief for writing one node
  tests.ts                runs a node's tests with the project's own runner
  run.ts, doctor.ts       run one unit from the terminal; say what is missing on this machine
  mcp.ts                  the same facts as MCP tools, for an agent
  scaffold.ts             init, new node, new workflow, new version, and the rules page for agents
  dev.ts                  rebuild on change, restart the app on a good build
  pkl.ts, pkl-bin.ts      generates the typed steps, runs Pkl, and fetches Pkl when it is missing
packages/cli/assets/
  Workflow.pkl            the Pkl schema for a workflow
  workflow.schema.json    JSON Schema for a workflow, for hand-written JSON and for editors
  language.ts             what differs between languages: file names, and how a project is told apart
  python.ts               asks a Python project's kernel for its contracts, and what init and new write in Python
  standalone.ts, bin.ts   blokctl as one file that needs no Node
python/src/blok/
  kernel.py               node(), call, todo, contract(). The same boundary, with Pydantic models
  workflow.py             runs a workflow. It does not check one: blokctl does
  project.py              finds nodes by their folders, loads the build, refuses one made from other contracts
  http.py, fastapi.py     the signature check, statuses and the JSON answer, and the FastAPI adapter
  schedule.py, cron.py, queue.py, mcp.py
                          schedules, queues and tools for agents, as in TypeScript
  testing.py              node_beside() and call(), for a node's own test
  __main__.py             what blokctl asks: python -m blok contracts, python -m blok run
python/tests/             the shared tests, the kernel's own, and a small project they load
conformance/cases/        the shared tests, as JSON
PATTERN.md                the pattern on one page
prototype/
  blok.ts                 three lines: binds the kernel to this app's Ports type
  ports/index.ts          the port interfaces
  nodes/<module>/<node>/v1/node.ts
  workflows/*.pkl         the twelve example workflows
  app.ts                  a Fastify server with in-memory ports, its schedule and its queue
  mcp.ts                  the example's tools for agents, on standard input and output
  bench.ts                cost of the call boundary
e2e/empty-folder.ts       packs both packages, installs them into an empty folder, runs the result
e2e/empty-folder-python.ts
                          the same in Python: blokctl as one file, the kernel as a wheel, no Node on the PATH
factory/factory.ts        sets up an app, fans it out to one branch per node, and joins the branches
merge-experiment/run.py
```

## Run it

Pkl is needed for the Pkl workflows. `blokctl` uses the `pkl` on your PATH, and fetches Apple's binary when there is none.

```bash
cd specs/blok-pattern
bun install
bun run test
bun run typecheck
bun run e2e
```

`bun run test` builds both packages first, because the example app and the command-line tests use the built code. It also needs [uv](https://docs.astral.sh/uv/): it installs the Python kernel's dependencies into `python/.venv` and runs the Python tests, which the command-line tests for Python projects then use. `bun run e2e` installs from the npm registry six times, once for each pair of Bun or npm with Fastify, Hono or Express, and from PyPI once. One pair alone: `bun e2e/empty-folder.ts npm hono`. Python alone: `bun e2e/empty-folder-python.ts`.

The Python kernel on its own, and blokctl as one file:

```bash
cd specs/blok-pattern/python
uv sync
uv run pytest
uvx ruff check . && uvx ruff format --check .
```

```bash
cd specs/blok-pattern
bun run binary     # writes dist/blokctl
```

In the example app:

```bash
cd specs/blok-pattern/prototype
bun run check
bun run dev
bun run mcp        # the tools for agents, on standard input and output
```

```bash
python3 specs/blok-pattern/merge-experiment/run.py
```

The experiment builds throwaway git repositories in a temp directory and removes them when it finishes.

## What was measured

Measured on 2026-11-21 with Bun 1.3.14, Node 24.22, Pkl 0.33.1 and git 2.54 on one Mac.

- 88 tests pass: 25 for the kernel, 35 for the command-line tool, and 28 in the example app (23 for workflows loaded from Pkl, 5 for what Pkl itself refuses).
- The run from an empty folder passes twice: installed with Bun and run with Bun, and installed with npm and run with Node. In both it ends with a server answering over HTTP, in a new project and in an existing Fastify app.
- Each of the ten `.pkl` workflows evaluated to exactly the hand-written JSON file it replaced.
- All ten generated workflows validate against `workflow.schema.json`.
- The call boundary, which validates input and output and emits a span, costs about 0.7 µs per node call. It writes no trace store, so this is a floor and not a comparison with the runner.
- Merges that stopped on a conflict, out of 16 branches that each add one unit:

| Layout | Conflicted merges |
|---|---|
| Registry, new entry appended at the end | 15 |
| Registry, alphabetical insert, 3 existing entries | 13 |
| Registry, alphabetical insert, 40 existing entries | 6 |
| One folder per unit, no registry | 0 |

A single octopus merge of all 16 pattern branches was also clean. When 4 branches each created `v2` of the same node on their own, 3 of the 4 merges conflicted, so ids and version numbers have to be assigned before work fans out.

Measured on 2026-11-22 for phase 3, on the same Mac:

- 123 tests pass: 46 for the kernel, 44 for the command-line tool, and 33 in the example app.
- The run from an empty folder passes six times: Bun and npm with Node, each on Fastify, Hono and Express.
- Fastify, Hono and Express give the same status and the same body to the same twelve requests.
- The schedule reader agrees with an established cron library, croner, on 1,344 run times: 14 schedules, 4 time zones, 4 starting moments, 6 runs each.
- The signature check accepts the example GitHub publishes, read on the day. The Standard Webhooks and Stripe schemes were compared with Node's own HMAC, built the way each is documented, and not with a request from a real sender. No published Standard Webhooks example is in the tests: the ones in the Svix documentation carry a secret that a secret scanner takes for a real one.
- The official MCP client lists and calls a workflow as a tool, in memory and against `prototype/mcp.ts` running as its own process.
- An OpenAPI validator accepts the document generated for the test project and for the example app.
- The example app was started for real: a signed webhook got a 202 and the queue applied it, and the same body with a forged signature got a 401.
- 14 planted mistakes in the new code each turned at least one test red: among them a signature of any age accepted, a refused message handed over again, and two workflows on one route.

Measured on 2026-11-22 for phase 4, on the same Mac, with Python 3.12, uv 0.13, Pydantic 2.14, FastAPI 0.165 and the MCP library 2.3:

- 183 TypeScript tests pass: 98 for the kernel, 52 for the command-line tool, and 33 in the example app. 73 Python tests pass.
- Both kernels pass the same 52 shared tests, which hold 130 calls, 14 HTTP requests and 32 signature checks, and 1,344 run times of schedules taken from croner.
- A Python project runs from an empty folder: `blokctl` as one file, the kernel installed from its wheel, a node, its test and three workflows written, checked, built and run, and a FastAPI server answering. The PATH of that run holds uv, Python and Pkl, and the run first makes sure `node`, `bun`, `npm` and `npx` are not found.
- In that run the node's contract is then changed without building again. The app refuses to start, names the node and says to run `blokctl build`.
- The six TypeScript runs from an empty folder still pass.
- The official MCP client lists and calls a Python workflow as a tool, in memory.
- 39 planted mistakes in the Python kernel each turned at least one test red: among them `1` equal to `true`, text accepted as a number, a business error tried again, a 500 that says what broke, and a build loaded against changed contracts. 11 wrong expectations planted in the shared files each failed the TypeScript run.
- `blokctl` as one file is 61 MB on this Mac.

## What this is not

- Nothing is published. The run from an empty folder installs packed tarballs, and its first step, `blokctl init`, runs from this repo because `bunx blokctl@next` cannot work before a release.
- Only macOS on Apple silicon was run. Linux and Windows were not. That includes `blokctl` as one file: it was built and run for this Mac only.
- The Python kernel is not on PyPI, and the name `blok-kernel` was not looked up there. The run from an empty folder installs it from a wheel built on the spot.
- No agent has built a Python app with it. The loop of phase 2 ran in TypeScript only, and `factory/` was not run in Python.
- The example app in `prototype/` exists in TypeScript only. The Python kernel was run on the shared tests, on a small project of its own, and on the project the empty-folder run writes.
- One project is one language. A workflow cannot use a TypeScript node and a Python node together.
- A Python app must be built before it starts, with `blokctl build` or `blokctl dev`, because the Python kernel does not check workflows itself. It refuses to start on a build made from other contracts. The fingerprint that decides this depends on the JSON Schema that Pydantic writes, so a different Pydantic version on the server than where the build ran may refuse a build that is fine. That was not tried.
- In Python, `blokctl check <node>` runs the node's tests and does not check its types. A plain `def` node runs on a thread, so a port it uses must be safe to use from one.
- The Python FastAPI adapter was run with Starlette's test client and with one real server on this Mac. Tools for agents were run in memory only, not over standard input and output or HTTP.
- A Python node's field names are the names everywhere, and Python writes them `like_this`. A workflow moved from a TypeScript app to a Python one would need its field names changed.
- The download of Pkl was tested against a local server that serves this machine's own Pkl binary. The real download from GitHub was not run.
- The loop ran twice, on apps of 10 and 28 nodes, both written from scratch. It has not been run on a change to an existing app, or with a model other than Claude Opus.
- `undo` takes back finished steps when a later step fails, and that is all it is. It is best effort and keeps nothing on disk, so it is not a transaction and does not survive a crash. The two apps the agents built were designed before it existed and do not use it.
- The pilot's design splits a check from the write it protects, so two requests at the same moment can lend the last copy of a book twice. The design brief now says to keep those in one node, and the shop's design does. No check enforces it.
- The five changes under "Failing well" were made after the agent runs. They are covered by tests and by the editor check, and the two agent-built apps still pass the check with them. No agent has designed an app with them yet.
- Editor highlighting was checked by running the extension's language server on probe files, not by looking at the VS Code window.
- The branches in `merge-experiment/` are written by a script. The run with real agents is the pilot above.
- The converted original examples run against a stand-in `http/api-call@1` node and fake ports.
- Only TypeScript exists. A second language and a durable backend behind `call` are untested.
- No agent has designed an app with the phase 3 triggers. The rules page and the design brief describe them, and no run has tested whether an agent uses them well.
- `startQueues` was only run on the in-memory queue. No real broker was connected, so the `subscribe` function has not met one.
- Tools for agents were run in memory and over standard input and output. Not over HTTP, which is how a remote agent would reach them, and which needs sign-in that is not built.
- A schedule keeps nothing. A run that was due while the app was down is not made up for, and two copies of the app both run every job.
- Express was run on version 5 only. Hono was run through `@hono/node-server` on Node and on Bun, and not on Deno or on Cloudflare Workers, where nothing keeps running between requests for a schedule to live in.
- The OpenAPI file was checked by one validator. No client was generated from it.
- Text becomes a number, true/false or a list. Nothing else: a date in a query string stays text.
- The Pkl forms for the new triggers were checked by Pkl itself. The editor's language server was not run on them.
- A `cli` trigger, WebSocket and SSE are not built.
- The tests use `bun:test`. The rest of the repo uses Vitest.
