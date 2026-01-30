# Blok Go Runtime

A containerized Go runtime for executing Blok workflow nodes written in Go.

## Features

- ✅ HTTP-based execution protocol
- ✅ Built-in health checks
- ✅ Container pooling support
- ✅ Full context propagation
- ✅ Type-safe SDK
- ✅ Multi-stage Docker build for small images

## Quick Start

### 1. Build the Docker image

```bash
docker build -t blok-go-runtime:latest .
```

### 2. Run the container

```bash
docker run -p 8080:8080 blok-go-runtime:latest
```

### 3. Test the health endpoint

```bash
curl http://localhost:8080/health
```

Expected response:
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "nodes_loaded": ["hello-world"]
}
```

### 4. Test node execution

```bash
curl -X POST http://localhost:8080/execute \
  -H "Content-Type: application/json" \
  -d '{
    "node": {
      "name": "hello-world",
      "path": "/nodes/hello-world",
      "config": {
        "prefix": "Hi"
      }
    },
    "context": {
      "id": "test-123",
      "workflow_name": "test-workflow",
      "workflow_path": "/workflows/test",
      "request": {
        "body": {
          "name": "Blok"
        },
        "headers": {},
        "params": {},
        "query": {},
        "method": "POST",
        "url": "/api/test"
      },
      "response": {
        "data": "",
        "success": true
      },
      "vars": {},
      "env": {}
    }
  }'
```

Expected response:
```json
{
  "success": true,
  "data": {
    "message": "Hi, Blok!",
    "timestamp": "2026-01-27T12:00:00Z",
    "language": "Go"
  },
  "errors": null
}
```

## Creating Custom Nodes

### 1. Create a new node file

```go
package mynewnode

import (
	"github.com/deskree-inc/blok/examples/runtimes/go/sdk"
)

type MyNewNode struct{}

func (n *MyNewNode) Execute(ctx *blok.Context, config map[string]interface{}) (interface{}, error) {
	// Your node logic here

	// Access request data
	userId := ctx.Request.Params["userId"]

	// Access config
	apiKey := config["apiKey"].(string)

	// Store data in context for downstream nodes
	ctx.Vars["result"] = "some value"

	// Return response
	return map[string]interface{}{
		"status": "success",
		"data": "your data",
	}, nil
}

func GetNodeHandler() blok.NodeHandler {
	return &MyNewNode{}
}
```

### 2. Register the node in server/main.go

```go
import mynewnode "github.com/deskree-inc/blok/examples/runtimes/go/nodes/my-new-node"

func main() {
	registry = blok.NewNodeRegistry()
	registry.Register("my-new-node", mynewnode.GetNodeHandler())
	// ...
}
```

### 3. Rebuild the Docker image

```bash
docker build -t blok-go-runtime:latest .
```

## Using in Blok Workflows

### Configure the runtime adapter

```typescript
import { RuntimeRegistry, DockerRuntimeAdapter } from "@blok/runner";

const registry = RuntimeRegistry.getInstance();
registry.register(
  new DockerRuntimeAdapter("go", "blok-go-runtime:latest", {
    minInstances: 1,
    maxInstances: 5,
  })
);
```

### Use in workflow JSON

```json
{
  "name": "go-workflow-example",
  "steps": [
    {
      "name": "greet-user",
      "node": "hello-world",
      "type": "runtime.go",
      "runtime": "go",
      "config": {
        "prefix": "Hello"
      }
    }
  ],
  "trigger": {
    "http": {
      "method": "POST",
      "path": "/api/greet"
    }
  }
}
```

## SDK Reference

### Context

```go
type Context struct {
    ID           string                 // Unique request ID
    WorkflowName string                 // Name of the workflow
    WorkflowPath string                 // Path to workflow definition
    Request      Request                // HTTP request data
    Response     Response               // Workflow response
    Vars         map[string]interface{} // Shared variables across nodes
    Env          map[string]string      // Environment variables
}
```

### NodeHandler Interface

All nodes must implement this interface:

```go
type NodeHandler interface {
    Execute(ctx *Context, config map[string]interface{}) (interface{}, error)
}
```

### ExecutionResult

```go
type ExecutionResult struct {
    Success bool                   // Whether execution succeeded
    Data    interface{}            // Response data
    Errors  interface{}            // Error details (if any)
    Logs    []string               // Optional log messages
    Metrics map[string]interface{} // Optional metrics
}
```

## Development

### Run locally without Docker

```bash
go run server/main.go
```

### Run tests

```bash
go test ./...
```

### Format code

```bash
go fmt ./...
```

### Build binary

```bash
go build -o runtime ./server/main.go
```

## Performance

- Container startup: ~500ms
- Execution overhead: ~2-5ms per request
- Memory footprint: ~10-20MB per container
- Image size: ~15MB (multi-stage build)

## License

MIT
