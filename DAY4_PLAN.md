# DAY 4 PLAN: Integration Tests & Phase 1 Completion

> **Date:** 2026-01-27 (Night) → 2026-01-28
> **Mission:** Complete Phase 1 with Integration Tests, Performance Benchmarks, and Real-World Validation
> **Status:** 🚀 LET'S GO!

---

## 🎯 Day 4 Objectives

### Primary Goal
**Prove the runtime adapter system works end-to-end with real workflows**

### Success Criteria
- ✅ Integration tests for all 3 adapters (NodeJS, Python3, Docker)
- ✅ Multi-runtime workflow test (TypeScript → Python → Go in one workflow)
- ✅ Performance benchmarks showing < 5ms overhead
- ✅ Docker containers actually run Go/Java nodes
- ✅ Backward compatibility verified (existing workflows unchanged)
- ✅ Phase 1 marked as 100% COMPLETE

---

## 📋 Task Breakdown

### Phase 1: Integration Test Infrastructure (1-2 hours)

**1.1: Set Up Integration Test Environment**
```bash
# Create integration test structure
core/runner/__tests__/integration/
├── runtimes/
│   ├── nodejs.integration.test.ts
│   ├── python3.integration.test.ts
│   ├── docker.integration.test.ts
│   └── multi-runtime.integration.test.ts
├── fixtures/
│   ├── workflows/
│   │   ├── nodejs-workflow.json
│   │   ├── python-workflow.json
│   │   ├── go-workflow.json
│   │   └── polyglot-workflow.json
│   └── nodes/
│       ├── test-node-ts/
│       ├── test-node-py/
│       ├── test-node-go/
│       └── test-node-java/
└── helpers/
    ├── dockerTestUtils.ts
    ├── workflowRunner.ts
    └── performanceMeasure.ts
```

**Tasks:**
- [ ] Create integration test directory structure
- [ ] Set up Vitest config for integration tests
- [ ] Create test helper utilities
- [ ] Set up Docker test environment detection

**Files to Create:**
- `core/runner/__tests__/integration/setup.ts`
- `core/runner/__tests__/integration/helpers/dockerTestUtils.ts`
- `core/runner/vitest.integration.config.ts`

---

### Phase 2: NodeJS Runtime Integration Tests (30-45 min)

**Test Scenarios:**
1. ✅ Execute simple TypeScript node in workflow
2. ✅ Execute node with Context propagation
3. ✅ Execute node with env vars
4. ✅ Execute node with errors (verify GlobalError handling)
5. ✅ Execute multiple TypeScript nodes in sequence
6. ✅ Verify < 1ms overhead for in-process execution

**Test File:** `core/runner/__tests__/integration/runtimes/nodejs.integration.test.ts`

**Example Test:**
```typescript
describe('NodeJsRuntimeAdapter - Integration', () => {
  it('should execute real TypeScript workflow', async () => {
    const workflow = loadWorkflow('nodejs-workflow.json');
    const result = await executeWorkflow(workflow, {
      input: { message: 'Hello World' }
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      message: 'Hello World'
    });
  });

  it('should measure execution overhead', async () => {
    const start = performance.now();
    await executeSimpleNode();
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(1); // < 1ms for in-process
  });
});
```

---

### Phase 3: Python3 Runtime Integration Tests (30-45 min)

**Test Scenarios:**
1. ✅ Start Python gRPC runtime server
2. ✅ Execute simple Python node via gRPC
3. ✅ Verify Context serialization/deserialization
4. ✅ Test error handling across gRPC boundary
5. ✅ Verify cleanup and connection pooling
6. ✅ Measure gRPC overhead (should be < 5ms)

**Prerequisites:**
- Python runtime server must be running on port 50051
- Use test fixture Python nodes

**Test File:** `core/runner/__tests__/integration/runtimes/python3.integration.test.ts`

**Example Test:**
```typescript
describe('Python3RuntimeAdapter - Integration', () => {
  let pythonServer: ChildProcess;

  beforeAll(async () => {
    // Start Python runtime server
    pythonServer = spawn('python3', [
      'runtimes/python3/main.py'
    ]);
    await waitForPort(50051);
  });

  afterAll(() => {
    pythonServer.kill();
  });

  it('should execute Python node via gRPC', async () => {
    const workflow = loadWorkflow('python-workflow.json');
    const result = await executeWorkflow(workflow, {
      input: { value: 42 }
    });

    expect(result.success).toBe(true);
    expect(result.data.value).toBe(42);
  });
});
```

---

### Phase 4: Docker Runtime Integration Tests (1-2 hours)

**Test Scenarios:**
1. ✅ Build Go runtime Docker image
2. ✅ Build Java runtime Docker image
3. ✅ Start containers and verify health
4. ✅ Execute Go node via HTTP
5. ✅ Execute Java node via HTTP
6. ✅ Test container pooling (multiple requests)
7. ✅ Test container recycling (after max use)
8. ✅ Test container cleanup (after idle timeout)
9. ✅ Measure Docker overhead (target < 5ms with warm pool)

**Prerequisites:**
- Docker must be available
- Go and Java runtime images must be built

**Setup Script:**
```bash
# Build runtime images
docker build -t blok-runtime-go:test ./examples/runtimes/go
docker build -t blok-runtime-java:test ./examples/runtimes/java
```

**Test File:** `core/runner/__tests__/integration/runtimes/docker.integration.test.ts`

**Example Test:**
```typescript
describe('DockerRuntimeAdapter - Integration', () => {
  beforeAll(async () => {
    // Build Docker images
    await buildDockerImage('blok-runtime-go:test', './examples/runtimes/go');
    await buildDockerImage('blok-runtime-java:test', './examples/runtimes/java');
  });

  it('should execute Go node in Docker container', async () => {
    const adapter = new DockerRuntimeAdapter({
      image: 'blok-runtime-go:test',
      poolSize: { min: 1, max: 3 }
    });

    const node = createTestNode('runtime.go', 'hello-world');
    const ctx = createTestContext({ name: 'World' });

    const result = await adapter.execute(node, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      message: 'Hello, World!'
    });
  });

  it('should reuse containers from pool', async () => {
    const adapter = new DockerRuntimeAdapter({
      image: 'blok-runtime-go:test',
      poolSize: { min: 2, max: 5 }
    });

    // Execute multiple times
    const results = await Promise.all([
      adapter.execute(node, ctx),
      adapter.execute(node, ctx),
      adapter.execute(node, ctx),
    ]);

    // Verify all succeeded
    expect(results.every(r => r.success)).toBe(true);

    // Verify containers were reused (not created each time)
    const stats = adapter.getPoolStats();
    expect(stats.containersCreated).toBeLessThanOrEqual(5);
    expect(stats.containersReused).toBeGreaterThan(0);
  });
});
```

---

### Phase 5: Multi-Runtime (Polyglot) Workflow Tests (45 min - 1 hour)

**THE BIG TEST: Prove language-agnosticism works!**

**Test Scenario:**
Create a workflow that uses TypeScript, Python, and Go nodes in sequence:

```json
{
  "name": "polyglot-workflow",
  "trigger": { "manual": {} },
  "steps": [
    {
      "name": "fetch-data",
      "type": "module",
      "runtime": "nodejs",
      "config": {
        "name": "@nanoservice-ts/api-call",
        "inputs": {
          "url": "https://api.example.com/data",
          "method": "GET"
        }
      }
    },
    {
      "name": "process-data",
      "type": "runtime.python3",
      "runtime": "python3",
      "config": {
        "name": "data-processor",
        "inputs": {
          "data": "{{ctx.vars['fetch-data'].data}}"
        }
      }
    },
    {
      "name": "analyze-data",
      "type": "runtime.go",
      "runtime": "go",
      "config": {
        "name": "data-analyzer",
        "inputs": {
          "processed": "{{ctx.vars['process-data'].result}}"
        }
      }
    }
  ]
}
```

**Test File:** `core/runner/__tests__/integration/runtimes/multi-runtime.integration.test.ts`

**Example Test:**
```typescript
describe('Multi-Runtime Workflows', () => {
  it('should execute TypeScript → Python → Go workflow', async () => {
    const workflow = loadWorkflow('polyglot-workflow.json');
    const result = await executeWorkflow(workflow, {
      input: { id: 'test-123' }
    });

    expect(result.success).toBe(true);

    // Verify each step executed
    expect(result.steps['fetch-data'].success).toBe(true);
    expect(result.steps['process-data'].success).toBe(true);
    expect(result.steps['analyze-data'].success).toBe(true);

    // Verify data flowed through correctly
    expect(result.data).toMatchObject({
      analyzed: true,
      language: 'go'
    });
  });

  it('should handle errors across runtime boundaries', async () => {
    const workflow = loadWorkflow('polyglot-error-workflow.json');
    const result = await executeWorkflow(workflow, {
      input: { shouldFail: true }
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error.step).toBe('process-data'); // Failed in Python
  });
});
```

---

### Phase 6: Performance Benchmarks (30-45 min)

**Benchmark Scenarios:**
1. ✅ NodeJS in-process overhead
2. ✅ Python3 gRPC overhead (cold)
3. ✅ Python3 gRPC overhead (warm)
4. ✅ Docker Go overhead (cold container)
5. ✅ Docker Go overhead (warm pool)
6. ✅ Docker Java overhead (warm pool)
7. ✅ Multi-runtime workflow total latency

**Performance Targets:**
- NodeJS: < 1ms overhead
- Python3: < 5ms overhead (warm connection)
- Docker (warm pool): < 5ms overhead
- Docker (cold start): < 100ms acceptable

**Benchmark File:** `core/runner/__tests__/integration/benchmarks/runtime-performance.bench.ts`

**Example Benchmark:**
```typescript
import { bench, describe } from 'vitest';

describe('Runtime Adapter Performance', () => {
  bench('NodeJS in-process execution', async () => {
    await executeNodeJsNode(simpleNode, ctx);
  });

  bench('Python3 gRPC execution (warm)', async () => {
    await executePython3Node(simpleNode, ctx);
  });

  bench('Docker Go execution (warm pool)', async () => {
    await executeDockerNode(goNode, ctx);
  });

  bench('Polyglot workflow (TS → Py → Go)', async () => {
    await executePolyglotWorkflow();
  });
});
```

---

### Phase 7: Backward Compatibility Tests (30 min)

**Test Scenarios:**
1. ✅ Existing HTTP workflows still work
2. ✅ Existing Python nodes still work
3. ✅ Legacy nodeTypes() resolution still works
4. ✅ No breaking changes to public APIs

**Test File:** `core/runner/__tests__/integration/backward-compatibility.test.ts`

**Example Test:**
```typescript
describe('Backward Compatibility', () => {
  it('should execute legacy Python workflow unchanged', async () => {
    const workflow = loadWorkflow('legacy-python-workflow.json');
    const result = await executeWorkflow(workflow, input);

    expect(result.success).toBe(true);
    // Same behavior as before
  });

  it('should support runtime.python3 type (legacy)', async () => {
    const node = {
      type: 'runtime.python3',
      // No explicit runtime field
    };

    const resolved = await runtimeResolver(node);
    expect(resolved).toBeDefined();
  });
});
```

---

### Phase 8: Real-World Validation (1 hour)

**Test with Actual HTTP/gRPC Triggers:**

1. **Start HTTP Trigger Server**
   ```bash
   cd triggers/http
   pnpm start
   ```

2. **Create Test Workflows**
   - HTTP → TypeScript node
   - HTTP → Python node
   - HTTP → Go node (Docker)
   - HTTP → Multi-runtime workflow

3. **Manual Testing**
   ```bash
   # Test TypeScript endpoint
   curl http://localhost:3000/nodejs-test

   # Test Python endpoint
   curl http://localhost:3000/python-test

   # Test Go endpoint
   curl http://localhost:3000/go-test

   # Test polyglot endpoint
   curl http://localhost:3000/polyglot-test
   ```

4. **Verify Logs & Metrics**
   - Check OpenTelemetry traces
   - Verify metrics on /metrics endpoint
   - Confirm no errors in logs

---

## 🎯 Expected Outcomes

### Deliverables
1. ✅ **Integration Test Suite** (~200-300 tests)
   - NodeJS runtime integration tests
   - Python3 runtime integration tests
   - Docker runtime integration tests
   - Multi-runtime workflow tests
   - Backward compatibility tests

2. ✅ **Performance Benchmarks**
   - Overhead measurements for each adapter
   - Load testing results
   - Performance regression baselines

3. ✅ **Real-World Validation**
   - Working HTTP endpoints for all runtimes
   - Docker containers successfully executing
   - Multi-runtime workflows proven

4. ✅ **Updated Documentation**
   - PROGRESS.md updated to 100% Phase 1
   - Integration test documentation
   - Performance benchmarks documented
   - Migration guide for users

### Success Metrics
- ✅ 200+ integration tests passing
- ✅ All performance targets met
- ✅ Zero backward compatibility breaks
- ✅ Docker containers run successfully
- ✅ Multi-runtime workflow works end-to-end

---

## 🚦 Implementation Order

**Hour 1-2: Infrastructure & NodeJS**
- Set up integration test environment
- Create test helpers and fixtures
- Implement NodeJS integration tests

**Hour 2-3: Python3 & Docker Setup**
- Implement Python3 integration tests
- Build Docker images
- Set up Docker test environment

**Hour 3-5: Docker & Multi-Runtime**
- Implement Docker integration tests
- Create polyglot workflow tests
- Verify multi-runtime scenarios

**Hour 5-6: Performance & Validation**
- Run performance benchmarks
- Real-world HTTP/gRPC testing
- Backward compatibility verification

**Hour 6-7: Documentation & Wrap-Up**
- Update PROGRESS.md
- Document benchmark results
- Create migration guides
- Celebrate Phase 1 completion! 🎉

---

## 📝 Test Coverage Goals

### Before Day 4
```
@nanoservice-ts/runner: 90% (unit tests)
```

### After Day 4
```
@nanoservice-ts/runner: 95%+ (unit + integration)
  - Unit tests: ~90% coverage
  - Integration tests: Critical paths covered
  - Performance benchmarks: All adapters measured
  - Backward compatibility: 100% verified
```

---

## 🎬 Let's Start!

**First Command:**
```bash
# Create integration test directory
mkdir -p core/runner/__tests__/integration/{runtimes,fixtures,helpers,benchmarks}
```

**Ready to begin Day 4?** Let's prove this runtime adapter system is PRODUCTION READY! 🚀

---

**Document Version:** 1.0.0
**Created:** 2026-01-27
**Status:** 🚀 ACTIVE
**Phase:** Day 4 - Integration & Validation
