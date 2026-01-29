# Module Reference: Testing Framework

> **Path:** `core/runner/src/testing/`
> **Purpose:** Test utilities for nodes, workflows, and integrations

## What It Does

The testing module provides a harness for testing Blok nodes and workflows in isolation. It includes mock context creation, test loggers, workflow test runners, and integration test infrastructure.

## Source Files

```
core/runner/src/testing/
├── index.ts                    # Barrel export
├── TestHarness.ts              # Node and workflow test harness (394 lines)
├── TestLogger.ts               # Test logger (captures logs for assertions) (186 lines)
└── WorkflowTestRunner.ts       # Runs full workflows in test mode (509 lines)
```

## Key APIs

### TestHarness
- Creates mock Context objects for node testing
- Provides assertion helpers for response validation
- Supports both function-first and class-based nodes
- Configurable mock data for request, vars, env

### WorkflowTestRunner
- Executes full workflow JSONs in test mode
- Captures step-by-step execution results
- Supports mock node implementations
- Validates workflow structure before execution

### TestLogger
- Captures all log messages during test execution
- Provides query methods (findErrors(), findWarnings(), etc.)
- Structured log format matching production

## Test Infrastructure

### Unit Tests
- **Runner:** `core/runner/__tests__/unit/` (defineNode, CircuitBreaker, HealthCheck, etc.)
- **Shared:** `core/shared/__tests__/unit/` (GlobalError, Metrics, NodeBase, etc.)
- **Workflow Helper:** `core/workflow-helper/tests/`
- **Adapters:** `core/runner/src/adapters/__tests__/`
- **CLI:** `packages/cli/src/commands/generate/*.test.ts`
- **VSCode:** `packages/vscode-extension/src/__tests__/`
- **LSP:** `packages/lsp-server/src/__tests__/`
- **Triggers:** `triggers/*/test/` or `triggers/*/__tests__/`

### Integration Tests
- **Path:** `core/runner/__tests__/integration/`
- **Infrastructure:** Docker-based test environment (`infra/testing/docker-compose.yml`)
- **Suites:**
  - `runtimes/nodejs.comprehensive.integration.test.ts`
  - `runtimes/python3.integration.test.ts`
  - `runtimes/docker.integration.test.ts`
  - `runtimes/cross-language.integration.test.ts`
  - `runtimes/multi-runtime.integration.test.ts`
  - `runtimes/adapter-switching.integration.test.ts`
  - `marketplace/marketplace.integration.test.ts`

### SDK Contract Tests
- **Path:** `tests/integration/sdk-contract/`
- **Purpose:** Validates all language SDKs implement the same contract
- **Uses:** Docker Compose to spin up all SDK servers

### Test Configuration
- **Vitest config (unit):** `core/runner/vitest.config.ts`
- **Vitest config (integration):** `core/runner/vitest.integration.config.ts`
- **Mutation testing:** `stryker.config.mjs`

## Docker Test Infrastructure

```yaml
# infra/testing/docker-compose.yml provides:
- PostgreSQL 16 (port 5433)
- Redis 7 (port 6380)
- Kafka (port 9094)
- RabbitMQ (ports 5673, 15673)
- NATS with JetStream (port 4223)
- Python runtime gRPC server (port 50052)
```

## Running Tests

```bash
# All tests
pnpm test

# Runner unit tests
pnpm runner:test

# Runner integration tests
cd core/runner && pnpm test:integration

# Specific test file
npx vitest run path/to/test.test.ts

# Watch mode
npx vitest path/to/test.test.ts

# With coverage
npx vitest run --coverage
```

## What to Document

1. **Testing nodes** — Using TestHarness to test individual nodes
2. **Testing workflows** — Using WorkflowTestRunner
3. **Mock context** — Creating test contexts with mock data
4. **Integration testing** — Docker test infrastructure setup
5. **SDK contract tests** — Cross-language validation
6. **Test patterns** — Best practices for Blok tests
7. **CI/CD integration** — Running tests in pipelines
