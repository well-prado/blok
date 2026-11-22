# Blok as a framework: the plan

Written 2026-11-21. This turns the prototype in `prototype/` into something a person installs and an AI can build a whole backend with.

**Phases 1, 2 and 3 are built**, and the agent run that phase 2 was defined by passed: 16 build agents, 28 nodes, no merge conflict, and a working app. Phase 1 was built the same day as this plan. It lives in `packages/` beside this file, outside the monorepo's workspace, so Blok 2.x is untouched. Both packages are marked `private` and nothing is published. Each built phase has a section, "what was built", that says what exists and where it differs from the plan. Phases 4 and 5 are still a plan.

## The short version

- **It is a library plus a CLI.** You add the library to any backend app and keep your own server. The CLI is a development tool: it scaffolds, checks and builds.
- **Workflows are written in Pkl, or in JSON by hand.** Pkl is the default. Production only ever loads JSON, so the server needs neither Pkl nor Java.
- **An AI builds an app in two passes.** One agent designs the whole app as empty nodes plus workflows, and the check proves it lines up. Then many agents fill in one node each, in parallel, in separate folders.

## What ships

| Piece | What it is | When you need it |
| --- | --- | --- |
| The pattern | One page: the folder layout, what a node declares, the workflow format, the error rules | Always. It is the same in every language |
| The library | The kernel, the workflow runner, and one small adapter each for Fastify, Hono, Express, schedules, queues and tools for agents. About 2,390 lines, of which 1,650 are the core | In your app, at run time |
| The CLI | 15 commands, from `init` to `mcp` | While developing and in CI. Never in production |

The library has no opinion about your server. Today's Blok 2.x runs your app. This one is called by your app.

## Installing it

Into an existing Fastify app:

```bash
bun add @blokjs/kernel
bunx blokctl@next init
```

`init` adds `nodes/`, `workflows/`, `ports/` and a rules page for AI agents. Then one line in your own server:

```ts
await app.register(blokFastify, { dir: import.meta.dirname, ports });
```

For a new project, `bunx blokctl@next init my-api` creates the folder with a small Fastify server already wired. `--server hono` or `--server express` wires that server instead. In an existing app, `init` reads `package.json` and prints the line for the server the app already has.

The package names are a recommendation, not a decision. See "Decisions that are yours".

### Where Pkl comes from

The CLI looks for `pkl` on the machine. If it is missing, the CLI downloads Apple's official binary at a pinned version, checks it against a checksum stored in the CLI, and caches it.

- Apple's 0.33.1 release has native binaries for Apple-silicon macOS, Linux (x64, arm64, and Alpine on x64) and Windows. Intel Macs only get the Java version: the native Intel build stopped at 0.32.2.
- A community npm package, `@pkl-community/pkl`, also carries the binary. It is at 0.30.2, three versions behind what the prototype uses, and has no Windows build. I did not try it.
- Editor highlighting needs a recent Java for the language server (the Pkl docs say 22 or newer; this machine runs it on 27). It is optional. `blokctl check` prints the same Pkl errors in the terminal with no Java.

### What a project looks like

```
my-api/
  nodes/
    billing/charge-card/v1/node.ts        one folder per node per version
    billing/charge-card/v1/node.test.ts
  workflows/
    checkout.pkl                          you write these
    blok/Workflow.pkl                     written by the CLI
    blok/<module>.pkl                     generated from your nodes, one per module, git-ignored
  ports/index.ts                          what nodes may reach: database, payments, mail
  app.ts                                  your server
  AGENTS.md                               the rules page for AI agents
  .blok/workflows/*.json                  what production loads, git-ignored
```

A workflow may also be `workflows/checkout.json`, written by hand. It goes through the same check, and `workflow.schema.json` gives JSON completion in the editor. Two files for the same workflow name is an error.

The built JSON goes to `.blok/` and not `dist/`, because many apps already build their own code into `dist/` and one would wipe the other. Blok 2.x already uses `.blok/` for generated files.

## The CLI

| Command | What it does | State |
| --- | --- | --- |
| `init` | Adds the folders and the rules page to a new or existing app | Built |
| `new node billing/charge-card` | Creates the node folder with a contract, `run: todo` and a test file | Built |
| `new workflow checkout` | Creates a Pkl workflow with an HTTP trigger, or JSON with `--json`. `--trigger cron`, `queue` or `mcp` starts it another way | Built |
| `new version billing/charge-card` | Copies `v1` to `v2` so a big change never edits the old one | Built |
| `check` | Path matches id, contracts are valid and match what was locked, Pkl types pass, every workflow lines up with its nodes. `--tests` also runs the node tests | Built |
| `build` | Turns every workflow into JSON under `.blok/`, writes `.blok/openapi.json`, and refuses to ship a node that is still empty | Built |
| `openapi` | Prints every route as an OpenAPI 3.1 document | Built |
| `dev -- <start command>` | Rebuilds on every change and restarts the app when the build is good | Built |
| `list` | The catalog: every node and workflow with what it takes and answers with. Empty nodes are marked | Built |
| `check <node>` | The gate for one node: the project lines up, the node is written, its contract is unchanged, and its tests pass | Built |
| `lock [node]` | Writes `contract.json` beside each node: what it takes, answers with and may fail with. `check` refuses a node that no longer matches | Built |
| `status` | The work queue: which nodes are still empty, untested or not locked | Built |
| `show <id>` | One node or workflow in full | Built |
| `run <id> --input '<json>'` | Runs one node or workflow from the terminal with the project's ports, and shows what ran | Built |
| `prompt design`, `prompt build <node>` | The two briefs of the AI loop: designing an app, and writing one node | Built |
| `mcp` | Serves list, show, status, check and prompt as MCP tools on stdio | Built |
| `doctor` | Says what is missing: Node, Pkl, the project's setup, the editor | Built |

The built commands take `--json`, and every problem is written as a full sentence that names the file and the fix. The prototype's check already does this: `"lines" is a list, so it has no field "sku".`

## How an AI builds an app with it

The pattern turns "build an app" into many small jobs that cannot collide. There are four steps.

### 1. Design pass: one agent, no logic

From the product spec, one agent writes:

- `ports/index.ts`, the list of outside things the app needs.
- Every node as a contract only: id, input, output, errors, and `run: todo`.
- Every workflow in Pkl.

Then it runs `blokctl check`. A green check means the whole app is wired correctly before one line of logic exists. Ids and version numbers are fixed in this pass, which removes the one conflict the merge experiment still found: two branches picking the same new version number.

### 2. Build pass: many agents, one folder each

`blokctl status --json` lists the empty nodes. Each one becomes a job like this:

```
Implement billing/charge-card@1.
Touch only nodes/billing/charge-card/v1/.
The contract in node.ts is fixed. Do not change the id, input, output or errors.
Use only what ports/index.ts offers.
You are done when `blokctl check billing/charge-card@1` passes.
```

The agent needs the contract, the ports file and the rules page. It does not need to read the rest of the app.

### 3. Join

Merge every branch, run `blokctl check` on the whole app, then run the workflow tests with real nodes and fake ports.

### 4. Change it later

A small fix edits the node. A change to what a node takes or returns is a new version folder, and workflows move to it one at a time.

### The rules page

`init` writes this for agents. A sketch:

```
1. One node, one folder: nodes/<module>/<node>/v<N>/. The path is the id.
2. A node declares its input, output and errors. It returns its output. It never reads another node.
3. A node reaches the outside world only through ports.
4. Loops that wait for something (paging, polling) live inside a node.
5. A workflow only wires nodes: steps, if, each, conditions, parallel, onError. No code.
6. A node is a step by its module and name: billing.ChargeCard. Point at an earlier step with typed references: order.outputs.items.
7. Never edit a published contract. Run `blokctl new version`.
8. Never edit generated files: workflows/blok/ and .blok/.
9. Run `blokctl check` before you say you are done.
```

## What kinds of app

The trigger decides. A trigger turns something from outside into a call to a workflow.

| App | Trigger | State |
| --- | --- | --- |
| REST API | `http` | Built, on Fastify, Hono and Express |
| Webhook receiver | `http` plus signature check | Built: four signature schemes |
| Scheduled jobs | `cron` | Built: runs inside the app |
| Background workers | `queue` | Built: you connect the broker with one function |
| Tools for AI agents | `mcp`: a workflow becomes a tool | Built, on the official MCP library |
| Command-line tools | `cli` | Planned |
| Live connections | WebSocket, SSE | Later |

Blok 2.x already has nine trigger packages, and the first plan was to wrap them as adapters. That did not happen: see "Phase 3: what was built".

Not a fit:

- Front ends.
- Flows that wait days and must survive a restart. The kernel has timeouts and retries but stores nothing.
- Tight loops over millions of items. Each node call validates its input and output.

## Other languages

The JSON is the meeting point. A node contract is JSON Schema, and a workflow is JSON. A kernel in Python or Go has to do two things: follow the same call rules, and run the same workflow JSON.

- Shared test files decide whether a kernel is correct. The repo already works this way for the 2.x SDKs in `packages/conformance` and `tests/integration/sdk-contract`.
- Each kernel prints its contracts as JSON. The CLI reads that to generate the typed Pkl steps, so it does not need to understand the language.
- The CLI ships as a single binary so a Python project does not need Node.

None of this is built. TypeScript comes first.

## Already proven

| Claim | Evidence |
| --- | --- |
| The kernel, runner, checker, command-line tool and Pkl loading work | 123 tests pass: 46 kernel, 44 command-line tool, 33 in the example app |
| It installs and runs from an empty folder | `e2e/empty-folder.ts` passes six times: Bun, and npm with Node, each on Fastify, Hono and Express. Packed tarballs, `init`, `new node`, `new workflow`, `check`, `build`, a server answering. Also in an existing Fastify app, with one `register` line |
| The three servers behave the same | One test sends the same twelve requests to Fastify, Hono and Express and compares status and body |
| A webhook is refused unless it is signed | The check accepts the example GitHub publishes, and for the other schemes a signature made with Node's own HMAC. It refuses a changed body, a wrong secret and a request older than five minutes |
| Schedules are read correctly | The reader agrees with the cron library croner on 1,344 run times in four time zones |
| An agent can use a workflow as a tool | The official MCP client lists and calls it, in memory and against a real process |
| The API is described without anyone writing the description | An OpenAPI validator accepts the generated document for the test project and for the example app |
| One folder per node removes fan-out conflicts | 16 branches: 0 conflicts with the pattern, 15 when every branch appends to a shared registry file |
| Production needs no Pkl | With `pkl` removed from the path, the 10 generated JSON files load, pass the check, and checkout answers |
| Design first works | All 10 workflows pass the wiring check with all 15 nodes replaced by empty stubs |
| The editor underlines mistakes | The Pkl language server flagged 10 of 12 planted mistakes and raised nothing on the real files |

## Phases

### Phase 1: what was built

Done on 2026-11-21. Code in `packages/kernel/` and `packages/cli/`, the example app in `prototype/`.

- `@blokjs/kernel`: the kernel, the workflow runner and check, loading a project from disk, and the Fastify adapter. No dependencies.
- `blokctl` 3.0.0-next.0: `init`, `new node`, `new workflow`, `new version`, `check`, `build`, `dev`, `list`.
- Pkl is fetched when it is missing: Apple's 0.33.1 binary, checked against a SHA-256 kept in the tool. `BLOK_PKL` points at your own, and `BLOK_OFFLINE` forbids the download.
- Workflows can be JSON written by hand.
- A workflow used as a step has a typed step: `workflows.Checkout`, in a generated `workflows/blok/workflows.pkl`.

Where it differs from the first draft of this plan:

| The draft said | What was built, and why |
| --- | --- |
| A workflow declares the shape of its request | Nobody declares it. The check works it out from the node inputs the request fields are wired into. No new syntax, and it cannot disagree with the nodes |
| | A request that lacks a field a step is certain to need is refused before any step runs. Before, a checkout with no card token ran its first two steps, failed at the charge, and then had to release the stock |
| Built JSON goes to `dist/` | It goes to `.blok/`, so it cannot collide with an app's own build |
| `init` adds editor settings | It does not. The Pkl extension is not in the VS Code marketplace, so there is nothing portable to write. This moves to `doctor` |
| `check` runs the tests | It checks the wiring only. Tests run with the project's own test command. Running them per node belongs to phase 2 |
| You pass a function that turns a schema into JSON Schema | Not needed. The kernel reads JSON Schema from the schema library itself, through Standard JSON Schema. Zod 4.2 and newer has it |
| A flow written in code is kept for the tests | Removed. The kernel has its own tests now |

Not done:

- It ran on macOS with Apple silicon only. Linux and Windows were not run.
- The real download of Pkl from GitHub was not run. The path was tested against a local server.
- `bunx blokctl@next init` cannot be tried before something is published.

Found while building it, and decided by the owner the same day:

- **A node is named by its module in a workflow.** Every node used to be in one generated `nodes.pkl`, and two nodes with the same name in different modules were both given a prefix, so adding `users/validate` renamed `orders/validate` and broke the workflows that used it. Parallel agents would have hit this. Now each node module has its own generated file and a step is `orders.Validate`, whatever else exists. A test adds a second node with the same name and checks that the first one's generated file does not change by a byte.

### Phase 2: what was built

Done on 2026-11-22, including the run it was defined by.

- `status`, `show`, `run`, `doctor`, `mcp`, `prompt design`, `prompt build <node>`.
- `lock`: a `contract.json` beside each node, and `check` refuses a node that no longer matches it.
- `check <node>`: the gate for one node. The project lines up, the node is written, its tests pass, its types check, and its contract is what was locked.
- `factory/factory.ts`: sets up an app in its own git repository, gives every empty node a branch and a worktree, deals the nodes to a number of agents, then merges every branch and checks the result.

Two runs measured the loop with real agents, all on Claude Opus. Every agent started with nothing but its brief and the rules page.

| Measured | Pilot: a lending library | Full size: an online shop |
| --- | --- | --- |
| Agents | 1 design, 10 build | 1 design, 16 build |
| Nodes, workflows, tests designed | 10, 5, 27 | 28, 13, 68 |
| Nodes that passed their gate on the first try | 10 of 10 | 28 of 28 |
| Agents that changed a file outside their folders | 0 | 0 |
| Merge conflicts | 0 in 10 branches | 0 in 28 branches |
| The merged app | Check, build, tests and types pass | Check, build, tests and types pass |
| Over HTTP | All five endpoints answer correctly | 47 of 47 checks pass, first attempt |
| Tokens | About 1.13 million | About 1.85 million |
| Tokens per node in the build pass | About 96,000 | About 58,000 |

The plan asked for "about 30 nodes" and "zero merge conflicts and a green check". The design agent made 28 nodes, and both conditions held.

Between the two runs, the agents' own lists of what was unclear led to eight changes to the tool, the briefs and the rules page. The second run led to five more. The README has both tables.

Found in the runs. The owner asked for each to follow common practice, and each was changed the same day:

| Found | Practice followed | Now |
| --- | --- | --- |
| A workflow always answered 200 | A create answers 201 | `status` in the trigger, from 200 to 299 |
| An error code was a bare word | Every error is documented | `errors: { code: "when it happens" }` on the node. It reaches `show`, the build brief and `contract.json` |
| A workflow could not refuse on its own | A guard refuses early, in the orchestration | A `Fail` entry: a code, a message and an optional condition |
| Steps were not a transaction | Compensation, as in the saga pattern | `undo` on a step: it runs when a later step fails, newest first |
| The check stopped at the top of a list | Types are checked all the way through | The check compares fields and list items, and says when a value may be null or missing |

`undo` is compensation and not a transaction: it is best effort and keeps nothing on disk. A workflow that must survive a crash half-way needs a durable engine behind `call`, which is still outside this plan.

The README section "Failing well" has the details and the limits of each.

### Phase 3: what was built

Done on 2026-11-22.

- Four more ways to start a workflow, each written in its `trigger`: `cron`, `queue`, `mcp`, and `signature` on `http` for a webhook. A workflow may have one of each.
- Adapters in `@blokjs/kernel`, each a file of its own: `/hono`, `/express`, `/cron`, `/queue`, `/mcp`, beside `/fastify`. What the three servers share is in `/http`.
- `loadApp`: loads the project once for an app that starts several things from it.
- `blokctl openapi`, and `.blok/openapi.json` written by `build`.
- `blokctl new workflow <name> --trigger cron|queue|mcp` and `blokctl init <name> --server hono|express`.
- The rules page has a section "What starts a workflow", and the design brief tells the design agent when to use each trigger.

Every way of starting a workflow hands it a `body`, the same way a workflow used as a step already got its inputs. So one workflow can have a route, a schedule and a tool name at once, and the check that already worked out the request's shape now also gives a tool its arguments and a route its OpenAPI description.

Where it differs from the plan:

| The plan said | What was built, and why |
| --- | --- |
| Wrap the 2.x trigger packages as adapters | New adapters, written for the kernel. The 2.x packages each import the 2.x runner, which the kernel replaces, so wrapping them would bring the old runner along. The 2.x cron, worker, mcp and webhook triggers are 633, 4,143, 1,102 and 986 lines. The new ones are 272 (with the schedule reader), 130, 59 and about 80 |
| A `queue` trigger | The trigger and the adapter are built. The queue itself is not: the app passes one `subscribe` function that connects its broker. A queue inside the process comes with it for development |
| An `mcp` trigger | Built on the official MCP library as an optional dependency, not on a protocol reader of our own, so it follows the protocol as it changes and speaks any transport the library has |
| | A query string, a path parameter and a header are text. Where a node asks for a number, true/false or a list, the text is now read as one. Writing the OpenAPI file showed the gap: it would have promised a number that the server then refused |
| | A failure nobody planned for used to send the caller the message of whatever was thrown. It now sends no detail and writes the message to the log |
| | Two workflows on the same route, queue or tool name are refused by the check. Two agents each adding a workflow can pick the same one |
| | In Pkl, `concurrency = 0` used to pass, because Pkl's `isPositive` lets zero through. It is refused now |

Not done:

- No agent has designed an app with these triggers. Phase 2 was proven by an agent run, and phase 3 by tests and by starting the example app.
- No real broker was connected to the queue adapter.
- Tools for agents were not run over HTTP, which needs sign-in that is not built.
- A `cli` trigger, WebSocket and SSE.
- A schedule keeps nothing: a run that was due while the app was down is not made up for, and several copies of an app each run every job.

The README section "What starts a workflow" has the format and the limits of each.

### Phase 4: a second language

- The one-page pattern and the shared test files.
- One more kernel.
- The CLI as a single binary.

### Phase 5: decide what Blok 3 is

- A tool that converts 2.x workflows.
- Studio reads and writes the workflow JSON, which is possible again now that a workflow is data.

## Decisions that are yours

1. **Is this Blok 3?** I recommend yes, published on the `next` tag as `@blokjs/kernel` and `blokctl@next`, with 2.x untouched until a real app has run on it. Two facts behind that: the npm name `blok` is taken by a 2022 package for building React websites, so `npx blok` must never appear in the docs. And `blokctl` 2.x already has `check`, `build`, `dev` and `list` with different meanings, so the new commands need a new major version or a new name.
2. **Folder layout.** The prototype uses `nodes/<module>/<node>/v1/`. You first described `nodes/v1/<module>/<node>/`. I recommend the prototype's, because a new version of one node then touches one folder. This has to be settled before `init` exists.
3. **The second language.** It sets the order of phase 4.

## Risks

- **Pkl is young.** It is still at 0.x, and 0.33.0 dropped the native Intel Mac binary. The protection is that JSON stays the real format. Pkl can be replaced without touching the runner.
- **Two things the editor does not underline.** A missing required input and a typo inside a `"${...}"` string. `blokctl check` catches both.
- **Size.** The library is about 2,390 lines and the command-line tool about 2,950. Core, triggers and CLI in 2.x are about 106,000 lines of non-test TypeScript, and they do far more. Phase 3 added about 690 lines to the library as adapters, each in its own file, and about 360 to the core, most of them in the check. The command-line tool grew by about 440.
- **Schedules in more than one copy.** `startCron` runs inside the app. Deployed as three copies, every job runs three times, and nothing in the tool warns about it. The fix belongs to the app today: start the schedules in one copy.
