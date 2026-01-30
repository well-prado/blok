# Blok Blok Java SDK

Java SDK for building workflow nodes that integrate with the Blok orchestration framework. Nodes communicate via HTTP (`POST /execute`, `GET /health`) and can be deployed as Docker containers.

## Installation

### Maven

```xml
<dependency>
    <groupId>com.blok</groupId>
    <artifactId>blok-java</artifactId>
    <version>1.0.0</version>
</dependency>
```

### Build from source

```bash
mvn clean package
```

## Quick Start

### 1. Implement a node

```java
import com.blok.blok.node.NodeHandler;
import com.blok.blok.types.Context;
import java.util.Map;

public class GreetNode implements NodeHandler {
    @Override
    public Object execute(Context ctx, Map<String, Object> config) throws Exception {
        String name = "World";
        Map<String, Object> body = ctx.getRequest().bodyMap();
        if (body != null && body.get("name") instanceof String s) {
            name = s;
        }
        return Map.of("message", "Hello, " + name + "!");
    }
}
```

### 2. Register and serve

```java
import com.blok.blok.config.ServerConfig;
import com.blok.blok.node.NodeRegistry;
import com.blok.blok.server.RuntimeServer;

public class Main {
    public static void main(String[] args) throws Exception {
        NodeRegistry registry = new NodeRegistry();
        registry.register("greet", new GreetNode());

        ServerConfig config = ServerConfig.fromEnv();
        RuntimeServer server = new RuntimeServer(registry, config);
        server.start();
    }
}
```

### 3. Test the endpoint

```bash
curl -X POST http://localhost:8080/execute \
  -H "Content-Type: application/json" \
  -d '{
    "node": {"name": "greet", "config": {}},
    "context": {
      "id": "1",
      "request": {"body": {"name": "Blok"}, "method": "POST", "url": "/", "headers": {}, "params": {}, "query": {}, "cookies": {}, "baseUrl": ""},
      "response": {},
      "vars": {},
      "env": {}
    }
  }'
```

## Configuration

Configuration is loaded from environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `VERSION` | `1.0.0` | Runtime version (reported in health) |
| `LOG_LEVEL` | `INFO` | Minimum log level: DEBUG, INFO, WARN, ERROR |
| `ENABLE_CORS` | `false` | Enable CORS headers |
| `SHUTDOWN_TIMEOUT` | `10` | Graceful shutdown timeout (seconds) |

## Middleware

Middleware wraps node execution to add cross-cutting behavior.

```java
import com.blok.blok.middleware.*;
import com.blok.blok.logging.Logger;
import com.blok.blok.logging.LogLevel;

Logger logger = new Logger(LogLevel.INFO);

registry.use(new RecoveryMiddleware());
registry.use(new LoggingMiddleware(logger));
```

Built-in middleware:
- **RecoveryMiddleware** -- catches exceptions, converts to structured error results
- **LoggingMiddleware** -- logs execution start/end with timing

Custom middleware:

```java
Middleware timing = next -> (ctx, config) -> {
    long start = System.nanoTime();
    Object result = next.execute(ctx, config);
    System.out.println("Took " + (System.nanoTime() - start) / 1_000_000 + "ms");
    return result;
};
registry.use(timing);
```

## Validation

Lightweight JSON Schema validation (subset of Draft 7):

```java
import com.blok.blok.validation.SchemaValidator;
import java.util.*;

SchemaValidator validator = new SchemaValidator();
Map<String, Object> schema = Map.of(
    "type", "object",
    "required", List.of("name", "email"),
    "properties", Map.of(
        "name", Map.of("type", "string", "minLength", 1),
        "email", Map.of("type", "string")
    )
);

List<String> errors = validator.validate(data, schema);
```

Supported keywords: `type`, `required`, `properties`, `enum`, `minLength`, `maxLength`, `minimum`, `maximum`.

## Testing

Use the built-in test utilities:

```java
import com.blok.blok.testing.MockContext;
import com.blok.blok.testing.TestRunner;

TestRunner runner = new TestRunner();
runner.register("greet", new GreetNode());

Context ctx = new MockContext()
    .withBody(Map.of("name", "Test"))
    .build();

ExecutionResult result = runner.execute("greet", ctx, Map.of());
assert result.isSuccess();
```

Run the test suite:

```bash
mvn test
```

## Error Handling

Structured errors with categories:

```java
import com.blok.blok.errors.NodeException;

throw NodeException.validation("name is required");
throw NodeException.configuration("missing 'url' in config");
throw NodeException.network("connection refused", cause);
throw NodeException.notFound("resource not found");
throw NodeException.execution("processing failed");
```

Error categories: `VALIDATION`, `EXECUTION`, `CONFIGURATION`, `NETWORK`, `NOT_FOUND`.

## Docker

```bash
# Build
docker build -t blok-blok-java .

# Run
docker run -p 8080:8080 blok-blok-java

# Health check
curl http://localhost:8080/health
```

## Project Structure

```
src/main/java/com/blok/blok/
  types/          Context, Request, Response, NodeConfig, ExecutionRequest/Result
  node/           NodeHandler interface, NodeRegistry
  server/         RuntimeServer (JDK HttpServer)
  middleware/     Middleware, MiddlewareChain, Logging, Recovery
  validation/     SchemaValidator
  logging/        Logger, LogLevel, LogEntry
  errors/         NodeException, ErrorCategory
  config/         ServerConfig
  testing/        MockContext, TestRunner
  nodes/          HelloWorldNode, ApiCallNode, TransformDataNode
  Main.java       Entry point
```

## License

See repository root for license information.
