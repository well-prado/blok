# The shared tests

These files decide whether a kernel follows [the pattern](../PATTERN.md). Every kernel runs the same ones:

| Kernel | Runs them with | The test nodes |
|---|---|---|
| TypeScript | `bun test packages/kernel/test/conformance.test.ts` | `packages/kernel/test/conformance/nodes.ts` |
| Python | `cd python && uv run pytest tests/test_conformance.py` | `python/tests/conformance_nodes.py` |

## The files

| File | What it holds |
|---|---|
| `cases/call.json` | Calling one node: what is checked and in which order, what is tried again, what a failure looks like. |
| `cases/workflow.json` | Running a workflow: strings, conditions, and each kind of entry. |
| `cases/request.json` | What is refused before any step runs, and how query, path and header text becomes a number, true or false, or a list. |
| `cases/http.json` | The status and body of an answer, what goes to the log, and when a signed request is let in. |
| `cases/schedule.json` | Cron schedules: the run times that follow a moment, and the schedules that cannot be read or never happen. |

## How a case reads

```json
{
  "name": "a step reads what an earlier step produced",
  "env": { "REGION": "eu" },
  "workflows": { "sum": { "name": "Sum", "steps": [] } },
  "built": { "workflows/sum@1": { "request": {} } },
  "runs": [
    { "call": "workflows/sum@1", "input": { "body": { "a": 1 } }, "output": { "sum": 3 } }
  ]
}
```

- `workflows` are loaded beside the test nodes. The key is the file name, so `sum` is `workflows/sum@1`.
- `built` is what `blokctl build` would write to `app.json` for those workflows: the shape of the request each one reads. A kernel that does not check workflows is given this. The TypeScript run checks that it is still what the check works out.
- Each run starts with fresh ports. It names what to `call` and with which `input`, and then what must be true:

| Key | Must be true |
|---|---|
| `output` | The call answers with this. |
| `error` | The call fails with this `code` at this `node`, and with this `message` when one is given. A message a schema library writes is never given. |
| `journal` | What the nodes wrote down, in order. |
| `journalInAnyOrder` | The same, where steps ran at once. |
| `journalLacks` | Notes that were never written: steps that must not have started. |
| `spans` | One per node and workflow that ran, in the order they finished, without the time each took. |
| `logged` | The error lines written to the log. |

`http.json` has `requests` in place of `runs`: a request sent to a workflow's route, and the `status` and `body` of the answer. It also has `signatures`: a signature setting, and requests it must accept or refuse.

A secret is written as the sentence it is made from: `{ "whsecOf": "a sentence" }` is `whsec_` followed by the sentence in base64, and `{ "base64Of": "a sentence" }` is the base64 alone. No file here holds anything that reads as a real secret.

## The test nodes

A kernel writes these 14 nodes in its own language. The ports are a `journal`, a list of text, and a `counter`, a number per name.

| Node | Takes | Does |
|---|---|---|
| `test/add@1` | `a`, `b`: numbers | Answers `{ sum }`. |
| `test/greet@1` | `name`, and `greeting`, "Hello" unless given | Answers `{ text: "<greeting>, <name>!" }`. |
| `test/echo@1` | `value`: anything | Answers `{ value }`. |
| `test/typed@1` | `count`: whole number. `ratio`: number, 1. `flag`: true or false, false. `tags`: list of text, empty | Answers with the same four. |
| `test/items@1` | nothing | Answers `{ items: [{ sku: "book", qty: 2 }, { sku: "pen", qty: 5 }], total: 7 }`. |
| `test/fail@1` | `code`, and `message`, "It failed." unless given | Always fails with that code and message. It declares `out_of_stock` and `card_declined`. |
| `test/maybe@1` | `ok`, and `note`, empty unless given | Writes the note in the journal. Then answers `{ note }`, or fails with `refused` and "It was refused: <note>" when `ok` is false. |
| `test/record@1` | `note` | Writes the note in the journal and answers `{ note, position }`, counting from 1. |
| `test/flaky@1` | `name`, `failures`, and `refuse`, false unless given | Counts the call under the name. Fails with `refused` when `refuse` is true. Otherwise throws "flaky failure <count>" while the count is no more than `failures`, and then answers `{ calls }`. Idempotent, with 2 retries. |
| `test/once@1` | the same | The same, and not idempotent. |
| `test/slow@1` | `ms` | Waits that long and answers `{ slept }`. Its time limit is 40 ms. Idempotent, with 1 retry. |
| `test/wrong@1` | nothing | Promises `{ n: number }` and answers with text. |
| `test/crash@1` | nothing | Throws "the database is down". |
| `test/empty@1` | `name` | Has no logic yet. Promises `{ text }`. |

## Changing the cases

Write the case by hand, then run `bun run conformance:write`. It fills in `built` for every case and the `grid` in `schedule.json`, which is what the cron library croner answers for 14 schedules, 4 time zones and 4 starting moments. Then run both kernels.
