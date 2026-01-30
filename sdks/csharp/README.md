# Blok.Core - C# SDK for Blok

C# SDK for building workflow nodes in the Blok blok framework. Each node runs as a Docker container exposing `POST /execute` and `GET /health` endpoints.

## Install

```bash
dotnet add package Blok.Core
```

## Quick Start

Create a custom node by implementing `INodeHandler`:

```csharp
using System.Text.Json;
using Blok.Core.Node;
using Blok.Core.Types;

public class GreetNode : INodeHandler
{
    public Task<JsonElement> ExecuteAsync(Context ctx, Dictionary<string, JsonElement> config)
    {
        var name = ctx.Request.BodyString("name") ?? "World";
        var result = JsonSerializer.Serialize(new { message = $"Hello, {name}!" });
        return Task.FromResult(JsonDocument.Parse(result).RootElement.Clone());
    }
}
```

Register and start the server:

```csharp
using Blok.Core.Config;
using Blok.Core.Node;
using Blok.Core.Server;

var registry = new NodeRegistry();
registry.Register("greet", new GreetNode());

await RuntimeServer.Run(registry);
```

## Configuration

Configuration is loaded from environment variables:

| Variable      | Default   | Description               |
|---------------|-----------|---------------------------|
| `PORT`        | `8080`    | Server port               |
| `HOST`        | `0.0.0.0` | Bind address             |
| `VERSION`     | `1.0.0`   | Runtime version string   |
| `LOG_LEVEL`   | `INFO`    | DEBUG, INFO, WARN, ERROR |
| `ENABLE_CORS` | `false`   | Enable CORS headers      |

Or configure programmatically:

```csharp
var config = new ServerConfig
{
    Port = 9090,
    Version = "2.0.0",
    EnableCors = true
};
await RuntimeServer.Run(registry, config);
```

## Middleware

Add cross-cutting behavior with middleware:

```csharp
using Blok.Core.Middleware;

var chain = new MiddlewareChain()
    .Use(new RecoveryMiddleware())
    .Use(new LoggingMiddleware());

var wrappedHandler = chain.Apply(myHandler);
```

Built-in middleware:
- **LoggingMiddleware** - Logs execution timing
- **RecoveryMiddleware** - Catches unhandled exceptions

## Schema Validation

Validate JSON data against schemas:

```csharp
using Blok.Core.Validation;

var validator = new SchemaValidator();
var schema = JsonDocument.Parse(@"{
    ""type"": ""object"",
    ""required"": [""name"", ""email""],
    ""properties"": {
        ""name"": { ""type"": ""string"", ""minLength"": 1 },
        ""email"": { ""type"": ""string"" }
    }
}").RootElement;

var errors = validator.Validate(data, schema);
```

## Testing

Use `MockContextBuilder` and `TestNodeRunner` for unit tests:

```csharp
using Blok.Core.Testing;

var ctx = new MockContextBuilder()
    .WithBody(new { name = "Blok" })
    .WithVar("key", "value")
    .WithEnv("API_KEY", "test-key")
    .Build();

var runner = new TestNodeRunner();
runner.Register("my-node", new MyNode());
var result = await runner.ExecuteAsync("my-node", ctx);
```

## Docker

```bash
docker build -t my-blok .
docker run -p 8080:8080 my-blok
```

## Endpoints

- `POST /execute` - Execute a node (JSON body: `ExecutionRequest` -> `ExecutionResult`)
- `GET /health` - Health check (returns `HealthStatus`)

## License

MIT
