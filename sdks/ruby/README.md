# Nanoservice Ruby SDK

Production-ready Ruby SDK for building [Blok](https://github.com/blok-dev/sdks) workflow nodes. Each node runs inside a Docker container exposing a simple HTTP protocol:

- **POST /execute** -- Receives an `ExecutionRequest` (JSON), returns an `ExecutionResult` (JSON), always HTTP 200.
- **GET /health** -- Returns a `HealthStatus` (JSON) with loaded node names.

## Requirements

- Ruby >= 3.1
- Bundler >= 2.0

## Installation

Add to your Gemfile:

```ruby
gem "nanoservice-ruby"
```

Or install directly:

```sh
gem install nanoservice-ruby
```

## Quick Start

### 1. Create a node

```ruby
# my_node.rb
require "nanoservice"

class GreetNode < Nanoservice::Node::NodeHandler
  def execute(ctx, config)
    name   = ctx.request.body_str("name") || "World"
    prefix = config["prefix"] || "Hello"

    message = "#{prefix}, #{name}!"
    ctx.set_var("greeting", message)

    { "message" => message, "language" => "ruby" }
  end
end
```

### 2. Register and run

```ruby
# config.ru
require "nanoservice"
require_relative "my_node"

registry = Nanoservice::Server::RuntimeApp.registry
registry.register("greet", GreetNode.new)

run Nanoservice::Server::RuntimeApp
```

```sh
bundle exec rackup --host 0.0.0.0 --port 8080
```

### 3. Test it

```sh
curl -X POST http://localhost:8080/execute \
  -H "Content-Type: application/json" \
  -d '{
    "node": { "name": "greet", "config": { "prefix": "Hi" } },
    "context": {
      "id": "exec-1",
      "request": { "body": { "name": "Blok" } }
    }
  }'
```

Response:

```json
{
  "success": true,
  "data": { "message": "Hi, Blok!", "language": "ruby" },
  "metrics": { "duration_ms": 0.42 }
}
```

## Configuration

Use environment variables to configure the runtime:

| Variable      | Default   | Description                     |
|---------------|-----------|---------------------------------|
| `PORT`        | `8080`    | HTTP server port                |
| `HOST`        | `0.0.0.0` | Bind address                   |
| `VERSION`     | `1.0.0`   | Runtime version                 |
| `LOG_LEVEL`   | `INFO`    | Minimum log level (DEBUG/INFO/WARN/ERROR) |
| `ENABLE_CORS` | `false`   | Enable CORS headers             |

```ruby
config = Nanoservice::Config::ServerConfig.from_env
```

## Middleware

Add cross-cutting concerns to the execution pipeline:

```ruby
logger = Nanoservice::Logging::Logger.new(:debug)

registry = Nanoservice::Node::NodeRegistry.new
registry.use(Nanoservice::Middleware::LoggingMiddleware.new(logger))
registry.use(Nanoservice::Middleware::RecoveryMiddleware.new)
registry.register("my-node", MyNode.new)
```

### Custom Middleware

```ruby
class TimingMiddleware < Nanoservice::Middleware::Middleware
  def wrap(handler)
    ->(ctx, config) {
      start = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      result = handler.call(ctx, config)
      elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - start
      puts "Node executed in #{(elapsed * 1000).round(2)}ms"
      result
    }
  end
end
```

## Schema Validation

Validate data against JSON Schema (subset):

```ruby
validator = Nanoservice::Validation::SchemaValidator.new

schema = {
  "type" => "object",
  "required" => ["name", "email"],
  "properties" => {
    "name"  => { "type" => "string", "minLength" => 1 },
    "email" => { "type" => "string" }
  }
}

errors = validator.validate({ "name" => "John" }, schema)
# => ["$: missing required field \"email\""]
```

## Error Handling

Use structured errors with categories:

```ruby
raise Nanoservice::Errors::NodeError.validation("name is required")
raise Nanoservice::Errors::NodeError.configuration("missing API key")
raise Nanoservice::Errors::NodeError.network("connection timed out")
raise Nanoservice::Errors::NodeError.not_found("user not found")
raise Nanoservice::Errors::NodeError.execution("unexpected failure")
```

## Testing

### MockContext Builder

```ruby
require "minitest/autorun"
require "nanoservice"

class GreetNodeTest < Minitest::Test
  def test_greet_default
    ctx = Nanoservice::Testing::MockContext.new
      .with_body({ "name" => "World" })
      .build

    node   = GreetNode.new
    result = node.execute(ctx, {})

    assert_equal "Hello, World!", result["message"]
  end
end
```

### TestRunner

```ruby
runner = Nanoservice::Testing::TestRunner.new
runner.register("greet", GreetNode.new)

ctx = Nanoservice::Testing::MockContext.new.with_body({ "name" => "Test" }).build
result = runner.execute("greet", ctx, { "prefix" => "Hi" })

assert result.success
assert_equal "Hi, Test!", result.data["message"]
```

## Docker

```sh
docker build -t my-node .
docker run -p 8080:8080 my-node
```

## License

MIT
