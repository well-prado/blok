# blok-go

Go SDK for the Blok blok workflow orchestration framework.

Build workflow nodes in Go that integrate with the Blok runner via HTTP.

## Installation

```bash
go get github.com/nickincloud/blok-go
```

## Quick Start

```go
package main

import (
    "log"
    blok "github.com/nickincloud/blok-go"
)

type GreetNode struct{}

func (n *GreetNode) Execute(ctx *blok.Context, config map[string]interface{}) (interface{}, error) {
    name := "World"
    if body := ctx.Request.BodyMap(); body != nil {
        if v, ok := body["name"].(string); ok {
            name = v
        }
    }
    return map[string]string{"message": "Hello, " + name + "!"}, nil
}

func main() {
    registry := blok.NewNodeRegistry()
    registry.Register("greet", &GreetNode{})

    if err := blok.ListenAndServe(registry); err != nil {
        log.Fatal(err)
    }
}
```

## Creating a Custom Node

Implement the `NodeHandler` interface:

```go
type NodeHandler interface {
    Execute(ctx *Context, config map[string]interface{}) (interface{}, error)
}
```

Or use a function directly:

```go
registry.Register("echo", blok.NodeHandlerFunc(
    func(ctx *blok.Context, config map[string]interface{}) (interface{}, error) {
        return ctx.Request.Body, nil
    },
))
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `VERSION` | `1.0.0` | Version in health check |
| `LOG_LEVEL` | `INFO` | Minimum log level (DEBUG, INFO, WARN, ERROR) |
| `ENABLE_CORS` | `false` | Enable CORS headers |
| `READ_TIMEOUT` | `30` | HTTP read timeout (seconds) |
| `WRITE_TIMEOUT` | `30` | HTTP write timeout (seconds) |
| `SHUTDOWN_TIMEOUT` | `10` | Graceful shutdown timeout (seconds) |

## Middleware

Add cross-cutting behavior to all node executions:

```go
registry := blok.NewNodeRegistry()

logger := blok.NewLogger(blok.LogLevelInfo)
registry.Use(
    blok.RecoveryMiddleware(),
    blok.LoggingMiddleware(logger),
    blok.TimeoutMiddleware(5 * time.Second),
)
```

Built-in middleware:
- `RecoveryMiddleware()` - Catches panics and converts to errors
- `LoggingMiddleware(logger)` - Logs execution with timing
- `TimeoutMiddleware(duration)` - Enforces max execution time
- `ValidationMiddleware(validator)` - Validates input/output schemas

Custom middleware:

```go
func MyMiddleware() blok.Middleware {
    return func(next blok.NodeHandler) blok.NodeHandler {
        return blok.NodeHandlerFunc(func(ctx *blok.Context, config map[string]interface{}) (interface{}, error) {
            // Before execution
            result, err := next.Execute(ctx, config)
            // After execution
            return result, err
        })
    }
}
```

## Validation

Implement `ValidatedNodeHandler` to add schema validation:

```go
type MyNode struct{}

func (n *MyNode) Execute(ctx *blok.Context, config map[string]interface{}) (interface{}, error) {
    // Input is already validated at this point
    return map[string]string{"status": "ok"}, nil
}

func (n *MyNode) InputSchema() map[string]interface{} {
    return map[string]interface{}{
        "type":     "object",
        "required": []interface{}{"name", "email"},
        "properties": map[string]interface{}{
            "name":  map[string]interface{}{"type": "string", "minLength": 1.0},
            "email": map[string]interface{}{"type": "string"},
        },
    }
}

func (n *MyNode) OutputSchema() map[string]interface{} {
    return nil // Skip output validation
}
```

## Testing Your Nodes

```go
func TestMyNode(t *testing.T) {
    runner := blok.NewTestNodeRunner()
    runner.Register("my-node", &MyNode{})

    ctx := blok.NewMockContext().
        WithBody(map[string]interface{}{"name": "Test"}).
        Build()

    result := runner.Execute("my-node", ctx, nil)

    data, err := blok.AssertSuccess(result)
    if err != nil {
        t.Fatal(err)
    }

    // Assert on data...
}
```

## Error Handling

Use structured errors for clear error categorization:

```go
func (n *MyNode) Execute(ctx *blok.Context, config map[string]interface{}) (interface{}, error) {
    url, ok := config["url"].(string)
    if !ok {
        return nil, blok.NewConfigurationError("'url' is required in config")
    }

    resp, err := http.Get(url)
    if err != nil {
        return nil, blok.NewNetworkError("API request failed", err)
    }

    if resp.StatusCode == 404 {
        return nil, blok.NewNotFoundError("resource not found")
    }

    return data, nil
}
```

Error categories: `VALIDATION`, `EXECUTION`, `CONFIGURATION`, `NETWORK`, `NOT_FOUND`

## Docker Deployment

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 go build -o /blok ./cmd/server

FROM alpine:3.19
COPY --from=builder /blok /app/blok
EXPOSE 8080
ENTRYPOINT ["/app/blok"]
```

## HTTP Endpoints

The SDK exposes two endpoints for the Blok runner:

- `POST /execute` - Execute a node with context
- `GET /health` - Health check returning status and loaded nodes

## Example Nodes

The SDK includes three example nodes:
- `hello-world` - Simple greeting with configurable prefix
- `api-call` - HTTP client for external API requests
- `transform-data` - JSON field mapping and transformation

See `examples/nodes/` for implementations.

## API Reference

### Core Types

- `Context` - Workflow execution context with request, response, vars, env
- `Request` - HTTP request data (body, headers, params, query, method, URL)
- `Response` - Workflow response (data, success, error, contentType)
- `ExecutionRequest` - Request from the Blok runner (node config + context)
- `ExecutionResult` - Response to the Blok runner (success, data, errors, logs, metrics)
- `HealthStatus` - Health check response (status, version, nodes_loaded)
- `NodeConfig` - Node configuration (name, type, config map)

### Interfaces

- `NodeHandler` - Core interface all nodes implement
- `ValidatedNodeHandler` - Extended interface with input/output schemas
- `NodeHandlerFunc` - Adapter for function-based nodes

### Registry

- `NewNodeRegistry()` - Create a new registry
- `Register(name, handler)` - Register a node
- `Execute(request)` - Execute a node by name
- `Use(middleware...)` - Add middleware
- `Health(version)` - Get health status

### Server

- `NewServer(registry, config)` - Create a server
- `ListenAndServe(registry)` - Quick start with env config and graceful shutdown

## License

MIT
