# SDK Contract Tests

Contract tests that validate all multi-language runtime SDKs conform to the canonical HTTP contract defined by `DockerRuntimeAdapter`.

## Contract

Every SDK must implement:

- **POST /execute** — JSON `ExecutionRequest` in, JSON `ExecutionResult` out (always HTTP 200 for valid requests)
- **GET /health** — JSON `{ status, version, nodes_loaded }`

## Running

### Full suite (Docker Compose)

```bash
# Build all SDKs and run tests
npm run test:full

# Or step by step:
docker compose up -d --build
npm run test
docker compose down
```

### Single SDK

```bash
# Test only Go SDK running locally
SDK_FILTER=go SDK_GO_URL=http://localhost:8080 npx tsx contract.test.ts
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SDK_FILTER` | (all) | Comma-separated list of SDKs to test: `go,rust,java,csharp,php,ruby` |
| `SDK_GO_URL` | `http://localhost:9001` | Go SDK endpoint |
| `SDK_RUST_URL` | `http://localhost:9002` | Rust SDK endpoint |
| `SDK_JAVA_URL` | `http://localhost:9003` | Java SDK endpoint |
| `SDK_CSHARP_URL` | `http://localhost:9004` | C# SDK endpoint |
| `SDK_PHP_URL` | `http://localhost:9005` | PHP SDK endpoint |
| `SDK_RUBY_URL` | `http://localhost:9006` | Ruby SDK endpoint |

## Test Cases (10 per SDK)

1. Health check returns status, version, and nodes_loaded
2. Health check lists registered nodes including hello-world
3. HelloWorld executes with default name
4. HelloWorld executes with custom name
5. HelloWorld executes with config prefix
6. Non-existent node returns success: false
7. Invalid JSON body returns 400
8. Execution response includes metrics
9. Multiple nodes are registered
10. ExecutionResult has correct shape (success, data, errors fields)
