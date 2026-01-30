/**
 * Test Utilities for Runtime Adapter Testing
 * Provides mock objects and helper functions for unit and integration tests
 */

import type { Context, LoggerContext } from "@blok/shared";
import DefaultLogger from "../../src/DefaultLogger";
import type { RunnerNode } from "../../src/RunnerNode";
import type { ExecutionResult, RuntimeKind } from "../../src/adapters/RuntimeAdapter";

/**
 * Creates a mock Context object for testing
 */
export function createMockContext(overrides: Partial<Context> = {}): Context {
	const defaultContext: Context = {
		id: "test-context-id",
		workflow_name: "test-workflow",
		workflow_path: "/test/workflow",
		config: {},
		request: {
			body: { test: "data" },
			headers: { "content-type": "application/json" },
			query: {},
			params: {},
		},
		response: {
			data: "",
			contentType: "application/json",
			success: true,
			error: null,
		},
		error: {
			message: [],
		},
		logger: new DefaultLogger() as LoggerContext,
		eventLogger: null,
		_PRIVATE_: null,
		vars: {},
	};

	// Add env as a non-enumerable property
	Object.defineProperty(defaultContext, "env", {
		value: process.env,
		writable: false,
		enumerable: false,
		configurable: true,
	});

	return {
		...defaultContext,
		...overrides,
	};
}

/**
 * Creates a mock RunnerNode for testing
 */
export function createMockRunnerNode(overrides: Partial<RunnerNode> = {}): RunnerNode {
	return {
		name: "test-node",
		modulePath: "/test/node",
		type: "module",
		runtime: "nodejs",
		config: {},
		...overrides,
	} as RunnerNode;
}

/**
 * Creates a mock ExecutionResult for testing
 */
export function createMockExecutionResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
	return {
		success: true,
		data: { result: "test" },
		errors: null,
		logs: [],
		metrics: {
			duration_ms: 10,
			cpu_ms: 5,
			memory_bytes: 1024,
		},
		...overrides,
	};
}

/**
 * Creates a mock RuntimeAdapter for testing
 */
export function createMockRuntimeAdapter(kind: RuntimeKind) {
	return {
		kind,
		execute: vi.fn().mockResolvedValue(createMockExecutionResult()),
	};
}

/**
 * Sleep utility for testing async operations
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Measures execution time of a function
 */
export async function measureExecutionTime<T>(fn: () => Promise<T>): Promise<{ result: T; duration: number }> {
	const start = Date.now();
	const result = await fn();
	const duration = Date.now() - start;
	return { result, duration };
}

/**
 * Waits for a condition to be true
 */
export async function waitFor(condition: () => boolean, timeout = 5000, interval = 100): Promise<void> {
	const startTime = Date.now();

	while (!condition()) {
		if (Date.now() - startTime > timeout) {
			throw new Error("Timeout waiting for condition");
		}
		await sleep(interval);
	}
}

/**
 * Creates a mock logger for testing
 */
export function createMockLogger(): LoggerContext {
	return new DefaultLogger() as LoggerContext;
}

/**
 * Verifies that an ExecutionResult has the correct structure
 */
export function assertValidExecutionResult(result: ExecutionResult): void {
	expect(result).toHaveProperty("success");
	expect(result).toHaveProperty("data");
	expect(result).toHaveProperty("errors");
	expect(typeof result.success).toBe("boolean");

	if (result.metrics) {
		expect(result.metrics).toHaveProperty("duration_ms");
		expect(typeof result.metrics.duration_ms).toBe("number");
	}
}

/**
 * Generates a random node name for testing
 */
export function generateRandomNodeName(): string {
	return `test-node-${Math.random().toString(36).substring(7)}`;
}

/**
 * Generates a random workflow name for testing
 */
export function generateRandomWorkflowName(): string {
	return `test-workflow-${Math.random().toString(36).substring(7)}`;
}

/**
 * Creates a mock BlokResponse for testing
 */
export function createMockBlokResponse(success = true) {
	return {
		success,
		data: success ? { result: "test" } : null,
		error: success ? null : { message: "Test error", code: 500 },
	};
}

/**
 * Creates a mock configuration object for testing
 */
export function createMockConfiguration() {
	return {
		name: "test-config",
		nodes: {},
		moduleResolver: vi.fn(),
		localResolver: vi.fn(),
		runtimeResolver: vi.fn(),
	};
}

/**
 * Asserts that a value is defined (not null or undefined)
 */
export function assertDefined<T>(value: T | null | undefined): asserts value is T {
	expect(value).toBeDefined();
	expect(value).not.toBeNull();
}

/**
 * Asserts that execution time is within acceptable range
 */
export function assertExecutionTimeWithinRange(actualMs: number, expectedMs: number, toleranceMs = 50): void {
	expect(actualMs).toBeGreaterThanOrEqual(0);
	expect(actualMs).toBeLessThanOrEqual(expectedMs + toleranceMs);
}
