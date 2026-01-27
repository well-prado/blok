# 🧪 PHASE 1D: Testing & Benchmarks Framework

> **Start Date**: 2026-01-27
> **Target Completion**: Week 4 (2026-02-03)
> **Status**: 🚧 In Progress
> **Phase 1 Overall**: 90% → 95% (target)

## Executive Summary

Phase 1D focuses on ensuring the quality, reliability, and performance of the runtime adapter system built in Phases 1A, 1B, and 1C. This phase will establish:

- **95%+ test coverage** for all runtime adapters
- **< 5ms overhead** per runtime adapter call
- **100% backward compatibility** with existing workflows
- **Production-ready quality** for all components

## Table of Contents

1. [Testing Strategy](#testing-strategy)
2. [Unit Tests](#unit-tests)
3. [Integration Tests](#integration-tests)
4. [E2E Tests](#e2e-tests)
5. [Performance Benchmarks](#performance-benchmarks)
6. [Backward Compatibility Tests](#backward-compatibility-tests)
7. [Load Testing](#load-testing)
8. [Success Metrics](#success-metrics)

---

## Testing Strategy

### Test Pyramid

```
                 /\
                /  \
               /E2E \          5% - End-to-end workflow tests
              /______\
             /        \
            /Integration\     25% - Adapter integration tests
           /____________\
          /              \
         /  Unit Tests    \   70% - Component unit tests
        /__________________\
```

### Coverage Targets

| Component | Current | Target | Priority |
|-----------|---------|--------|----------|
| RuntimeRegistry | 0% | 95% | 🔴 Critical |
| NodeJsRuntimeAdapter | 0% | 95% | 🔴 Critical |
| Python3RuntimeAdapter | 50% | 95% | 🔴 Critical |
| DockerRuntimeAdapter | 0% | 95% | 🔴 Critical |
| RuntimeAdapterNode | 0% | 90% | 🟡 High |
| CLI node creation | 35% | 85% | 🟡 High |
| Workflow helper (runtime) | 0% | 90% | 🟡 High |

### Testing Tools

- **Unit Tests**: Jest + ts-jest
- **Integration Tests**: Jest + Docker Compose
- **E2E Tests**: Jest + Supertest
- **Benchmarks**: Benchmark.js + autocannon
- **Coverage**: Jest coverage reports
- **CI/CD**: GitHub Actions (existing)

---

## Unit Tests

### 1. RuntimeRegistry Tests

**File**: `core/runner/src/__tests__/RuntimeRegistry.test.ts`

**Test Cases**:
- ✅ Singleton pattern (getInstance returns same instance)
- ✅ Register adapter successfully
- ✅ Get registered adapter by kind
- ✅ Throw error when getting unregistered adapter
- ✅ Check if adapter exists (has method)
- ✅ Get all registered kinds
- ✅ Prevent duplicate registration (should overwrite)
- ✅ Handle invalid adapter (missing kind or execute)

**Coverage Target**: 95%+

**Key Scenarios**:
```typescript
describe('RuntimeRegistry', () => {
  it('should be a singleton', () => {
    const instance1 = RuntimeRegistry.getInstance();
    const instance2 = RuntimeRegistry.getInstance();
    expect(instance1).toBe(instance2);
  });

  it('should register and retrieve adapters', () => {
    const registry = RuntimeRegistry.getInstance();
    const mockAdapter: RuntimeAdapter = {
      kind: 'nodejs',
      execute: jest.fn()
    };

    registry.register(mockAdapter);
    const retrieved = registry.get('nodejs');

    expect(retrieved).toBe(mockAdapter);
    expect(registry.has('nodejs')).toBe(true);
  });

  it('should throw when getting unregistered adapter', () => {
    const registry = RuntimeRegistry.getInstance();
    expect(() => registry.get('rust' as RuntimeKind)).toThrow();
  });
});
```

### 2. NodeJsRuntimeAdapter Tests

**File**: `core/runner/src/adapters/__tests__/NodeJsRuntimeAdapter.test.ts`

**Test Cases**:
- ✅ Execute module node successfully
- ✅ Execute local node successfully
- ✅ Handle module node execution error
- ✅ Handle local node execution error
- ✅ Return ExecutionResult with correct structure
- ✅ Measure execution duration accurately
- ✅ Handle missing node gracefully
- ✅ Pass context correctly to node
- ✅ Handle NanoServiceResponse mapping
- ✅ Capture logs from node execution
- ✅ Handle async node execution

**Coverage Target**: 95%+

**Key Scenarios**:
```typescript
describe('NodeJsRuntimeAdapter', () => {
  let adapter: NodeJsRuntimeAdapter;
  let mockConfiguration: Configuration;
  let mockContext: Context;

  beforeEach(() => {
    mockConfiguration = createMockConfiguration();
    adapter = new NodeJsRuntimeAdapter(mockConfiguration);
    mockContext = createMockContext();
  });

  it('should execute module node successfully', async () => {
    const node = createMockRunnerNode({
      type: 'module',
      name: 'test-node'
    });

    const result = await adapter.execute(node, mockContext);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.errors).toBeNull();
    expect(result.metrics?.duration_ms).toBeGreaterThan(0);
  });

  it('should handle execution errors', async () => {
    const node = createMockRunnerNode({
      type: 'module',
      name: 'failing-node'
    });

    const result = await adapter.execute(node, mockContext);

    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.data).toBeNull();
  });

  it('should measure execution time accurately', async () => {
    const node = createMockRunnerNode({ type: 'module' });

    const start = Date.now();
    const result = await adapter.execute(node, mockContext);
    const end = Date.now();

    const measuredTime = result.metrics?.duration_ms || 0;
    const actualTime = end - start;

    expect(measuredTime).toBeGreaterThanOrEqual(0);
    expect(measuredTime).toBeLessThanOrEqual(actualTime + 10); // 10ms tolerance
  });
});
```

### 3. Python3RuntimeAdapter Tests

**File**: `core/runner/src/adapters/__tests__/Python3RuntimeAdapter.test.ts`

**Test Cases**:
- ✅ Connect to Python gRPC server
- ✅ Execute Python node successfully
- ✅ Handle gRPC connection error
- ✅ Handle node execution timeout
- ✅ Handle Python node errors
- ✅ Map gRPC response to ExecutionResult
- ✅ Handle context serialization
- ✅ Handle large payloads
- ✅ Reconnect after connection loss
- ✅ Handle concurrent executions

**Coverage Target**: 95%+

**Key Scenarios**:
```typescript
describe('Python3RuntimeAdapter', () => {
  let adapter: Python3RuntimeAdapter;
  let mockGrpcClient: MockGrpcClient;

  beforeEach(() => {
    mockGrpcClient = createMockGrpcClient();
    adapter = new Python3RuntimeAdapter('localhost:50051');
  });

  it('should execute Python node successfully', async () => {
    const node = createMockRunnerNode({ runtime: 'python3' });
    const context = createMockContext();

    mockGrpcClient.mockExecuteSuccess({
      success: true,
      data: { result: 'processed' },
      errors: null
    });

    const result = await adapter.execute(node, context);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ result: 'processed' });
  });

  it('should handle gRPC timeout', async () => {
    const node = createMockRunnerNode({ runtime: 'python3' });
    const context = createMockContext();

    mockGrpcClient.mockTimeout();

    const result = await adapter.execute(node, context);

    expect(result.success).toBe(false);
    expect(result.errors).toContain('timeout');
  });
});
```

### 4. DockerRuntimeAdapter Tests

**File**: `core/runner/src/adapters/__tests__/DockerRuntimeAdapter.test.ts`

**Test Cases**:
- ✅ Initialize container pool
- ✅ Get container from pool
- ✅ Execute node in container
- ✅ Return container to pool
- ✅ Handle container health checks
- ✅ Recycle unhealthy containers
- ✅ Scale pool up under load
- ✅ Scale pool down when idle
- ✅ Handle container creation errors
- ✅ Handle HTTP execution errors
- ✅ Clean up on shutdown
- ✅ Handle concurrent requests
- ✅ Respect max pool size
- ✅ Handle port conflicts

**Coverage Target**: 95%+

**Key Scenarios**:
```typescript
describe('DockerRuntimeAdapter', () => {
  let adapter: DockerRuntimeAdapter;

  beforeEach(async () => {
    adapter = new DockerRuntimeAdapter({
      imageName: 'blok-test-runtime:latest',
      minPoolSize: 2,
      maxPoolSize: 5
    });
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.cleanup();
  });

  it('should initialize container pool', async () => {
    const poolSize = adapter.getPoolSize();
    expect(poolSize).toBeGreaterThanOrEqual(2);
  });

  it('should execute node in container', async () => {
    const node = createMockRunnerNode({ runtime: 'docker' });
    const context = createMockContext();

    const result = await adapter.execute(node, context);

    expect(result.success).toBe(true);
    expect(result.metrics?.duration_ms).toBeLessThan(100); // Should be fast with pool
  });

  it('should scale pool under load', async () => {
    const node = createMockRunnerNode({ runtime: 'docker' });
    const context = createMockContext();

    // Simulate high load
    const promises = Array(10).fill(null).map(() =>
      adapter.execute(node, context)
    );

    await Promise.all(promises);

    const poolSize = adapter.getPoolSize();
    expect(poolSize).toBeGreaterThan(2); // Should scale up
  });

  it('should handle container failures gracefully', async () => {
    // Force a container to fail
    await adapter.killRandomContainer();

    const node = createMockRunnerNode({ runtime: 'docker' });
    const context = createMockContext();

    // Should still work by creating new container
    const result = await adapter.execute(node, context);
    expect(result.success).toBe(true);
  });
});
```

---

## Integration Tests

### 1. Adapter Switching Tests

**File**: `core/runner/src/__tests__/integration/adapter-switching.test.ts`

**Test Cases**:
- ✅ Switch from NodeJS to Python adapter
- ✅ Switch from Python to Docker adapter
- ✅ Switch from Docker to NodeJS adapter
- ✅ Execute workflow with multiple adapter types
- ✅ Handle adapter errors and fallback
- ✅ Maintain context across adapter switches

**Key Scenario**:
```typescript
describe('Adapter Switching Integration', () => {
  it('should execute multi-runtime workflow', async () => {
    const workflow = {
      steps: [
        { name: 'step1', type: 'module', runtime: 'nodejs' },
        { name: 'step2', type: 'runtime.python3', runtime: 'python3' },
        { name: 'step3', type: 'runtime.go', runtime: 'docker' }
      ]
    };

    const result = await runWorkflow(workflow);

    expect(result.success).toBe(true);
    expect(result.steps[0].adapter).toBe('nodejs');
    expect(result.steps[1].adapter).toBe('python3');
    expect(result.steps[2].adapter).toBe('docker');
  });
});
```

### 2. CLI Integration Tests

**File**: `packages/cli/src/__tests__/integration/node-creation.test.ts`

**Test Cases**:
- ✅ Create TypeScript node via CLI
- ✅ Create Python node via CLI
- ✅ Create Go node via CLI
- ✅ Create Java node via CLI
- ✅ Verify file structure for each runtime
- ✅ Verify Dockerfile is valid
- ✅ Verify node can be built
- ✅ Verify node can be executed

---

## E2E Tests

### 1. Multi-Language Workflow Tests

**File**: `core/runner/src/__tests__/e2e/multi-language-workflow.test.ts`

**Test Cases**:
- ✅ Execute workflow with TypeScript → Python → Go nodes
- ✅ Execute workflow with Python → Java → TypeScript nodes
- ✅ Verify data flows correctly between languages
- ✅ Verify context is serialized properly
- ✅ Verify errors are handled correctly
- ✅ Verify metrics are collected

**Key Scenario**:
```typescript
describe('Multi-Language Workflow E2E', () => {
  it('should execute TypeScript → Python → Go workflow', async () => {
    // Setup
    await startHttpTrigger();
    await startPythonRuntime();
    await startGoContainer();

    // Execute
    const response = await fetch('http://localhost:3000/api/test', {
      method: 'POST',
      body: JSON.stringify({ input: 'test data' })
    });

    const result = await response.json();

    // Verify
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].runtime).toBe('nodejs');
    expect(result.steps[1].runtime).toBe('python3');
    expect(result.steps[2].runtime).toBe('go');

    // Cleanup
    await stopAllServices();
  });
});
```

---

## Performance Benchmarks

### 1. Adapter Overhead Benchmarks

**File**: `core/runner/src/__tests__/benchmarks/adapter-overhead.bench.ts`

**Target**: < 5ms overhead per adapter call

**Benchmarks**:
- NodeJS adapter overhead
- Python3 adapter overhead (gRPC)
- Docker adapter overhead (with warm pool)
- Docker adapter overhead (cold start)
- Adapter switching overhead

**Tool**: Benchmark.js

```typescript
import Benchmark from 'benchmark';

const suite = new Benchmark.Suite();

suite
  .add('NodeJS Adapter Execution', async () => {
    await nodejsAdapter.execute(mockNode, mockContext);
  })
  .add('Python3 Adapter Execution', async () => {
    await python3Adapter.execute(mockNode, mockContext);
  })
  .add('Docker Adapter Execution (Warm)', async () => {
    await dockerAdapter.execute(mockNode, mockContext);
  })
  .on('cycle', (event: any) => {
    console.log(String(event.target));
  })
  .on('complete', function(this: any) {
    console.log('Fastest is ' + this.filter('fastest').map('name'));
  })
  .run({ async: true });
```

### 2. Workflow Execution Benchmarks

**File**: `core/runner/src/__tests__/benchmarks/workflow-execution.bench.ts`

**Metrics**:
- Single-node workflow latency
- 3-node workflow latency
- 10-node workflow latency
- Multi-runtime workflow latency
- Throughput (workflows/second)

**Tool**: autocannon

```bash
# HTTP trigger throughput test
autocannon -c 100 -d 30 -m POST \
  -H "Content-Type: application/json" \
  -b '{"input": "test"}' \
  http://localhost:3000/api/test

# Expected: > 1000 req/sec for simple workflows
```

### 3. Container Pool Benchmarks

**File**: `core/runner/src/__tests__/benchmarks/container-pool.bench.ts`

**Metrics**:
- Container acquisition time (from pool)
- Container creation time (cold start)
- Pool scaling time
- Concurrent execution throughput
- Memory usage per container
- Container recycling time

---

## Backward Compatibility Tests

### 1. Existing Workflow Tests

**File**: `core/runner/src/__tests__/compatibility/existing-workflows.test.ts`

**Test Cases**:
- ✅ Run all example workflows from `examples/`
- ✅ Verify no breaking changes in HTTP trigger
- ✅ Verify no breaking changes in gRPC trigger
- ✅ Verify Python nodes still work
- ✅ Verify TypeScript nodes still work
- ✅ Verify context structure unchanged
- ✅ Verify response format unchanged

### 2. Node Package Compatibility Tests

**Test Cases**:
- ✅ @nanoservice-ts/api-call works unchanged
- ✅ @nanoservice-ts/if-else works unchanged
- ✅ @nanoservice-ts/react works unchanged
- ✅ All example nodes work unchanged

---

## Load Testing

### 1. Container Pool Load Tests

**File**: `core/runner/src/__tests__/load/container-pool.load.test.ts`

**Scenarios**:
- ✅ 100 concurrent requests
- ✅ 1000 concurrent requests
- ✅ Sustained load for 5 minutes
- ✅ Burst traffic patterns
- ✅ Memory leak detection
- ✅ Container leak detection

**Tool**: Artillery

```yaml
# artillery-config.yml
config:
  target: 'http://localhost:3000'
  phases:
    - duration: 60
      arrivalRate: 10
      name: "Warm up"
    - duration: 300
      arrivalRate: 100
      name: "Sustained load"
    - duration: 60
      arrivalRate: 200
      name: "Peak load"

scenarios:
  - name: "Execute multi-runtime workflow"
    flow:
      - post:
          url: "/api/test"
          json:
            input: "test data"
```

### 2. Adapter Stress Tests

**Test Cases**:
- ✅ Maximum concurrent Python executions
- ✅ Maximum concurrent Docker executions
- ✅ Maximum workflow throughput
- ✅ Error recovery under load
- ✅ Resource exhaustion handling

---

## Success Metrics

### Coverage Targets

- ✅ Overall test coverage: 90%+
- ✅ Runtime adapter coverage: 95%+
- ✅ CLI coverage: 85%+
- ✅ Workflow helper coverage: 90%+

### Performance Targets

- ✅ NodeJS adapter overhead: < 1ms
- ✅ Python3 adapter overhead: < 5ms
- ✅ Docker adapter overhead (warm): < 5ms
- ✅ Docker adapter overhead (cold): < 500ms
- ✅ Workflow throughput: > 1000 req/sec

### Quality Targets

- ✅ Zero breaking changes to existing workflows
- ✅ 100% backward compatibility
- ✅ Zero memory leaks
- ✅ Zero container leaks
- ✅ Graceful degradation under load

---

## Implementation Checklist

### Week 4 (2026-01-27 to 2026-02-03)

**Day 1-2: Unit Tests**
- [ ] Setup Jest configuration for runner package
- [ ] Write RuntimeRegistry tests (95%+ coverage)
- [ ] Write NodeJsRuntimeAdapter tests (95%+ coverage)
- [ ] Write Python3RuntimeAdapter tests (95%+ coverage)
- [ ] Write DockerRuntimeAdapter tests (95%+ coverage)

**Day 3-4: Integration Tests**
- [ ] Setup Docker Compose for integration testing
- [ ] Write adapter switching integration tests
- [ ] Write CLI node creation integration tests
- [ ] Write workflow execution integration tests

**Day 5: E2E Tests**
- [ ] Setup E2E test environment
- [ ] Write multi-language workflow E2E tests
- [ ] Write HTTP trigger E2E tests
- [ ] Write gRPC trigger E2E tests

**Day 6: Performance Benchmarks**
- [ ] Setup Benchmark.js for adapter benchmarks
- [ ] Run adapter overhead benchmarks
- [ ] Setup autocannon for workflow benchmarks
- [ ] Run workflow throughput benchmarks
- [ ] Setup Artillery for load tests
- [ ] Run container pool load tests

**Day 7: Compatibility & Documentation**
- [ ] Run backward compatibility test suite
- [ ] Verify all existing workflows pass
- [ ] Generate coverage reports
- [ ] Document test results
- [ ] Create PHASE_1D_COMPLETE.md

---

## Tools & Dependencies

### Testing Frameworks
```json
{
  "devDependencies": {
    "@types/jest": "^29.5.11",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.1",
    "supertest": "^6.3.3",
    "@types/supertest": "^6.0.2",
    "benchmark": "^2.1.4",
    "@types/benchmark": "^2.1.5",
    "autocannon": "^7.15.0",
    "artillery": "^2.0.0",
    "docker-compose": "^0.24.3"
  }
}
```

### CI/CD Integration

**GitHub Actions Workflow**: `.github/workflows/test-phase1d.yml`

```yaml
name: Phase 1D Tests

on:
  push:
    branches: [main, feature/phase-1d-testing]
  pull_request:
    branches: [main]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: pnpm install
      - run: pnpm test:unit
      - run: pnpm test:coverage

  integration-tests:
    runs-on: ubuntu-latest
    services:
      python-runtime:
        image: blok-python-runtime:latest
        ports:
          - 50051:50051
    steps:
      - uses: actions/checkout@v3
      - run: pnpm test:integration

  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: docker-compose up -d
      - run: pnpm test:e2e
      - run: docker-compose down

  benchmarks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: pnpm test:bench
      - uses: benchmark-action/github-action-benchmark@v1
```

---

## Next Steps

1. **Setup Testing Infrastructure** (Day 1)
   - Configure Jest for all packages
   - Setup Docker Compose for integration tests
   - Configure CI/CD pipelines

2. **Write Unit Tests** (Day 1-2)
   - Start with RuntimeRegistry (simplest)
   - Then NodeJsRuntimeAdapter
   - Then Python3RuntimeAdapter
   - Finally DockerRuntimeAdapter (most complex)

3. **Write Integration Tests** (Day 3-4)
   - Adapter switching
   - CLI node creation
   - Workflow execution

4. **Run Benchmarks** (Day 6)
   - Measure adapter overhead
   - Measure workflow throughput
   - Verify performance targets

5. **Document Results** (Day 7)
   - Generate coverage reports
   - Document benchmark results
   - Create completion report

---

**Status**: 🚧 Ready to Begin Implementation
**Next Action**: Setup Jest configuration and write RuntimeRegistry tests
**Owner**: Development Team
**Target Completion**: 2026-02-03

Let's build rock-solid quality into Blok! 🧪🚀
