# ListNodes JSON-Schema Dialect Analysis (SPIKE #364)

Follow-up to [ADR 0010](adr/0010-runtime-listnodes-schema-readiness.md). ADR 0010
answered *"does each SDK emit non-null schema bytes for a typed node?"* (yes, all
seven). This spike answers the next question: **which JSON-Schema dialect does
each SDK emit, and does `blokctl nodes sync`'s `jsonSchemaToTs` printer handle
them — or silently drop typed handles to `unknown`?**

It de-risks #367 (codegen edge-case tests) by naming the exact constructs that
need fixtures before the printer is trusted.

## Method & scope

Source-level inspection of each SDK's schema-emission path plus the schema
library it delegates to. **This spike did not boot the 7 sidecars** — booting all
seven runtime containers to capture live `input_schema_json` / `output_schema_json`
bytes is out of scope here (see *Residual* below). The dialect table is derived
from the SDK source + the documented behaviour of each schema library; the
`jsonSchemaToTs` gap analysis is **executed**: seven synthetic dialect-representative
schemas were run through the real exported printer
(`packages/cli/src/commands/nodes/syncNodes.ts:29`) and the verbatim TypeScript
output is reproduced below.

## 1. Dialect-difference table across the 7 SDKs

Each cell is grounded in the cited SDK source (the file that builds the schema)
and, where the SDK delegates to a library, that library's documented dialect.

| SDK | Schema source (file:line) | Library | Draft | `$ref`/`$defs` | Nullable encoding | `additionalProperties` | `format` | `enum` | Recursive types |
|---|---|---|---|---|---|---|---|---|---|
| **Go** | `sdks/go/define_node.go:79-87` | `invopop/jsonschema` Reflector `{DoNotReference:true, ExpandedStruct:true}` | Draft 2020-12 | **No** (`DoNotReference` inlines `$defs`) | omitempty pointer → field omitted (no `null` type unless tagged) | reflector default `false` on structs | yes (`jsonschema:"format=..."` tag) | yes (`enum` tag) | **`$ref` cycle** — `DoNotReference` can't inline a self-referential struct; reflector still emits a `$ref` for the cycle |
| **Rust** | `sdks/rust/src/node.rs:165-170` | `schemars` 0.8 (`schema_for!`) (`Cargo.toml:52`) | **Draft 7** | **Yes** — `definitions` + `$ref` for nested/enum types | `Option<T>` modelled by omitted-required (0.8 default); nested optionals can surface as `{ "anyOf": [T, {"type":"null"}] }` | default `false` on derived structs | via `#[schemars(...)]` attrs | adjacently/externally-tagged enums → `oneOf`/`$ref` | `$ref` cycle into `definitions` |
| **Java** | `sdks/java/src/main/java/com/blok/blok/node/TypedNode.java:96-142` | **hand-rolled** (Gson, `getDeclaredFields` reflection) | none (no `$schema`) | **No** | none — nullable not modelled; primitives → `required`, boxed/objects → optional, never `type:null` | **never emitted** (no key) | **never** | **never** (no enum support) | **flattened to `{type:object}`** — nested/self-ref types collapse to bare `object`, no recursion |
| **C#** | `sdks/csharp/src/Blok.Core/Node/TypedNode.cs:92-137` | `NJsonSchema` 11.6.1 (`.csproj:32`) | **Draft 7** (`$schema: draft-07`) | **Yes** — `definitions` + `$ref` | nullable ref → `["type","null"]` **type-array** *or* `"x-nullable"` (NJsonSchema style); reference types nullable by default | typically `false` on generated objects | yes (`format: date-time`, etc.) | yes (`enum` or `x-enumNames`) | `$ref` cycle into `definitions` |
| **Python3** | `sdks/python3/blok/node/define_node.py:123-127` | Pydantic 2 `model_json_schema()` (`pyproject.toml:28`, `>=2.0`) | **Draft 2020-12** | **Yes** — `$defs` + `$ref` for nested models | `Optional[x]` → `{ "anyOf": [x, {"type":"null"}] }` | default `false` unless `model_config extra="allow"` (then `true`) | yes (`format: email`, `uuid`, `date-time`) | `Literal`/`Enum` → `enum` (sometimes `$ref` to a `$defs` enum) | `$ref` cycle into `$defs` |
| **PHP** | `sdks/php/src/Node/TypedNode.php:119-158` | **hand-rolled** (`ReflectionClass` ctor params) | none | **No** | none — `?T` / nullable param just omitted from `required` (`:129`), never `type:null` | **never emitted** | **never** | **never** | **flattened to `{type:object}`**; `array` → bare `{type:array}` with **no `items`** (`:152`); untyped/`mixed` param → **empty `{}`** (`:157`) |
| **Ruby** | `sdks/ruby/lib/blok/node/typed_node.rb:100-108` | **hand-rolled** (`field :name, :type` DSL → `JSON_TYPES` map) | none | **No** | none — optional field just omitted from `required` (`:105`), never `type:null` | **never emitted** | **never** | **never** | **none** — `array` → bare `{type:array}` with **no `items`** (`:104`); no nested-object recursion (`:object` → bare `{type:object}`) |

### Three dialect families fall out of the table

1. **Reflective, library-backed, `$ref`-heavy** — Rust (schemars, Draft 7), C#
   (NJsonSchema, Draft 7), Python (Pydantic, 2020-12). These emit `$ref`/`$defs`,
   `anyOf[null]` or `["type","null"]` nullables, `format`, `enum`, and **`$ref`
   cycles for recursive types**. The richest dialects — and the ones the printer
   handles *worst*.
2. **Reflective, library-backed, inlined** — Go (invopop, `DoNotReference` +
   `ExpandedStruct`). Mostly inlined flat objects, but a self-referential struct
   still forces a `$ref` the printer can't follow.
3. **Hand-rolled, flat** — Java, PHP, Ruby. One level of `{type:object,
   properties,required}`, no draft, no `$ref`, no nullable, no `format`, no
   `enum`. Nested types collapse to bare `{type:object}`; arrays lose their
   `items`. These *round-trip cleanly* through the current printer — but only
   because they throw away all the type information first.

The split matters for the recommendation: **any off-the-shelf converter must
handle family (1)** (the whole point of typed cross-runtime handles is Rust/C#/
Python nodes), while families (2) and (3) are already trivially handled.

## 2. Gap analysis — `jsonSchemaToTs` (`syncNodes.ts:29-64`)

The printer is a 35-line recursive switch on `s.type`. It handles
`string`/`number`/`integer`/`boolean`/`null`/`array`/`object`/`undefined` and a
top-level `enum`. **Every other construct hits one of two silent-loss paths:**

- the `default:` arm (`:61`) → `unknown`, or
- the `object`/`undefined` arm with no `properties` (`:52`) →
  **`Record<string, unknown>`** — which is *worse* than `unknown`: it falsely
  advertises an index signature on a value whose real shape was knowable.

### Constructs the printer silently drops

| Construct | Emitted by | Printer branch hit | Output | Should be |
|---|---|---|---|---|
| `$ref` (no `type` key) | Rust, C#, Python, Go-cycle | `case undefined`, no `properties` (`:52`) | `Record<string, unknown>` | resolve the ref → the target type |
| `$defs` / `definitions` | Rust, C#, Python | never read | dropped | ref resolution table |
| `anyOf: [T, {type:null}]` | Python, Rust | `case undefined`, no `properties` (`:52`) | `Record<string, unknown>` | `T \| null` |
| `type: ["string","null"]` (array) | C#, schemars | `default:` (`:61`, `s.type` is an array) | `unknown` | `string \| null` |
| `oneOf` / `allOf` | Rust enums, some libs | `case undefined`, no `properties` (`:52`) | `Record<string, unknown>` | union / intersection |
| `format: "email"` etc. | Python, C# | ignored on `string` (`:38`) | `string` (lossless but unbranded) | `string` (acceptable) |
| `additionalProperties: {T}` | Python (`extra=allow`) | ignored (`:49`) | shape without index sig | `{ … } & Record<string, T>` |
| `array` with **no `items`** | PHP, Ruby | `s.items` is `undefined` → recurse → `unknown` (`:48`) | `Array<unknown>` | `Array<unknown>` (acceptable — source lost it) |
| empty `{}` schema | PHP `mixed` | `case undefined`, no `properties` (`:52`) | `Record<string, unknown>` | `unknown` (more honest) |

### Executed evidence (real printer output)

Run via the exported `jsonSchemaToTs` against seven synthetic schemas, each
modelled on a real SDK dialect. **Verbatim output:**

```
### Pydantic nested $ref
{ user: Record<string, unknown>; tags?: Array<string> }

### Pydantic Optional anyOf-null
{ nickname?: Record<string, unknown> }

### Rust/C# nullable type-array
{ note: unknown }

### format + additionalProperties
{ email?: string; role?: "admin" | "user"; meta?: Record<string, unknown> }

### PHP/Ruby bare array (no items)
{ items: Array<unknown> }

### PHP mixed empty schema
{ payload: Record<string, unknown> }

### oneOf union
{ shape?: Record<string, unknown> }
```

Read the first three lines: a Pydantic node with a nested `User` model, an
`Optional[str]` field, and a Rust/C# nullable string **all lose their type** —
exactly the typed-handle contract the redesign exists to deliver. The `enum` +
`format` line shows the one thing the printer does well (top-level `enum`, plain
`string`) sitting next to two more `Record<string, unknown>` drops.

`mockAllNodes`-style fixtures won't catch this: the printer never throws and
always emits valid TS. The failure is **silent type erosion**, not a crash —
which is why #367 needs explicit per-dialect fixtures.

## 3. Recommendation

Three options, against the ladder (reuse > harden > push upstream):

| Option | What | Effort | Verdict |
|---|---|---|---|
| **A. Adopt off-the-shelf** | Add `json-schema-to-typescript` to `packages/cli`; feed it each node's schema with `$defs` as the resolution scope | **S–M**: ~1 dep, replace the body of `jsonSchemaToTs` with a thin async wrapper; the lib resolves `$ref`/`$defs`, `anyOf`/`oneOf`/`allOf`, `["type","null"]`, recursion, `additionalProperties`, `enum`, `format`-as-comment. | **Recommended** |
| B. Harden the hand-rolled printer | Add `$ref`/`$defs` resolution, `anyOf`/`oneOf`/type-array nullable handling, cycle detection | **L**: reimplements ~60% of an existing, battle-tested library — exactly the slop the ponytail ladder rung 5 forbids. Cycle-safe `$ref` resolution alone is non-trivial. | Reject |
| C. Require normalization | Make every SDK emit one canonical dialect before codegen | **XL**: edits all 7 SDKs (3 of them hand-rolled with no `$ref` machinery to begin with) + a cross-runtime contract. | Reject (move-the-problem) |

**Adopt `json-schema-to-typescript` (Option A).** It is purpose-built for this
exact problem, handles all of family (1)'s `$ref`/`anyOf`/`oneOf`/recursive
constructs that the current printer drops to `Record<string, unknown>`, and is a
single well-maintained dependency. The CLI already pulls heavier deps (`ai`,
`express`, `better-sqlite3`), so the weight is not a concern.

### The failing cases that drive the call

From §2's executed evidence, **these are not handled by the current printer and
are core to the typed-handle story** (i.e. they regress real Rust/C#/Python nodes):

1. `$ref` to a nested model (`{ user: Record<string, unknown> }` — type lost).
2. `anyOf: [T, {type:null}]` Optional (`Record<string, unknown>` — type lost).
3. `type: ["string","null"]` nullable (`unknown` — type lost).
4. `oneOf` union (`Record<string, unknown>` — type lost).

`json-schema-to-typescript` resolves all four; hardening the printer to match
would re-implement the library.

### Integration notes (for the implementer, not part of this spike)

- The lib is **async** and consumes a `$defs`/`definitions` table — the catalog
  currently flattens each node's schema, so feed the whole schema object
  (including its `$defs`) per node and let the lib resolve internally.
- It emits a named root interface; the stub generator
  (`generateRuntimeStubs`, `syncNodes.ts:71`) wants an inline type literal for
  `runtimeNode<In, Out>(...)`. Either inline the generated alias or switch the
  stub to a named-type form. Decide in #367.
- Keep the `null`/empty-schema → `unknown` fallback (ADR 0010's
  `--allow-unknown-schema` contract) — the lib is only invoked when a schema is
  present.

> `json-schema-to-zod` was considered and rejected: `runtimeNode` needs a
> *type*, not a runtime validator (validation already happens in the SDK before
> execute). Pulling Zod codegen for type extraction is the wrong tool.

## Residual (out of scope here)

Real captured `input_schema_json` / `output_schema_json` bytes from live sidecars
— the fixtures ADR 0010's acceptance and #364's first checkbox ask for — still
need the **7 SDK containers booted** (gRPC ports 10001–10007, see
`sdks/CLAUDE.md`) and `ListNodes` dumped for one typed + one untyped node each.
That is the natural first step of #367: drop the captured bytes into a
`fixtures/listnodes/<sdk>/` dir and assert the chosen converter's output against
them. This spike's synthetic schemas are faithful to each dialect's source but
are a **stand-in** for those live bytes; the edge cases most worth a live capture
are Go's `DoNotReference` self-referential `$ref` cycle and Pydantic's
`$defs`-with-enum form, which are awkward to model synthetically.
