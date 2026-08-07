# Module Reference: Testing Framework

> **Path:** `core/runner/src/testing/`
> **Purpose:** Test utilities for nodes, workflows, and integrations

## What It Does

The testing module lets a consumer unit-test nodes and workflows with no running
server, no Docker, and no vitest configuration. Nothing on its import path does
filesystem work, so it loads identically under `vitest run` and `bun test`.

Author-facing docs: [`docs/d/fundamentals/testing.mdx`](../../docs/d/fundamentals/testing.mdx).

## Source Files

```
core/runner/src/testing/
├── index.ts                    # Barrel export — @blokjs/core/testing
├── run.ts                      # runNode / runWorkflow — the typed-first surface (#688)
├── TestHarness.ts              # NodeTestHarness — one node, full result envelope
├── TestLogger.ts               # Test logger (captures logs for assertions)
└── WorkflowTestRunner.ts       # Runs full workflows through the real engine
```

## Key APIs

### runNode / runWorkflow (start here)

```ts
import { runNode, runWorkflow } from "@blokjs/core/testing";

const out = await runNode(orderValidator, { body: { id: "o-1", total: 120 } }, { env: { API_KEY: "test" } });

const run = await runWorkflow(orderFlow, { id: "o-1", total: 120 }, {
  mock: { "charge-card": async () => ({ receipt: "rc_1" }) },
});
run.ok; run.response; run.state("validate"); run.step("charge")?.inputs; run.steps;
```

- `runWorkflow` takes the `workflow()` export DIRECTLY (including the promise it
  returns). A path to a JSON workflow still works for JSON-authored workflows.
- Nodes resolve automatically: a typed-handle `step()` takes the node value, so
  importing a workflow constructs every node it uses. `defineNode()` records
  each one under its canonical `use:` ref for the harness to find.
- `mock` is keyed by node ref, and the mock's return value is validated against
  the REAL node's Zod output schema — an undeclared field fails the test naming
  the node and the field.
- Step records carry resolved inputs, output, `executed` (false = skipped arm),
  and `calls` (forEach iterations).

### NodeTestHarness
- Creates mock Context objects for node testing
- Returns the full result envelope (`success`, `error`, `durationMs`, `logs`)
- Provides assertion helpers for response validation
- Supports both function-first and class-based nodes

### WorkflowTestRunner
- Runs v2 / DSL workflows through the real `Configuration` + `Runner`
- Captures step-by-step execution results and the real `ctx.state`
- `registerNode` / `mockNode` for manual wiring

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

### Downstream-consumer fixture
- **Path:** `tests/e2e/node-consumer/` — a real consumer project run by
  `bun run check:packaging` against the PACKED tarballs, under BOTH
  `vitest run` (on Node) and `bun test`, with an empty `vitest.config.ts`.
  Covers: every exports subpath imports under Node's ESM loader (#687), no
  top-level filesystem work on import, a `runNode` unit test, and a
  `runWorkflow` test with a mocked node (#688).

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
