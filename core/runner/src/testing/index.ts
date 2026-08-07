/**
 * Testing Framework for Blok Nodes and Workflows
 *
 * Unit- and integration-test nodes and workflows with no running server, no
 * Docker, and no vitest configuration workarounds.
 *
 * Start with `runNode` / `runWorkflow`; the classes underneath them stay
 * exported for tests that need finer control.
 *
 * @example
 * ```typescript
 * import { runNode, runWorkflow } from "@blokjs/core/testing";
 *
 * const out = await runNode(orderValidator, { body: { id: "o-1" } });
 * const run = await runWorkflow(orderFlow, { id: "o-1", total: 120 });
 * ```
 */

// Typed-first helpers (#688)
export { runNode, runWorkflow } from "./run";
export type { NodeMock, RunWorkflowOptions, StepRun, WorkflowRun } from "./run";

// Test Logger
export { TestLogger } from "./TestLogger";
export type { LogEntry } from "./TestLogger";

// Node Test Harness
export { NodeTestHarness } from "./TestHarness";
export type { TestContextOverrides, TestResult, TestMetrics } from "./TestHarness";

// Workflow Test Runner
export { WorkflowTestRunner } from "./WorkflowTestRunner";
export type {
	WorkflowTestConfig,
	WorkflowTestResult,
	ExecutionTrace,
	WorkflowExecuteOptions,
} from "./WorkflowTestRunner";
