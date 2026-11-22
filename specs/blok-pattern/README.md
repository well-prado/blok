# Blok as a pattern: packages, example app and experiments

Spec-stage material, started 2026-11-21. It tests one idea: that Blok can be a small pattern you apply inside any stack, with one folder per node so that parallel branches never collide.

Since phase 1 of [PLAN.md](PLAN.md) this folder holds two installable packages and an example app that uses them:

| Folder | Is |
|---|---|
| `packages/kernel/` | `@blokjs/kernel`: the runtime you call from your own server, and a Fastify adapter. No dependencies. |
| `packages/cli/` | `blokctl` 3.0.0-next.0: 14 commands, from `init` to `mcp`. Development only. |
| `prototype/` | The example app: 15 nodes and 10 workflows, built on the two packages. |
| `e2e/` | A run from an empty folder to a server that answers, with the packages installed as packed tarballs. |
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
| `request` | The trigger's request: `body`, `query`, `params`, `headers`, `method`. A workflow used as a step receives its inputs as `request.body`. |
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

### The examples

| File | Shows |
|---|---|
| `countries.pkl` | The original example: one step |
| `countries-vs-facts.pkl` | The original example: `Conditions`, and the answer is whichever step ran |
| `feedback-create.pkl`, `feedback-list.pkl` | The original `feedback.json`, split by route |
| `checkout.pkl` | `if` on a step, `onError`, `result` |
| `quote.pkl` | `each` with `concurrency`, and `${prev}` |
| `fulfil.pkl` | `Conditions` with three branches, used as a switch, and a function that writes three similar steps |
| `fulfil-batch.pkl` | `each` over a workflow: a loop whose body has several steps |
| `catalog-sync.pkl` | One step whose node loops until the feed ends, with its own limit |
| `place-order.pkl` | Workflows used as nodes, then `Parallel` |

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
  project.ts              finds nodes by their folders, loads the built workflow JSON
  fastify.ts              one register call that mounts every HTTP trigger
packages/cli/src/
  analyze.ts              reads a project: nodes, Pkl and JSON workflows, typed steps, problems
  commands.ts             check, build, list
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
prototype/
  blok.ts                 three lines: binds the kernel to this app's Ports type
  ports/index.ts          the port interfaces
  nodes/<module>/<node>/v1/node.ts
  workflows/*.pkl         the ten example workflows
  app.ts                  a Fastify server with in-memory ports
  bench.ts                cost of the call boundary
e2e/empty-folder.ts       packs both packages, installs them into an empty folder, runs the result
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

`bun run test` builds both packages first, because the example app and the command-line tests use the built code.

In the example app:

```bash
cd specs/blok-pattern/prototype
bun run check
bun run dev
```

```bash
python3 specs/blok-pattern/merge-experiment/run.py
```

The experiment builds throwaway git repositories in a temp directory and removes them when it finishes.

## What was measured

Measured on 2026-11-21 with Bun 1.3.14, Node 24.22, Pkl 0.33.1 and git 2.54 on one Mac.

- 74 tests pass: 16 for the kernel, 30 for the command-line tool, and 28 in the example app (23 for workflows loaded from Pkl, 5 for what Pkl itself refuses).
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

## What this is not

- Nothing is published. The run from an empty folder installs packed tarballs, and its first step, `blokctl init`, runs from this repo because `bunx blokctl@next` cannot work before a release.
- Only macOS on Apple silicon was run. Linux and Windows were not.
- The download of Pkl was tested against a local server that serves this machine's own Pkl binary. The real download from GitHub was not run.
- The loop ran twice, on apps of 10 and 28 nodes, both written from scratch. It has not been run on a change to an existing app, or with a model other than Claude Opus.
- The check does not compare the fields of the items in a list, or a field that may be null. A list of the wrong things passes the check and fails at the node.
- A workflow cannot refuse a request on its own. Both designs needed a small node whose only job is to say no, such as `orders/check-cart-not-empty`.
- Steps are not a transaction. In the shop, if storing the order fails after the card was charged, nothing refunds it. The design agent listed four such gaps itself.
- The pilot's design splits a check from the write it protects, so two requests at the same moment can lend the last copy of a book twice. The design brief now says to keep those in one node, and the shop's design does. No check enforces it.
- A successful answer is always 200. A workflow cannot answer 201.
- An error code is a bare word. A node cannot attach a description to it.
- A request that lacks a field a step is certain to need is refused before any step runs. A field of the wrong kind is still caught later, by the node that needs it.
- Editor highlighting was checked by running the extension's language server on probe files, not by looking at the VS Code window.
- The branches in `merge-experiment/` are written by a script. The run with real agents is the pilot above.
- The converted original examples run against a stand-in `http/api-call@1` node and fake ports.
- Only TypeScript exists, only HTTP triggers, and only a Fastify adapter. A second language and a durable backend behind `call` are untested.
- The tests use `bun:test`. The rest of the repo uses Vitest.
