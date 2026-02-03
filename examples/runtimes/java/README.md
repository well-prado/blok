# Blok Java Runtime

A containerized Java runtime for executing Blok workflow nodes written in Java.

## Features

- ✅ HTTP-based execution protocol
- ✅ Built-in health checks
- ✅ Container pooling support
- ✅ Full context propagation
- ✅ Type-safe SDK with Gson
- ✅ Multi-stage Docker build for optimized images
- ✅ Java 17 runtime

## Quick Start

### 1. Build the Docker image

```bash
docker build -t blok-java-runtime:latest .
```

### 2. Run the container

```bash
docker run -p 8080:8080 blok-java-runtime:latest
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
    "language": "Java"
  },
  "errors": null
}
```

## Creating Custom Nodes

### 1. Create a new node class

```java
package com.blok.nodes;

import com.blok.runtime.Blok;
import java.util.HashMap;
import java.util.Map;

public class MyNewNode implements Blok.NodeHandler {

    @Override
    public Object execute(Blok.Context context, Map<String, Object> config) throws Exception {
        // Your node logic here

        // Access request data
        String userId = context.request.params.get("userId");

        // Access config
        String apiKey = (String) config.get("apiKey");

        // Store data in context for downstream nodes
        context.vars.put("result", "some value");

        // Return response
        Map<String, Object> response = new HashMap<>();
        response.put("status", "success");
        response.put("data", "your data");

        return response;
    }
}
```

### 2. Register the node in RuntimeServer.java

```java
import com.blok.nodes.MyNewNode;

public static void main(String[] args) throws IOException {
    registry.register("my-new-node", new MyNewNode());
    // ...
}
```

### 3. Rebuild the Docker image

```bash
docker build -t blok-java-runtime:latest .
```

## Using in Blok Workflows

### Configure the runtime adapter

```typescript
import { RuntimeRegistry, DockerRuntimeAdapter } from "@blokjs/runner";

const registry = RuntimeRegistry.getInstance();
registry.register(
  new DockerRuntimeAdapter("java", "blok-java-runtime:latest", {
    minInstances: 1,
    maxInstances: 5,
  })
);
```

### Use in workflow JSON

```json
{
  "name": "java-workflow-example",
  "steps": [
    {
      "name": "greet-user",
      "node": "hello-world",
      "type": "runtime.java",
      "runtime": "java",
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

```java
public class Context {
    public String id;                      // Unique request ID
    public String workflow_name;           // Name of the workflow
    public String workflow_path;           // Path to workflow definition
    public Request request;                // HTTP request data
    public Response response;              // Workflow response
    public Map<String, Object> vars;       // Shared variables across nodes
    public Map<String, String> env;        // Environment variables
}
```

### NodeHandler Interface

All nodes must implement this interface:

```java
public interface NodeHandler {
    Object execute(Context context, Map<String, Object> config) throws Exception;
}
```

### ExecutionResult

```java
public class ExecutionResult {
    public boolean success;                // Whether execution succeeded
    public Object data;                    // Response data
    public Object errors;                  // Error details (if any)
    public String[] logs;                  // Optional log messages
    public Map<String, Object> metrics;    // Optional metrics
}
```

## Development

### Run locally without Docker

```bash
mvn clean package
java -jar target/blok-java-runtime-*.jar
```

### Run tests

```bash
mvn test
```

### Build without Docker

```bash
mvn clean package
```

## Performance

- Container startup: ~1-2s
- Execution overhead: ~5-10ms per request
- Memory footprint: ~50-100MB per container
- Image size: ~200MB (includes JRE)

## Requirements

- Java 17+
- Maven 3.9+
- Docker (for containerization)

## License

MIT
