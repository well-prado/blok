# SPEC — Unifying node structure & authoring across Blok's 9 runtimes

**Status:** Proposal / design spec. Author: BLOK work session, prompted by Tetrix-BLOK's divergent per-runtime node layouts.
**Audience:** a BLOK framework work session. Self-contained. Pairs with `SPEC-blok-client-sdk.md`.

## 0. The two things you actually want (and they're different)
You asked for two things that the research says must be answered separately:
- **(A) Location** — "put all nodes in one folder; point all runtimes at one folder."
- **(B) Alignment** — "make Rust/Python nodes follow the same principles as the TypeScript `defineNode` nodes."

**Verdict up front:** **(A) — physically merging all 9 languages' node code into one folder is an anti-pattern** (it fights every language's package manager + toolchain and creates build coupling). **(B) — unifying the authoring *contract* is exactly right, is the industry best practice, and is the real win you're feeling.** The discoverability you want from (A) is delivered by an **index/manifest**, not by colocation. Do (B) + an index; treat (A) as, at most, a cosmetic top-level `nodes/<lang>/` regrouping with per-language toolchains kept separate.

## 1. What the research found (cited)
The dominant pattern across mature polyglot systems is **NOT** to centralize per-language handler code in one folder — it's to keep **language-idiomatic code in per-language trees, unified by a single language-neutral CONTRACT** (25/25 claims verified, 0 refuted):

- **One IDL/schema as the source of truth → per-language code generated, not hand-duplicated.** One `.proto` → C++/Java/Python/Go/Ruby/C#/PHP/Kotlin stubs from a single `protoc` run; gRPC uses it as IDL + wire; **Smithy** treats codegen as a primary feature ("single source of truth"); **Apache Beam's** portability framework defines its Runner/Fn APIs in protobuf so no SDK reimplements the protocol. [[protobuf](https://protobuf.dev/programming-guides/proto3/), [gRPC](https://grpc.io/docs/what-is-grpc/introduction/), [Smithy](https://smithy.io/2.0/guides/using-code-generation/index.html), [Beam](https://beam.apache.org/roadmap/portability/)]
- **Per-language trees, NOT a monolithic folder, unified by a shared invocation contract.** **OpenFaaS** gives each language its *own template subdirectory* (own Dockerfile, `template.yml`, handler) and explicitly does **not** centralize — templates live in *separate repos* with a centralized **INDEX** (`faas-cli template store list`); the uniform contract is the watchdog, not colocation. **Dapr** decouples handlers entirely behind a language-agnostic HTTP/gRPC sidecar with optional per-language SDKs as idiomatic stubs. [[OpenFaaS](https://docs.openfaas.com/cli/templates/), [Dapr](https://docs.dapr.io/concepts/overview/)]
- **Multiple toolchains/lockfiles coexisting in one repo is fine — handled by the build tool, not by folder layout.** **Bazel** resolves an abstract `toolchain_type` to a concrete toolchain per platform, so each language registers independently. **Pants** prefers one lockfile but supports multiple "named resolves" when requirements genuinely conflict, plus file-level dependency inference. [[Bazel](https://bazel.build/extending/toolchains), [Pants](https://www.pantsbuild.org/dev/docs/python/overview/lockfiles)]
- **WASM Component Model + WIT** is the emerging "author once, run across languages" north star (WASI 0.2.0 stable since Jan 2024; WIT as IDL; cross-language ABI) — **but guest tooling is still maturing**: a tech preview covering Rust/C/Go/Java/JS, with **PHP and Ruby lagging** first-class WIT generators. Not ready to underwrite a 9-language refactor today. [[Component Model](https://component-model.bytecodealliance.org/), [Bytecode Alliance](https://bytecodealliance.org/articles/component-model-tooling-compatibility)]

**Translation for Blok:** Blok already *is* the "shared contract + per-language runtime" pattern — the gRPC `NodeRuntime` proto is the language-neutral contract; each SDK is a per-language tree on its own port. The gap isn't the architecture; it's that **the per-language *authoring* surfaces diverged** and there's **no index** to find a node across runtimes.

## 2. Current-state ground truth (Tetrix-BLOK, representative of the divergence)
Each runtime has its **own** node tree, pointed at its own `cwd` (`.blok/config.json`), with its **own** authoring conventions:

| Aspect | **TypeScript** (the good shape) | **Rust** | **Python** |
|---|---|---|---|
| Layout | `src/nodes/<group>/<node>/index.ts` (folder-per-node) | `src/nodes/<node>.rs` (flat single file) | `runtimes/python3/nodes/<node>/node.py` (folder-per-node) |
| I/O schema | **Zod** `input`/`output` (declared) | **none** — `&HashMap<String, Value>`; optional `ValidatedNodeHandler::{input,output}_schema()` exists but is unused | **none** — `Dict[str, Any]` |
| Validation | **automatic** (defineNode → Zod → `GlobalError` w/ field errors) | **manual inline** (`cfg_str(...)`, `.as_u64()`, hand-built `BlokError`) | **manual inline** (`.get()`, try/except, hand-built `BlokError`) |
| Metadata | `name`, `description`, `contentType`, `flow`, … | none (doc comments only) | none (docstring only) |
| Handler | `defineNode({ … execute(ctx, input) })` — typed I/O | `impl NodeHandler` trait, `Value`→`Value` | `class(NodeHandler)`, `Dict`→`Any` |
| Registration | barrel object in `Nodes.ts` | manual `register_all()` in `mod.rs` | manual `register_all()` in `__init__.py` |
| Reflection | schema on the node instance (TS only) | gRPC `ListNodes` returns **empty** `input_schema_json`/`output_schema_json` | same — empty |

The result is exactly the pain you named: Rust/Python have **silent validation leaks** (a missing field is `None`/`Value::Null` until it explodes deep in the handler), no metadata, and no machine-readable schema — the opposite of the TS `defineNode` guarantees.

## 3. Recommendation

### 3.1 Do NOT physically merge all languages into one folder
Each language's tooling (cargo workspace + `Cargo.lock`, venv/`pyproject` + `requirements.txt`, `tsconfig` + `package.json`, `go.mod`, …) is anchored to a directory. Jamming 9 toolchains into one undifferentiated folder creates lockfile/toolchain conflicts and build coupling — the precise failure Bazel/Pants exist to avoid. Keep **per-language runtime trees**.

*If* you want the cosmetic "one place," the safe version is a single top-level `nodes/` with **per-language subfolders that each keep their own toolchain** (`nodes/typescript/`, `nodes/rust/`, `nodes/python/`) — a grouping, not a merge. A "colocate every language of one node in `nodes/<node>/{ts,rust,py}/`" variant is possible but heavier (mixes toolchains per node dir) and only pays off once codegen-from-one-IDL exists (§3.3). **Neither is the priority** — the index (§3.4) delivers the discoverability without moving anything.

### 3.2 Unify the AUTHORING CONTRACT to the `defineNode` principle (the real win)
Bring every SDK to the TS `defineNode` shape: **declarative input/output schema + automatic validation + uniform metadata + idiomatic auto-registration.** One contract, language-idiomatic implementations.

- **Python** — a `define_node`-equivalent using **Pydantic** models (the idiomatic Zod analogue):
  ```python
  @node(name="@tetrix/pgvector-search", description="…")
  class PgVectorSearch:
      class Input(BaseModel):  query: str; limit: int = 10; function: Literal["semantic_search","find_similar_code"]="semantic_search"
      class Output(BaseModel): results: list[SearchResult]
      def execute(self, ctx: Context, input: Input) -> Output: ...   # validated + typed; no .get()
  ```
  The SDK wrapper validates `config` against `Input` (→ structured `BlokError` on failure), exposes `Input.model_json_schema()` / `Output.model_json_schema()` for reflection, and a `@node` decorator auto-registers (kills manual `register_all()`).

- **Rust** — a `define_node!`/derive using **serde + [schemars](https://docs.rs/schemars)** (idiomatic typed structs + JSON-Schema derive):
  ```rust
  #[derive(Deserialize, JsonSchema)] struct Input { clone_url: Option<String>, depth: Option<u32>, … }
  #[derive(Serialize, JsonSchema)]   struct Output { workdir: String, head_commit: String, branch: String }
  #[blok_node(name = "@tetrix/clone-repo", description = "…")]
  async fn execute(ctx: &mut Context, input: Input) -> Result<Output, BlokError> { … }   // typed, validated
  ```
  The macro deserializes+validates `config` into `Input` (→ `BlokError` on failure), emits `schema_for!(Input/Output)` for reflection, and registers via [`inventory`](https://docs.rs/inventory)/[`linkme`](https://docs.rs/linkme) (compile-time auto-registration; kills manual `mod.rs` edits).

- **TypeScript** — already the reference; optionally add glob-based auto-registration to drop the hand-maintained `Nodes.ts` barrel.

This is **language-idiomatic, not a forced merge** — exactly the "uniform contract, per-language code" the research endorses.

### 3.3 JSON Schema as the single contract source of truth (bridge to the Client SDK)
All three already converge on **JSON Schema** (Zod→`zodToJsonSchema`, Pydantic→`model_json_schema`, Rust→`schemars`). Make that the canonical node-contract IR:
- **Populate the gRPC `ListNodes` reflection** (`input_schema_json`/`output_schema_json`, currently empty) from each SDK's declared schema. This is the dependency `SPEC-blok-client-sdk.md` §4.4 needs to type `runtime.rust`/`runtime.python3` step outputs.
- This is the *pragmatic* "single source of truth" (each language authors natively, all emit the same JSON-Schema contract). The *deeper* version — author the schema once in an IDL and codegen the per-language structs — is a later option; start with native-declare-emit-JSON-Schema (lower friction, no codegen step in the author loop).

### 3.4 A node catalog / index (delivers the discoverability you wanted from (A))
"One place to find any node across all runtimes" — via an index, the OpenFaaS-store pattern, not colocation:
- `GET /__blok/nodes` aggregates `ListNodes` across every running runtime → `{ name, runtime, description, inputSchema, outputSchema }[]`.
- `blokctl nodes list` / a Studio "Node Catalog" tab renders it.
- Result: search, discover, and see the typed contract of every node — regardless of which language tree it lives in.

### 3.5 WASM Component Model — north star, not now
The "author a node once, run it on any runtime" dream is the WASM Component Model + WIT, and it's worth tracking — but its guest tooling doesn't cover all 9 languages yet (**PHP/Ruby lag**, still on the 0.2.x line). Don't predicate this refactor on it. Re-evaluate in ~12–18 months; the JSON-Schema contract (§3.3) is forward-compatible with a future WIT migration.

## 4. Phasing
1. **P1 — Reflection.** Populate gRPC `ListNodes` schemas from existing declarations (TS already has them; Rust/Python emit `{}` until P2). Add `GET /__blok/nodes` + `blokctl nodes list`. *Immediate discoverability; unblocks the Client SDK's runtime-node typing.*
2. **P2 — Python contract.** `@node` + Pydantic `Input`/`Output` + auto-validate + auto-register + schema emit. Migrate Tetrix's Python nodes. *Kills the silent-validation leaks first where they bite most.*
3. **P3 — Rust contract.** `#[blok_node]` + serde/schemars `Input`/`Output` + auto-validate + `inventory` registration + schema emit. Migrate Tetrix's Rust nodes.
4. **P4 — (optional) layout + remaining SDKs.** Cosmetic top-level `nodes/<lang>/` regroup if desired; roll the contract to Go/Java/C#/PHP/Ruby SDKs.

Each SDK ships in its own lockstep/SDK-image release; the contract is additive (old `Dict`/`HashMap` handlers keep working during migration).

## 5. Risks / caveats
- **Don't over-merge.** Resist the literal "one folder" — it's the one move the research warns against. Keep toolchains isolated.
- **Migration is per-node, not big-bang.** Both new contracts must accept legacy untyped handlers so you migrate incrementally.
- **Pydantic/schemars ↔ Zod parity gaps.** JSON Schema is the common denominator but not 1:1 across Zod/Pydantic/schemars (refinements, unions, defaults). Pin to JSON-Schema-draft-2020-12 features all three support; document the supported subset.
- **Auto-registration magic** (decorator/inventory) can hide nodes that fail to load — keep a `blokctl nodes doctor` that lists registered-vs-expected.
- **Research time-sensitivity:** the WASM maturity claims rest on a 2023 snapshot (~3y stale); the "PHP/Ruby lag" direction holds, the exact tooling list is dated. Verify current WIT coverage before any WASM bet.

## 6. Bottom line
Your instinct is two-thirds right and one-third a trap. **The trap:** one physical folder for all 9 languages — don't; it fights toolchains and is what mature polyglot systems explicitly avoid. **The win:** make every runtime author nodes with the *same contract* as TypeScript `defineNode` (declarative schema + auto-validation + metadata + auto-registration), let them emit a shared **JSON-Schema** contract, and add a **node catalog index** so there's "one place to find" every node. That gives you everything you actually wanted — uniform authoring + discoverability — without the dependency-hell, and it doubles as the reflection layer the typed Client SDK needs.

---

## Appendix — the uniform authoring contract in ALL runtimes

**The 9 runtimes = 8 language surfaces** (NodeJS + Bun share the TypeScript `defineNode`). The contract is identical everywhere — **declare typed `Input`/`Output`, auto-validate, uniform metadata, auto-register, emit JSON Schema** — implemented with each language's *idiomatic* schema+validation library. Same node (`@acme/search`: `{ query: string≥1, limit?: int 1–100 default 10 } → { results: string[], count: int }`) in each:

**Picks per language (all emit JSON Schema → the shared contract → `ListNodes` reflection → Client SDK):**

| Runtime | Type / schema | Validation | JSON-Schema emit | Auto-register |
|---|---|---|---|---|
| **TS** (Node/Bun) | Zod | Zod (in `defineNode`) | `zod-to-json-schema` | barrel / glob |
| **Python** | Pydantic v2 | Pydantic | `model_json_schema()` | `@node` decorator |
| **Go** | struct + tags (generics) | `go-playground/validator` | `invopop/jsonschema` | package-init / `DefineNode[I,O]` |
| **Rust** | serde struct | serde + schemars | `schema_for!` | `inventory`/`linkme` |
| **Java** | `record` + Jakarta | Bean Validation | `victools/jsonschema-generator` | `@BlokNode` classpath scan |
| **C#** | `record` + DataAnnotations | DataAnnotations | `JsonSchema.Net.Generation` | `[BlokNode]` reflection |
| **PHP** | typed DTO + attributes | `symfony/validator` | reflection + attrs | `#[BlokNode]` attribute |
| **Ruby** | `dry-struct` | `dry-types`/`dry-schema` | `dry-schema` json_schema | `Blok.define_node` DSL |

### TypeScript (Node / Bun) — the reference (exists today)
```ts
export default defineNode({
  name: "@acme/search", description: "Full-text search",
  input:  z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).default(10) }),
  output: z.object({ results: z.array(z.string()), count: z.number().int() }),
  async execute(ctx, input) { const r = await search(input.query, input.limit); return { results: r, count: r.length }; },
});
```

### Python — Pydantic v2 + `@node`
```python
from blok import node, Context
from pydantic import BaseModel, Field

class Input(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(10, ge=1, le=100)
class Output(BaseModel):
    results: list[str]; count: int

@node(name="@acme/search", description="Full-text search")
def search(ctx: Context, input: Input) -> Output:          # input is a validated Input, NOT Dict[str,Any]
    r = do_search(input.query, input.limit)
    return Output(results=r, count=len(r))
# SDK: Input(**config) → ValidationError → BlokError(400, field paths); schema = Input.model_json_schema(); @node auto-registers
```

### Go — generics + struct tags + `invopop/jsonschema`
```go
type SearchInput struct {
    Query string `json:"query" validate:"required,min=1" jsonschema:"minLength=1"`
    Limit int    `json:"limit" validate:"min=1,max=100" jsonschema:"minimum=1,maximum=100,default=10"`
}
type SearchOutput struct { Results []string `json:"results"`; Count int `json:"count"` }

var _ = blok.DefineNode(blok.Meta{Name: "@acme/search", Description: "Full-text search"},
  func(ctx *blok.Context, in SearchInput) (SearchOutput, error) {  // typed, NOT map[string]any
    r := doSearch(in.Query, in.Limit); return SearchOutput{Results: r, Count: len(r)}, nil
  })
// DefineNode[I,O any]: json.Unmarshal config→I, validator.Struct(I)→BlokError(400); reflect I/O→JSON Schema; package-init registers
```

### Rust — serde + schemars + `#[blok_node]`
```rust
#[derive(Deserialize, JsonSchema)]
struct Input { #[schemars(length(min = 1))] query: String,
               #[serde(default = "ten")] #[schemars(range(min = 1, max = 100))] limit: u32 }
#[derive(Serialize, JsonSchema)]
struct Output { results: Vec<String>, count: usize }

#[blok_node(name = "@acme/search", description = "Full-text search")]
async fn search(ctx: &mut Context, input: Input) -> Result<Output, BlokError> {  // typed, NOT HashMap<String,Value>
    let r = do_search(&input.query, input.limit).await?;
    Ok(Output { count: r.len(), results: r })
}
// macro: serde_json::from_value(config)→Input→BlokError(400); schema_for!(Input/Output); inventory::submit! auto-registers
```

### Java — `record` + Jakarta Bean Validation + `victools`
```java
public record SearchInput(@NotBlank String query, @Min(1) @Max(100) Integer limit) {
    public SearchInput { if (limit == null) limit = 10; }
}
public record SearchOutput(List<String> results, int count) {}

@BlokNode(name = "@acme/search", description = "Full-text search")
public class SearchNode implements Node<SearchInput, SearchOutput> {     // typed generics, NOT Map<String,Object>
    public SearchOutput execute(Context ctx, SearchInput in) {
        var r = doSearch(in.query(), in.limit()); return new SearchOutput(r, r.size());
    }
}
// SDK: Jackson bind config→SearchInput, Validator.validate()→BlokError(400); victools→JSON Schema; @BlokNode classpath-scanned
```

### C# — `record` + DataAnnotations + `JsonSchema.Net.Generation`
```csharp
public record SearchInput([Required, MinLength(1)] string Query, [Range(1, 100)] int Limit = 10);
public record SearchOutput(IReadOnlyList<string> Results, int Count);

[BlokNode("@acme/search", Description = "Full-text search")]
public class SearchNode : INode<SearchInput, SearchOutput> {            // typed, NOT Dictionary<string,object>
    public Task<SearchOutput> Execute(Context ctx, SearchInput input) {
        var r = DoSearch(input.Query, input.Limit);
        return Task.FromResult(new SearchOutput(r, r.Count));
    }
}
// SDK: System.Text.Json deserialize→SearchInput, Validator→BlokError(400); JsonSchema.Net.Generation→JSON Schema; [BlokNode] reflection
```

### PHP — typed DTO + `#[BlokNode]` attribute + `symfony/validator`
```php
final class SearchInput {
    public function __construct(
        #[Assert\NotBlank, Assert\Length(min: 1)] public readonly string $query,
        #[Assert\Range(min: 1, max: 100)] public readonly int $limit = 10,
    ) {}
}
final class SearchOutput {
    public function __construct(public readonly array $results, public readonly int $count) {}
}

#[BlokNode(name: '@acme/search', description: 'Full-text search')]
final class SearchNode implements Node {                                // typed DTO, NOT array
    public function execute(Context $ctx, SearchInput $input): SearchOutput {
        $r = doSearch($input->query, $input->limit);
        return new SearchOutput($r, count($r));
    }
}
// SDK: hydrate config→SearchInput (typed props), symfony Validator→BlokError(400); reflect props+attrs→JSON Schema; #[BlokNode] discovery
```

### Ruby — `dry-struct` + `dry-schema` + `Blok.define_node`
```ruby
class SearchInput < Dry::Struct
  attribute :query, Types::String.constrained(min_size: 1)
  attribute :limit, Types::Integer.default(10).constrained(gteq: 1, lteq: 100)
end
class SearchOutput < Dry::Struct
  attribute :results, Types::Array.of(Types::String)
  attribute :count,   Types::Integer
end

Blok.define_node(name: "@acme/search", description: "Full-text search",
                 input: SearchInput, output: SearchOutput) do |ctx, input|   # input coerced+validated, NOT a raw Hash
  r = do_search(input.query, input.limit)
  SearchOutput.new(results: r, count: r.size)
end
# SDK: SearchInput.new(config) → Dry::Struct::Error → BlokError(400); dry-schema json_schema export; DSL registers on require
```

**What's uniform across all 8** (the contract, regardless of language): (1) a declared, typed `Input` + `Output`; (2) the SDK validates `config → Input` *before* the handler and turns failures into a structured `BlokError` (HTTP 400, field-level) — ending the silent `Dict[str,Any]`/`HashMap<String,Value>` leaks; (3) the handler is `execute(ctx, input: Input) -> Output` — no raw maps; (4) uniform `{ name, description }` metadata; (5) auto-registration (no hand-edited central registry); (6) both schemas emitted as **JSON Schema**, surfaced via gRPC `ListNodes` → the node catalog (§3.4) + the typed Client SDK. **Per-language code stays idiomatic and in its own toolchain tree; only the *contract* is shared.**
