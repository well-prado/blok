# ADR 0010: Runtime `ListNodes` Schema Readiness and Null-Schema Stubs

## Status

Accepted for M1 planning.

## Context

The gRPC runtime catalog already carries schema bytes:

- `NodeDescriptor.input_schema_json`
- `NodeDescriptor.output_schema_json`

`GrpcRuntimeAdapter.listNodes()` parses those bytes into
`RuntimeNodeDescriptor.inputSchema` and `outputSchema`. Empty bytes, missing
bytes, or malformed JSON become `null`; an unreachable runtime becomes `[]`.

That is the right runtime fault tolerance, but it is not enough for typed
runtime-node stubs. A generated stub with `unknown` output keeps the workflow
running while silently removing the main reason the redesign exists: typed
handles across a runtime boundary.

## Probe Result

Probe method: source-level inspection of each SDK's `ListNodes` service and
typed-node reflection path, plus existing tests where present. This did not
start seven live sidecars; it verifies whether the code path emits non-empty
schema bytes when a typed node is registered.

| SDK runtime | Typed-node authoring API | Emits input schema bytes | Emits output schema bytes | Legacy/raw handler behavior | Evidence |
| --- | --- | --- | --- | --- | --- |
| Go | `DefineNode[I, O]` | Yes | Yes | Empty bytes | `sdks/go/grpc_server.go`, `sdks/go/define_node.go`, `sdks/go/define_node_test.go` |
| Rust | `TypedNode` / `TypedNodeHandler` | Yes | Yes | Empty bytes | `sdks/rust/src/grpc_server.rs`, `sdks/rust/src/node.rs` |
| Java | `TypedNode<I, O>` | Yes | Optional when `outputClass()` returns non-null | Empty bytes | `sdks/java/src/main/java/com/blok/blok/server/BlokNodeRuntimeService.java`, `sdks/java/src/main/java/com/blok/blok/node/TypedNode.java` |
| C# | `TypedNode<TInput, TOutput>` | Yes | Yes | Empty bytes | `sdks/csharp/src/Blok.Core/Server/BlokNodeRuntimeService.cs`, `sdks/csharp/src/Blok.Core/Node/TypedNode.cs` |
| Python3 | `@node` with Pydantic models | Yes when input model is annotated | Yes when output model is annotated | Empty bytes | `sdks/python3/blok/server/grpc_server.py`, `sdks/python3/blok/node/define_node.py`, `sdks/python3/tests/test_define_node.py` |
| PHP | `TypedNode` | Yes | Optional when `outputClass()` returns non-null | Empty bytes | `sdks/php/src/Server/BlokNodeRuntimeService.php`, `sdks/php/src/Node/TypedNode.php` |
| Ruby | `Blok::Node::TypedNode` | Yes | Optional when `output` block exists | Empty bytes | `sdks/ruby/lib/blok/server/grpc_server.rb`, `sdks/ruby/lib/blok/node/typed_node.rb` |

Conclusion: all seven non-Node SDKs are ready for typed runtime stubs when the
runtime node uses the SDK's typed-node API. They are not schema-complete for
legacy/raw handlers, intentionally untyped Python `@node` functions, or typed
nodes that omit an output schema.

## Decision

`blokctl nodes sync` must not silently generate a fully-typed runtime stub from
a `null` schema.

Default behavior:

1. Generate a typed runtime stub only when the required schema side is present.
2. For a normal step stub, require both input and output schemas.
3. If only the input schema exists, the CLI may emit an input-only helper for
   validation or config completion, but it must mark the output handle as
   unavailable for typed chaining unless the user opts into `unknown`.
4. If either schema is `null`, report a per-node actionable diagnostic and skip
   that typed stub by default.
5. Offer an explicit escape hatch such as `--allow-unknown-schema` to generate
   `unknown` for missing sides, with a visible comment in the generated file.

This makes the typed-handle story fail loud where it is not true yet, while
still giving advanced users a deliberate compatibility path for legacy nodes.

## Edge Cases

| Edge case | Runner catalog behavior | Stub-generation behavior |
| --- | --- | --- |
| SDK returns empty bytes | `parseSchemaBytes()` returns `null` | Skip by default; optional `unknown` with escape hatch |
| SDK returns malformed JSON | `parseSchemaBytes()` returns `null` | Same as empty bytes; also surface `schema parse failed` if raw bytes are available at sync time |
| Runtime unreachable | `listNodes()` returns `[]` | No stubs generated for that runtime; warn that the runtime was unreachable |
| Node has input but no output schema | `inputSchema` object, `outputSchema: null` | Input helper allowed; typed output handle skipped unless `--allow-unknown-schema` |
| Node has output but no input schema | `inputSchema: null`, `outputSchema` object | Skip normal step stub by default; input shape is still unknown |
| Legacy/raw SDK handler | Both schemas usually `null` | Skip by default; tell the author to use the SDK typed-node API or hand-annotate |

## Epic Statement

Cross-runtime typed handles are real today only for runtime nodes authored with
the SDK typed-node API and exposed over gRPC `ListNodes` with non-null schemas.
They are aspirational for legacy/raw runtime handlers and for nodes that omit
output schemas. The registry, Studio, MCP tools, and `blokctl nodes sync` must
surface that distinction instead of converting missing schemas into invisible
`unknown` types.

## Consequences

- The happy path is strong: typed SDK nodes in Go, Rust, Java, C#, Python3, PHP,
  and Ruby can produce schema-backed runtime stubs.
- Legacy runtime nodes stay usable, but they do not get a pretend typed-handle
  contract.
- The first implementation of `nodes sync` needs diagnostics before it needs
  hand-annotation UX.
- No runner or proto change is required.
