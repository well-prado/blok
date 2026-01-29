# Blok Nanoservice PHP SDK

PHP SDK for building [Blok](https://github.com/deskree/blok) nanoservice nodes. This SDK provides everything needed to create, test, and deploy workflow nodes that execute within the Blok orchestration framework.

## Requirements

- PHP 8.2 or later
- Composer 2.x

## Installation

```bash
composer require blok/nanoservice-php
```

## Quick Start

### 1. Create a Node

```php
<?php

declare(strict_types=1);

use Blok\Nanoservice\Node\NodeHandler;
use Blok\Nanoservice\Types\Context;

class GreetingNode implements NodeHandler
{
    public function execute(Context $ctx, array $config): mixed
    {
        $name = $ctx->request->bodyStr('name') ?? 'World';
        $prefix = $config['prefix'] ?? 'Hello';

        $message = sprintf('%s, %s!', $prefix, $name);
        $ctx->setVar('greeting', $message);

        return ['message' => $message];
    }
}
```

### 2. Register and Serve

```php
<?php

declare(strict_types=1);

require_once __DIR__ . '/vendor/autoload.php';

use Blok\Nanoservice\Node\NodeRegistry;
use Blok\Nanoservice\Server\Server;

$registry = new NodeRegistry('1.0.0');
$registry->register('greeting', new GreetingNode());

$server = new Server($registry);
$server->start();
```

### 3. Run

```bash
PORT=8080 php serve.php
```

Or with Docker:

```bash
docker build -t my-nanoservice .
docker run -p 8080:8080 my-nanoservice
```

### 4. Test the Endpoint

```bash
# Health check
curl http://localhost:8080/health

# Execute a node
curl -X POST http://localhost:8080/execute \
  -H 'Content-Type: application/json' \
  -d '{
    "node": {
      "name": "greeting",
      "config": {"prefix": "Hi"}
    },
    "context": {
      "id": "exec-1",
      "workflow_name": "demo",
      "request": {
        "body": {"name": "Blok"}
      }
    }
  }'
```

## Configuration

The server reads configuration from environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server bind address |
| `VERSION` | `1.0.0` | Runtime version reported in health |
| `LOG_LEVEL` | `INFO` | Minimum log level (DEBUG, INFO, WARN, ERROR) |
| `ENABLE_CORS` | `false` | Enable CORS headers |

You can also create a `ServerConfig` programmatically:

```php
use Blok\Nanoservice\Config\ServerConfig;
use Blok\Nanoservice\Logging\LogLevel;

$config = new ServerConfig(
    port: 9090,
    host: '127.0.0.1',
    version: '2.0.0',
    logLevel: LogLevel::Debug,
    enableCors: true,
);

$server = new Server($registry, $config);
```

## Middleware

Middleware wraps node handlers to add cross-cutting behavior like logging, validation, or timing.

### Creating Middleware

```php
use Blok\Nanoservice\Node\NodeHandler;
use Blok\Nanoservice\Server\Middleware;
use Blok\Nanoservice\Types\Context;

class TimingMiddleware implements Middleware
{
    public function wrap(NodeHandler $next): NodeHandler
    {
        return new class($next) implements NodeHandler {
            public function __construct(private readonly NodeHandler $inner) {}

            public function execute(Context $ctx, array $config): mixed
            {
                $start = hrtime(true);
                $result = $this->inner->execute($ctx, $config);
                $durationMs = (hrtime(true) - $start) / 1_000_000;
                $ctx->setVar('execution_time_ms', $durationMs);
                return $result;
            }
        };
    }
}
```

### Applying Middleware

```php
$registry = new NodeRegistry('1.0.0');
$registry->register('my-node', new MyNode());
$registry->useMiddleware(new TimingMiddleware());
```

Middleware is applied in registration order. The last registered middleware wraps outermost.

## Schema Validation

Validate data against JSON Schema (Draft 7 subset):

```php
use Blok\Nanoservice\Validation\SchemaValidator;

$validator = new SchemaValidator();
$errors = $validator->validate($data, [
    'type' => 'object',
    'required' => ['name', 'email'],
    'properties' => [
        'name' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 100],
        'email' => ['type' => 'string'],
        'age' => ['type' => 'integer', 'minimum' => 0, 'maximum' => 150],
        'tags' => ['type' => 'array', 'items' => ['type' => 'string'], 'minItems' => 1],
    ],
]);

if (!empty($errors)) {
    throw NodeException::validation('Invalid input', $errors);
}
```

Supported schema keywords: `type`, `required`, `properties`, `enum`, `minLength`, `maxLength`, `minimum`, `maximum`, `items`, `minItems`, `maxItems`.

## Logging

Capture structured logs that are returned in the `ExecutionResult.logs` field:

```php
use Blok\Nanoservice\Logging\Logger;
use Blok\Nanoservice\Logging\LogLevel;

$logger = new Logger(LogLevel::Debug);
$logger->info('Processing request');
$logger->debugWith('Request details', ['method' => 'POST', 'path' => '/api']);
$logger->warn('Deprecated field used');
$logger->errorWith('Failed to connect', ['host' => 'api.example.com']);

// Get formatted log lines for ExecutionResult
$result->withLogs($logger->lines());
```

## Error Handling

Use `NodeException` for structured errors with categories:

```php
use Blok\Nanoservice\Errors\NodeException;

// Factory methods create exceptions with appropriate codes
throw NodeException::validation('Name is required');     // 400
throw NodeException::execution('Processing failed');     // 500
throw NodeException::configuration('Missing API key');   // 500
throw NodeException::network('Connection timed out');    // 502
throw NodeException::notFound('User not found');         // 404

// With details
throw NodeException::validation('Invalid fields', [
    'name' => 'must not be empty',
    'email' => 'invalid format',
]);
```

## Testing

The SDK includes testing utilities for unit testing nodes without starting a server.

### Using MockContext

```php
use Blok\Nanoservice\Testing\MockContext;

$ctx = MockContext::create()
    ->withId('test-1')
    ->withWorkflow('my-workflow', '/workflows/my')
    ->withBody(['name' => 'Test User', 'email' => 'test@example.com'])
    ->withHeaders(['Authorization' => 'Bearer token'])
    ->withVar('previous_result', ['status' => 'ok'])
    ->withEnv('API_KEY', 'test-key')
    ->build();
```

### Using TestRunner

```php
use Blok\Nanoservice\Testing\MockContext;
use Blok\Nanoservice\Testing\TestRunner;

$runner = new TestRunner();
$runner->register('greeting', new GreetingNode());

$ctx = MockContext::create()
    ->withBody(['name' => 'PHPUnit'])
    ->build();

$result = $runner->execute('greeting', $ctx, ['prefix' => 'Hi']);

// Assert helpers
$data = TestRunner::assertSuccess($result);
$this->assertEquals('Hi, PHPUnit!', $data['message']);
```

### PHPUnit Example

```php
use PHPUnit\Framework\TestCase;
use Blok\Nanoservice\Testing\MockContext;

class GreetingNodeTest extends TestCase
{
    public function testDefaultGreeting(): void
    {
        $node = new GreetingNode();
        $ctx = MockContext::create()->build();
        $result = $node->execute($ctx, []);

        $this->assertEquals('Hello, World!', $result['message']);
    }

    public function testCustomName(): void
    {
        $node = new GreetingNode();
        $ctx = MockContext::create()
            ->withBody(['name' => 'Blok'])
            ->build();
        $result = $node->execute($ctx, []);

        $this->assertEquals('Hello, Blok!', $result['message']);
    }
}
```

## HTTP Protocol

The nanoservice runtime exposes two endpoints:

### POST /execute

Receives an `ExecutionRequest` and returns an `ExecutionResult` (always HTTP 200).

**Request:**
```json
{
  "node": {
    "name": "hello-world",
    "path": "",
    "type": "",
    "config": {}
  },
  "context": {
    "id": "exec-123",
    "workflow_name": "my-workflow",
    "workflow_path": "/workflows/my",
    "request": {
      "body": {},
      "headers": {},
      "params": {},
      "query": {},
      "method": "POST",
      "url": "/api/endpoint"
    },
    "response": {},
    "vars": {},
    "env": {}
  }
}
```

**Response (success):**
```json
{
  "success": true,
  "data": {"message": "Hello, World!"},
  "metrics": {
    "duration_ms": 1.234,
    "memory_bytes": 2097152
  }
}
```

**Response (error):**
```json
{
  "success": false,
  "data": null,
  "errors": {"message": "node 'unknown' not found in registry"}
}
```

### GET /health

Returns the runtime health status.

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "nodes_loaded": ["hello-world", "api-call", "transform-data"]
}
```

## Development

```bash
# Install dependencies
composer install

# Run tests
composer test

# Start the example server
composer serve
```

## License

MIT
