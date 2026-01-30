/**
 * Shared Test Utilities for Blok Integration Tests
 *
 * Provides mock factories, test fixtures, and helper functions
 * used across all test suites.
 */

import type { Context, LoggerContext } from "@blok/shared";

/**
 * Create a mock Context for testing trigger execution.
 */
export function createMockContext(overrides: Partial<Context> = {}): Context {
	return {
		id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		workflow_name: "test-workflow",
		workflow_path: "/test/workflow.yml",
		config: {},
		request: { body: {} },
		response: { data: "", contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: createMockLogger(),
		eventLogger: null,
		_PRIVATE_: null,
		...overrides,
	};
}

/**
 * Create a mock Logger for testing.
 */
export function createMockLogger(): LoggerContext {
	return {
		log: () => {},
		error: () => {},
		warn: () => {},
		info: () => {},
		debug: () => {},
	} as unknown as LoggerContext;
}

/**
 * Wait for a condition to be true, with timeout.
 */
export async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = 5000,
	intervalMs = 50,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await condition()) return;
		await sleep(intervalMs);
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a deferred promise for async test coordination.
 */
export function createDeferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * Retry a function until it succeeds or max attempts reached.
 */
export async function retry<T>(fn: () => Promise<T>, maxAttempts = 3, delayMs = 1000): Promise<T> {
	let lastError: Error | undefined;
	for (let i = 0; i < maxAttempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (i < maxAttempts - 1) {
				await sleep(delayMs);
			}
		}
	}
	throw lastError;
}

/**
 * Generate a unique test ID for isolation.
 */
export function testId(prefix = "test"): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Measure execution time of an async function.
 */
export async function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
	const start = performance.now();
	const result = await fn();
	return { result, durationMs: performance.now() - start };
}

/**
 * Collect events from an EventEmitter-like object.
 */
export function collectEvents<T>(
	emitter: { on: (listener: (event: T) => void) => void },
	maxEvents = 100,
): { events: T[]; clear: () => void } {
	const events: T[] = [];
	emitter.on((event: T) => {
		if (events.length < maxEvents) {
			events.push(event);
		}
	});
	return {
		events,
		clear: () => {
			events.length = 0;
		},
	};
}
