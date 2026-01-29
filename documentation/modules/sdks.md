# Module Reference: Multi-Language SDKs

> **Path:** `sdks/` (production SDKs) + `examples/runtimes/` (example implementations)
> **Purpose:** Enable node development in Go, Java, Rust, C#, PHP, and Ruby

## What It Does

Each SDK provides a complete toolkit for developing Blok nodes in a specific programming language. Every SDK includes:
- **Types** — Context, Request, Response, Error types mapped from TypeScript
- **Node base** — Abstract class/interface/trait for implementing nodes
- **Registry** — Node registration and discovery
- **Server** — gRPC and/or HTTP server for the runner to communicate with
- **Middleware** — Logging, validation, error handling
- **Testing** — Test utilities for node development
- **Dockerfile** — Container image for deployment

## SDK Parity Matrix

| Feature | Go | Java | Rust | C# | PHP | Ruby |
|---------|-----|------|------|-----|-----|------|
| Types/Context | yes | yes | yes | yes | yes | yes |
| Node Interface | yes | yes | yes | yes | yes | yes |
| Node Registry | yes | yes | yes | yes | yes | yes |
| gRPC Server | yes | yes | yes | yes | no | no |
| HTTP Server | yes | yes | yes | yes | yes | yes |
| Middleware | yes | yes | yes | yes | yes | yes |
| Logging | yes | yes | yes | yes | yes | yes |
| Validation | yes | yes | yes | yes | yes | yes |
| Testing Utils | yes | yes | yes | yes | yes | yes |
| Dockerfile | yes | yes | yes | yes | yes | yes |
| Config | yes | yes | yes | yes | yes | yes |

---

## Go SDK (`sdks/go/`)

### Structure
```
sdks/go/
├── cmd/server/main.go          # Server entry point
├── pkg/blok/
│   ├── server.go               # HTTP + gRPC server
│   ├── node.go                 # Node interface
│   ├── registry.go             # Node registry
│   ├── context.go              # Context type
│   ├── types.go                # Shared types
│   ├── mapper.go               # Data mapper
│   ├── errors.go               # Error types
│   ├── config.go               # Configuration
│   ├── logging.go              # Structured logging
│   ├── validation.go           # Input validation
│   └── middleware/
│       ├── logging.go          # Logging middleware
│       ├── recovery.go         # Panic recovery
│       └── validation.go       # Validation middleware
├── test/                       # Test utilities
├── go.mod, go.sum
└── Dockerfile
```

### Node Interface (Go)
```go
type NodeHandler interface {
    Handle(ctx *Context, input map[string]interface{}) (*Response, error)
    Name() string
    Description() string
}
```

---

## Java SDK (`sdks/java/`)

### Structure
```
sdks/java/
├── src/main/java/com/blok/
│   ├── server/
│   │   ├── BlokServer.java     # HTTP + gRPC server
│   │   └── GrpcService.java    # gRPC service impl
│   ├── node/
│   │   ├── NodeHandler.java    # Node interface
│   │   └── AbstractNode.java   # Base class
│   ├── registry/
│   │   └── NodeRegistry.java   # Node registration
│   ├── types/
│   │   ├── Context.java        # Context POJO
│   │   ├── Request.java        # Request type
│   │   ├── Response.java       # Response type
│   │   └── BlokError.java      # Error type
│   ├── middleware/              # Logging, validation, error handling
│   ├── logging/                # Structured logging
│   ├── validation/             # Input validation
│   └── config/                 # Configuration
├── src/test/                   # Test utilities
├── pom.xml                     # Maven build
└── Dockerfile
```

### Node Interface (Java)
```java
public interface NodeHandler {
    Response handle(Context ctx, Map<String, Object> input) throws BlokException;
    String getName();
    String getDescription();
}
```

---

## Rust SDK (`sdks/rust/`)

### Structure
```
sdks/rust/
├── src/
│   ├── main.rs                 # Server entry point
│   ├── lib.rs                  # Library root
│   ├── server.rs               # HTTP server (axum)
│   ├── grpc_server.rs          # gRPC server (tonic)
│   ├── node.rs                 # Node trait
│   ├── registry.rs             # Node registry
│   ├── types.rs                # Shared types (serde)
│   ├── errors.rs               # Error types
│   ├── config.rs               # Configuration
│   ├── logging.rs              # Structured logging (tracing)
│   ├── validation.rs           # Input validation
│   └── middleware/             # Tower middleware layers
├── proto/node.proto            # gRPC protocol definition
├── build.rs                    # Proto compilation
├── Cargo.toml
└── Dockerfile
```

### Node Trait (Rust)
```rust
#[async_trait]
pub trait NodeHandler: Send + Sync {
    async fn handle(&self, ctx: &mut Context, input: Value) -> Result<Response, BlokError>;
    fn name(&self) -> &str;
    fn description(&self) -> &str;
}
```

---

## C# / .NET SDK (`sdks/csharp/`)

### Structure
```
sdks/csharp/
├── src/Nanoservice.Core/
│   ├── Program.cs              # ASP.NET entry point
│   ├── Server/                 # HTTP + gRPC server
│   ├── Node/
│   │   ├── INodeHandler.cs     # Node interface
│   │   └── NodeBase.cs         # Base class
│   ├── Registry/
│   │   └── NodeRegistry.cs     # Node registration
│   ├── Types/                  # Context, Request, Response, Error
│   ├── Middleware/              # ASP.NET middleware
│   ├── Logging/                # ILogger integration
│   ├── Validation/             # FluentValidation / DataAnnotations
│   └── Config/                 # IConfiguration integration
├── Nanoservice.Core.csproj     # .NET project file
└── Dockerfile
```

### Node Interface (C#)
```csharp
public interface INodeHandler
{
    Task<Response> HandleAsync(Context ctx, Dictionary<string, object> input);
    string Name { get; }
    string Description { get; }
}
```

---

## PHP SDK (`sdks/php/`)

### Structure
```
sdks/php/
├── src/
│   ├── Server.php              # PSR-7/PSR-15 HTTP server
│   ├── NodeHandler.php         # Node interface
│   ├── NodeRegistry.php        # Node registration
│   ├── Context.php             # Context class
│   ├── Types/                  # Request, Response, Error
│   ├── Middleware/              # PSR-15 middleware
│   ├── Logging/                # PSR-3 logging
│   └── Validation/             # Input validation
├── composer.json               # Composer dependencies
└── Dockerfile
```

### Node Interface (PHP)
```php
interface NodeHandler {
    public function handle(Context $ctx, array $input): Response;
    public function getName(): string;
    public function getDescription(): string;
}
```

---

## Ruby SDK (`sdks/ruby/`)

### Structure
```
sdks/ruby/
├── lib/blok/
│   ├── server.rb               # Rack/Sinatra HTTP server
│   ├── node_handler.rb         # Node base class
│   ├── node_registry.rb        # Node registration
│   ├── context.rb              # Context class
│   ├── types/                  # Request, Response, Error
│   ├── middleware/              # Rack middleware
│   ├── logging/                # Structured logging
│   └── validation/             # Input validation
├── Gemfile                     # Ruby dependencies
├── config.ru                   # Rack config
└── Dockerfile
```

### Node Interface (Ruby)
```ruby
class NodeHandler
  def handle(ctx, input)
    raise NotImplementedError
  end

  def name
    raise NotImplementedError
  end
end
```

---

## Communication Protocol

All SDKs communicate with the Blok runner using:
1. **gRPC** (primary) — Via `runtimes/proto/node.proto`
2. **HTTP** (fallback) — REST API with JSON payloads

### HTTP Contract
```
POST /execute
Content-Type: application/json

{
  "node_name": "my-node",
  "node_path": "/path/to/node",
  "context": { /* full context object */ },
  "config": { /* node configuration */ }
}

Response:
{
  "success": true,
  "data": { /* output */ },
  "errors": null,
  "metrics": { "duration_ms": 42 }
}
```

## What to Document

1. **Getting started with each SDK** — Install, create node, register, run
2. **Node interface reference** — Per language
3. **Context mapping** — How TypeScript Context maps to each language
4. **Server configuration** — Ports, TLS, middleware
5. **Docker deployment** — Dockerfile reference, docker-compose integration
6. **Testing** — How to test nodes in each language
7. **Cross-language workflows** — TypeScript → Python → Go examples
8. **Performance** — Benchmarks per language/protocol
