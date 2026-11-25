# The Blok pattern, on one page

This is what a kernel has to do, in any language. The shared tests in [conformance/](conformance/README.md) decide whether it does: the TypeScript kernel and the Python kernel both pass the same files.

How a whole app is made of such pieces, so that its features never edit the same file, is [LEGO.md](LEGO.md).

## The four things

- A **node** is a contract and the function that keeps it. Its id is `<module>/<node>@<version>`, and that is also where it lives: `nodes/<module>/<node>/v<version>/`. A node never calls another node.
- A **port** is the only way a node reaches the outside world: a database, a payment provider, a clock. The app hands the ports to the kernel when it starts.
- A **workflow** is data: a JSON file that says which nodes run, in which order, and what each is given. It holds no logic. Its id is `workflows/<file name>@<first number of its version>`.
- A **trigger** says what starts a workflow from outside: an HTTP route, a schedule, a queue or a tool for an AI agent.

## A contract

Every kernel can write a node's contract as this JSON, and `blokctl` works from nothing else:

```json
{
  "id": "billing/charge-card@1",
  "kind": "node",
  "description": "Charges a card token for an order.",
  "input": { "type": "object", "properties": { "token": { "type": "string" } }, "required": ["token"] },
  "output": { "type": "object", "properties": { "receiptId": { "type": "string" } }, "required": ["receiptId"], "additionalProperties": false },
  "errors": ["card_declined"],
  "errorMeanings": { "card_declined": "The provider refused the card." },
  "effects": ["payments"],
  "idempotent": false,
  "implemented": true
}
```

`input` and `output` are JSON Schema, draft 2020-12, each in one piece with no `$ref`. `input` is what a caller may pass, so a field with a default is optional. `output` is what comes back, so every field is required and there are no others.

## Calling a node

A kernel does these in this order, every time:

1. It checks the input against the contract, as JSON: text is not a number, `1` is not `true`, and `3.0` is a whole number. A wrong input fails with `invalid_input` and the node does not run.
2. A node with no logic yet fails with `not_implemented`. This comes after step 1, so a node that is only designed already refuses what its contract refuses.
3. It runs the node with the ports, a log, and `fail(code, message)`. `fail` gives the caller a business error. A code the contract does not declare is a bug in the node, and the caller gets `unexpected`.
4. A node that runs longer than its `timeoutMs` is stopped and fails with `timeout`.
5. It checks the output against the contract. A wrong output fails with `invalid_output`.
6. Anything else the node throws reaches the caller as `unexpected`, with the message.
7. It tries again only when the node is `idempotent`, at most `retries` more times, and only after `unexpected` or `timeout`. A business error is an answer and is never tried again.
8. It reports one span for the call: `id`, `kind`, `parent`, `key`, `attempts`, `ok`, `error`.

A failure always has three parts: a `code`, a `message` and the `node` it came from. The kernel's own codes are `invalid_input`, `invalid_output`, `not_implemented`, `timeout`, `unexpected` and four that start with `workflow_`. Every other code is one a node or a workflow declared.

## Running a workflow

```json
{
  "name": "Checkout",
  "version": "1.0.0",
  "trigger": { "http": { "method": "POST", "path": "/orders", "status": 201, "errors": { "card_declined": 402 } } },
  "steps": [
    { "name": "order", "node": "orders/validate@1", "inputs": { "items": "${request.body.items}" } },
    { "name": "charge", "node": "billing/charge-card@1", "inputs": { "token": "${request.body.token}", "amount": "${order.total}" } }
  ],
  "result": { "receiptId": "${charge.receiptId}" }
}
```

**What a step can read.** `request` (always with `body`, `query`, `params` and `headers`), `env`, every earlier step by its name, `prev` (the last step that ran), `item` inside `each`, and `error` inside `onError` and `undo`.

**Strings.** `${a.b.c}` is a path and nothing else. No code runs.

- A string that is one placeholder keeps the value's kind: `"${order.total}"` is a number.
- Text around a placeholder makes text. A number is written as JSON writes it (`2`, `1.5`, `1e-7`), and a list or an object as JSON with no spaces.
- A field that is not there is absent, not null: an input given an absent value is left out, so the node's default applies. Null and absent cannot be made into text, and reading a field of something that is not an object or a list fails with `workflow_ref`.
- `$${` is a literal `${`.

**Conditions.** `"${a.b}"` must be true or false. `"${a.b} > 100"` compares with `==`, `!=`, `>`, `>=`, `<` or `<=`. The right side is a number, `true`, `false`, `null`, a word, `'quoted text'` or another `${path}`. Equal means the same kind and the same value. The four that order need two numbers. Anything else fails with `workflow_if`.

**Entries.** A list of steps holds four kinds of entry:

| Entry | What it does |
|---|---|
| `{ name, node, inputs }` | Calls the node. Its result is readable by its name. With `if`, it runs only when the condition holds. |
| ... with `each` | Runs once per element of a list, `concurrency` at a time, 1 unless said. The result is the list of results, in the order of the list. After one failure nothing new is started. |
| ... with `onError` | Steps that run when this one fails. The workflow still fails with the same error. |
| ... with `undo` | Steps that take this one back. They run when a later step fails, the newest first. One that fails is written to the log and does not stop the others. |
| `{ conditions: [{ if, steps }, { else }] }` | The first branch that holds runs, or else the last. |
| `{ parallel: [...] }` | All of them run at once, and each is left to finish even when one fails. |
| `{ fail, message, if }` | Refuses the request with that code. |

A workflow answers with its `result`, or with the result of the last step that ran. A workflow used as a step receives the step's inputs as its request body.

**The request.** A request that lacks a field a step is certain to need is refused with `invalid_input` before any step runs. A query string, a path parameter and a header arrive as text: where the node asks for a number, true or false, or a list, text that reads as one becomes one. A body is JSON already and is left as it is.

## What the build hands a kernel

`blokctl build` checks every workflow against the contracts, then writes:

- `.blok/workflows/<name>.json`: each workflow, as above.
- `.blok/app.json`: what the check learned. For each workflow, the shape of the request it reads. For each node, a fingerprint of the contract it was checked against.
- `.blok/openapi.json`: the HTTP routes, when there are any.

Nothing half-wired may run. A kernel keeps that promise in one of two ways. It checks the wiring itself when it loads, as the TypeScript kernel does. Or it compares the fingerprints in `app.json` with its own nodes and refuses to start when they differ, as the Python kernel does.

## What a kernel answers blokctl

`blokctl` reads no language but its own. It asks the project's kernel, which prints one JSON document:

- `contracts`: every node's contract with its fingerprint, and a sentence for each node file that could not be loaded.
- `run <id> --input <json>`: runs one node or workflow from the build and prints the output or the failure, with the spans.

In Python these are `python -m blok contracts` and `python -m blok run`.

## Answering an HTTP request

- A success answers 200, or the `status` the trigger names.
- A failure answers the status the trigger's `errors` gives its code. Without one, `invalid_input` is 400 and `not_implemented` is 501. The body is `{ "error", "message", "node" }`.
- Any other failure answers 500 with `{ "error": code, "message": "The server could not complete the request." }`. What broke goes to the log.
- A route with a `signature` answers 401 unless the signature matches the body as it arrived. The schemes are `standard` (Standard Webhooks), `stripe`, `github` and `hmac`. The first two refuse a request more than five minutes old.

## Schedules

Five fields, read as crontab reads them: minute, hour, day of month, month, day of week. When both days are given, either is enough. In a time zone that moves its clocks, a time the clocks skip does not run that day, and a time they repeat runs twice.

## Adding a language

1. Write the 14 test nodes of [conformance/README.md](conformance/README.md) in the language.
2. Make the kernel pass every file in `conformance/cases/`.
3. Print the contracts and run a unit on request, as above.
4. Give `blokctl` the file names and the templates of the language, in `packages/cli/src/language.ts` and a file like `python.ts`.
