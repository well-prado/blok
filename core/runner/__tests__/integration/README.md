# Integration Tests

> **Status:** 🚧 In Progress (Day 4)
> **Purpose:** End-to-end testing of the runtime adapter system

---

## Overview

This directory contains integration tests that verify the runtime adapter system works end-to-end with real workflows, containers, and multi-language execution.

### Test Structure

```
integration/
├── setup.ts                    # Global test setup (Docker check, env config)
├── runtimes/                   # Runtime-specific integration tests
│   ├── nodejs.integration.test.ts
│   ├── python3.integration.test.ts
│   ├── docker.integration.test.ts
│   └── multi-runtime.integration.test.ts
├── fixtures/                   # Test data and workflows
│   ├── workflows/              # Workflow JSON files
│   └── nodes/                  # Test node implementations
├── helpers/                    # Test utilities
│   ├── dockerTestUtils.ts      # Docker helpers
│   ├── workflowRunner.ts       # Workflow execution helpers
│   ├── performanceMeasure.ts   # Performance measurement
│   └── index.ts                # Central exports
└── benchmarks/                 # Performance benchmarks

```

---

## Running Integration Tests

### Prerequisites

**Required:**
- Node.js 18+
- Python 3.8+ (for Python runtime tests)
- Docker (for Docker runtime tests)

**Optional:**
- Go 1.21+ (for building Go runtime images)
- Java 17+ (for building Java runtime images)

### Run All Integration Tests

```bash
# From core/runner directory
pnpm test:integration

# Or with coverage
pnpm test:integration:coverage
```

### Run Specific Test Suite

```bash
# NodeJS runtime tests only
pnpm vitest run __tests__/integration/runtimes/nodejs.integration.test.ts

# Python3 runtime tests only
pnpm vitest run __tests__/integration/runtimes/python3.integration.test.ts

# Docker runtime tests only
pnpm vitest run __tests__/integration/runtimes/docker.integration.test.ts
```

### Run with Watch Mode

```bash
pnpm vitest watch --config vitest.integration.config.ts
```

---

## Test Helpers

### Docker Utilities

```typescript
import { buildDockerImage, startContainer, waitForHealthy } from './helpers';

// Build a test image
await buildDockerImage('blok-runtime-go:test', './examples/runtimes/go');

// Start a container
const containerId = await startContainer('blok-runtime-go:test', 'test-go-1');

// Wait for it to be ready
await waitForHealthy(containerId);
```

### Workflow Runner

```typescript
import { loadWorkflow, executeWorkflow, assertWorkflowSuccess } from './helpers';

// Load workflow fixture
const workflow = loadWorkflow('simple-nodejs-workflow.json');

// Execute it
const result = await executeWorkflow(workflow, {
  body: { message: 'Hello World' }
});

// Assert success
assertWorkflowSuccess(result);
```

### Performance Measurement

```typescript
import { PerformanceMeasure } from './helpers';

const measure = new PerformanceMeasure();

// Measure with warmup
await measure.measureWithWarmup(
  async () => executeWorkflow(workflow),
  warmup: 5,
  iterations: 100
);

// Get stats
const stats = measure.getStats();
console.log(`Mean: ${stats.mean}ms, P95: ${stats.p95}ms`);

// Assert performance
measure.assertPerformance('p95', 5); // P95 must be < 5ms
```

---

## Test Fixtures

### Workflows

Workflow fixtures are JSON files in `fixtures/workflows/`:

- `simple-nodejs-workflow.json` - Basic TypeScript node execution
- `simple-python-workflow.json` - Basic Python node execution
- `simple-go-workflow.json` - Basic Go node execution (Docker)
- `polyglot-workflow.json` - Multi-runtime workflow (TS → Py → Go)

### Nodes

Test nodes are in `fixtures/nodes/`:

- `test-echo-node/` - Simple echo node (TypeScript)
- `test-python-node/` - Simple Python node
- `test-go-node/` - Simple Go node

---

## Environment Detection

The test setup automatically detects available environments:

```typescript
// Tests are skipped if Docker is not available
it.skipIf(!process.env.DOCKER_AVAILABLE)('should run Docker test', async () => {
  // ...
});

// Tests are skipped if Python is not available
it.skipIf(!process.env.PYTHON3_AVAILABLE)('should run Python test', async () => {
  // ...
});
```

---

## Performance Targets

### Runtime Overhead Targets

| Runtime | Target Overhead (P95) | Status |
|---------|----------------------|--------|
| NodeJS (in-process) | < 1ms | 🎯 Target |
| Python3 (gRPC warm) | < 5ms | 🎯 Target |
| Docker Go (warm pool) | < 5ms | 🎯 Target |
| Docker Java (warm pool) | < 5ms | 🎯 Target |

### Workflow Execution Targets

| Workflow Type | Target Latency (P95) | Status |
|---------------|---------------------|--------|
| Single node (NodeJS) | < 5ms | 🎯 Target |
| Single node (Python) | < 10ms | 🎯 Target |
| Single node (Docker) | < 10ms | 🎯 Target |
| Multi-runtime (3 steps) | < 50ms | 🎯 Target |

---

## Debugging Integration Tests

### View Docker Logs

```bash
# List running test containers
docker ps | grep blok-test

# View logs
docker logs <container-id>
```

### Enable Verbose Logging

```bash
# Set log level before running tests
LOG_LEVEL=debug pnpm test:integration
```

### Keep Containers Running

Set `KEEP_CONTAINERS=true` to prevent cleanup:

```bash
KEEP_CONTAINERS=true pnpm test:integration
```

---

## CI/CD Integration

### GitHub Actions Example

```yaml
- name: Run Integration Tests
  run: |
    # Start Python runtime
    python3 runtimes/python3/main.py &

    # Build Docker images
    docker build -t blok-runtime-go:test ./examples/runtimes/go

    # Run tests
    cd core/runner
    pnpm test:integration
```

---

## Contributing

When adding new integration tests:

1. **Follow naming convention:** `*.integration.test.ts`
2. **Use test helpers:** Import from `./helpers`
3. **Add fixtures:** Create workflow/node fixtures as needed
4. **Document performance:** Add performance targets to this README
5. **Handle cleanup:** Use `afterAll` to clean up resources

---

## Troubleshooting

### Docker Tests Failing

```bash
# Check Docker is running
docker --version

# Check images exist
docker images | grep blok-runtime

# Rebuild images
docker build -t blok-runtime-go:test ./examples/runtimes/go --no-cache
```

### Python Tests Failing

```bash
# Check Python is available
python3 --version

# Start Python runtime manually
cd runtimes/python3
python3 main.py

# Test connection
curl http://localhost:50051
```

### Timeouts

Increase timeouts in `vitest.integration.config.ts`:

```typescript
testTimeout: 120000, // 2 minutes
```

---

**Created:** 2026-01-27 (Day 4)
**Status:** 🚧 In Progress
