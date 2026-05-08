import type { Context, EnvContext, ResponseContext, VarsContext } from "@blokjs/shared";
import type { z } from "zod";
import type BlokService from "../Blok";
import type { IBlokResponse } from "../BlokResponse";
import type { FunctionNode } from "../defineNode";
import type JsonLikeObject from "../types/JsonLikeObject";
import { TestLogger } from "./TestLogger";

/**
 * Partial test context overrides that can be supplied to customize
 * the execution environment for a test run.
 */
export interface TestContextOverrides {
	/** Override the context ID */
	id?: string;
	/** Override the request context */
	request?: {
		body?: unknown;
		headers?: Record<string, string>;
		query?: Record<string, string>;
		params?: Record<string, string>;
	};
	/** Override the response context */
	response?: Partial<ResponseContext>;
	/** Override context vars (alias for state in v2) */
	vars?: VarsContext;
	/** Override environment variables — shape matches `EnvContext` */
	env?: EnvContext;
	/** Override error context */
	error?: { message: string[] | string; code?: number };
	/** Provide a custom logger (defaults to TestLogger) */
	logger?: TestLogger;
	/** Override workflow name */
	workflow_name?: string;
	/** Override workflow path */
	workflow_path?: string;
	/** Override config context */
	config?: Record<string, unknown>;
}

/**
 * Result of a node test execution.
 */
export interface TestResult<O> {
	/** Whether the node executed successfully */
	success: boolean;
	/** The output data from the node, or null on failure */
	data: O | null;
	/** Error information if the node failed */
	error: unknown;
	/** The context after node execution */
	context: Context;
	/** Execution duration in milliseconds */
	durationMs: number;
	/** Log messages captured during execution */
	logs: string[];
}

/**
 * Aggregated metrics across multiple test executions.
 */
export interface TestMetrics {
	/** Total number of executions */
	totalExecutions: number;
	/** Number of successful executions */
	successCount: number;
	/** Number of failed executions */
	failureCount: number;
	/** Average execution duration in milliseconds */
	avgDurationMs: number;
	/** Duration of the most recent execution in milliseconds */
	lastDurationMs: number;
}

/**
 * Union type for anything that can be tested as a node — either a
 * class-based `BlokService` (legacy) or a defineNode-built `FunctionNode`.
 * Both generics are widened to their constraints (`unknown` for
 * BlokService's data shape, `z.ZodTypeAny` for FunctionNode's input/output
 * schemas) so the harness can dispatch without caring about the specific
 * schema parameters of the underlying node.
 */
type TestableNode = BlokService<unknown> | FunctionNode<z.ZodTypeAny, z.ZodTypeAny>;

/**
 * NodeTestHarness - Main testing utility for Blok nodes.
 *
 * Provides a controlled execution environment for unit testing individual
 * nodes without needing a running server, workflow configuration, or
 * OpenTelemetry metrics infrastructure.
 *
 * @example
 * ```typescript
 * import { NodeTestHarness } from "@blokjs/runner";
 * import { defineNode } from "@blokjs/runner";
 * import { z } from "zod";
 *
 * const AddNode = defineNode({
 *   name: "add",
 *   description: "Adds two numbers",
 *   input: z.object({ a: z.number(), b: z.number() }),
 *   output: z.object({ sum: z.number() }),
 *   async execute(ctx, input) {
 *     return { sum: input.a + input.b };
 *   },
 * });
 *
 * const harness = new NodeTestHarness(AddNode);
 * const result = await harness.execute({ a: 2, b: 3 });
 *
 * harness.assertSuccess(result);
 * harness.assertOutput(result, { sum: 5 });
 * ```
 *
 * @typeParam I - Input type for the node
 * @typeParam O - Output type for the node
 */
/**
 * I/O default to `unknown` so authors can `new NodeTestHarness(myNode)`
 * with zero generic specification — assertion helpers (`assertOutput`,
 * `assertContextVar`) accept `unknown` expected values, and `execute()`
 * accepts `unknown` input. Authors who want stronger types can specify
 * `new NodeTestHarness<MyInput, MyOutput>(myNode)` to lock the surface.
 */
export class NodeTestHarness<I = unknown, O = unknown> {
	private node: TestableNode;
	private executionHistory: TestResult<O>[];

	constructor(node: TestableNode) {
		this.node = node;
		this.executionHistory = [];
	}

	/**
	 * Create a test context with sensible defaults that can be overridden.
	 *
	 * The returned context is fully compatible with the Blok Context interface
	 * and uses a TestLogger for log capture.
	 *
	 * @param overrides - Partial context fields to customize
	 * @returns A fully populated Context object ready for testing
	 */
	createContext(overrides?: TestContextOverrides): Context {
		const logger = overrides?.logger ?? new TestLogger();

		// `RequestContext.body` is structurally typed as `ParamsDictionary`
		// (a string-indexed map of strings). Real workflows pass arbitrary
		// JSON here; the runtime path (`HttpTrigger.runWorkflowExecution`)
		// also casts user-supplied bodies through `as unknown as` to
		// satisfy the declared shape. Mirror that pattern here so authors
		// can pass any JSON-like body in tests without fighting the type.
		const requestBody = overrides?.request?.body ?? {};

		const ctx: Context = {
			id: overrides?.id ?? `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			workflow_name: overrides?.workflow_name ?? "test-workflow",
			workflow_path: overrides?.workflow_path ?? "/test",
			request: {
				body: requestBody as JsonLikeObject as Context["request"]["body"],
				headers: overrides?.request?.headers ?? {},
				query: overrides?.request?.query ?? {},
				params: overrides?.request?.params ?? {},
			},
			response: {
				data: overrides?.response?.data ?? {},
				error: null,
				success: true,
				contentType: overrides?.response?.contentType ?? "application/json",
			},
			error: overrides?.error ?? { message: [] },
			logger: logger,
			config: overrides?.config ?? {},
			vars: overrides?.vars ?? {},
			env: overrides?.env ?? {},
			eventLogger: logger,
			_PRIVATE_: {},
		};

		return ctx;
	}

	/**
	 * Execute the node with given input and optional context overrides.
	 *
	 * This method directly invokes the node's handle() method, bypassing
	 * the BlokService.run() infrastructure (metrics, schema validation via
	 * JSON Schema, config mapping). This provides a clean, fast test
	 * execution path focused on the node's business logic.
	 *
	 * @param input - Input data to pass to the node
	 * @param contextOverrides - Optional context customizations
	 * @returns A TestResult containing success/failure status, data, error, and timing
	 */
	async execute(input: I, contextOverrides?: TestContextOverrides): Promise<TestResult<O>> {
		const ctx = this.createContext(contextOverrides);
		const startTime = performance.now();

		let result: TestResult<O>;

		try {
			const response = (await this.node.handle(ctx, input as JsonLikeObject)) as IBlokResponse;

			const endTime = performance.now();
			const logger = ctx.logger as TestLogger;

			if (response.success === false || response.error) {
				result = {
					success: false,
					data: null,
					error: response.error,
					context: ctx,
					durationMs: endTime - startTime,
					logs: logger.getLogs?.() ?? [],
				};
			} else {
				result = {
					success: true,
					data: response.data as O,
					error: null,
					context: ctx,
					durationMs: endTime - startTime,
					logs: logger.getLogs?.() ?? [],
				};
			}
		} catch (error: unknown) {
			const endTime = performance.now();
			const logger = ctx.logger as TestLogger;

			result = {
				success: false,
				data: null,
				error,
				context: ctx,
				durationMs: endTime - startTime,
				logs: logger.getLogs?.() ?? [],
			};
		}

		this.executionHistory.push(result);
		return result;
	}

	/**
	 * Assert that the output of a test result matches the expected partial object.
	 *
	 * Uses deep equality for each key in the expected object, so you only need
	 * to specify the fields you care about.
	 *
	 * @param result - The test result to check
	 * @param expected - A partial object that should be a subset of the output
	 * @throws Error if any expected field does not match
	 */
	assertOutput(result: TestResult<O>, expected: Partial<O>): void {
		if (!result.success) {
			throw new Error(`Cannot assert output: node execution failed with error: ${this.formatError(result.error)}`);
		}

		if (result.data === null) {
			throw new Error("Cannot assert output: result data is null");
		}

		const data = result.data as Record<string, unknown>;
		const expectedRecord = expected as Record<string, unknown>;

		for (const key of Object.keys(expectedRecord)) {
			const actual = data[key];
			const exp = expectedRecord[key];

			const actualStr = JSON.stringify(actual);
			const expectedStr = JSON.stringify(exp);

			if (actualStr !== expectedStr) {
				throw new Error(
					`Output mismatch for key "${key}":\n` + `  expected: ${expectedStr}\n` + `  received: ${actualStr}`,
				);
			}
		}
	}

	/**
	 * Assert that the node execution was successful.
	 *
	 * @param result - The test result to check
	 * @throws Error if the node failed
	 */
	assertSuccess(result: TestResult<O>): void {
		if (!result.success) {
			throw new Error(`Expected node to succeed, but it failed with error: ${this.formatError(result.error)}`);
		}
	}

	/**
	 * Assert that the node execution failed, optionally matching the error message.
	 *
	 * @param result - The test result to check
	 * @param errorMatch - Optional string or RegExp to match against the error message
	 * @throws Error if the node succeeded or the error message does not match
	 */
	assertError(result: TestResult<O>, errorMatch?: string | RegExp): void {
		if (result.success) {
			throw new Error(`Expected node to fail, but it succeeded with data: ${JSON.stringify(result.data)}`);
		}

		if (errorMatch !== undefined) {
			const errorMsg = this.formatError(result.error);

			if (typeof errorMatch === "string") {
				if (!errorMsg.includes(errorMatch)) {
					throw new Error(`Expected error to contain "${errorMatch}", but got: "${errorMsg}"`);
				}
			} else {
				if (!errorMatch.test(errorMsg)) {
					throw new Error(`Expected error to match ${errorMatch}, but got: "${errorMsg}"`);
				}
			}
		}
	}

	/**
	 * Assert that a context variable was set to the expected value.
	 *
	 * @param result - The test result to check
	 * @param key - The variable name to check in context.vars
	 * @param expected - The expected value
	 * @throws Error if the variable is not set or does not match
	 */
	assertContextVar(result: TestResult<O>, key: string, expected: unknown): void {
		const vars = result.context.vars as Record<string, unknown> | undefined;

		if (!vars) {
			throw new Error(`Expected context var "${key}" to be set, but context.vars is undefined`);
		}

		const actual = vars[key];
		const actualStr = JSON.stringify(actual);
		const expectedStr = JSON.stringify(expected);

		if (actualStr !== expectedStr) {
			throw new Error(`Context var "${key}" mismatch:\n` + `  expected: ${expectedStr}\n` + `  received: ${actualStr}`);
		}
	}

	/**
	 * Get aggregated execution metrics across all test runs.
	 *
	 * @returns TestMetrics with execution counts and timing data
	 */
	getMetrics(): TestMetrics {
		const total = this.executionHistory.length;
		const successes = this.executionHistory.filter((r) => r.success).length;
		const failures = total - successes;
		const totalDuration = this.executionHistory.reduce((sum, r) => sum + r.durationMs, 0);

		return {
			totalExecutions: total,
			successCount: successes,
			failureCount: failures,
			avgDurationMs: total > 0 ? totalDuration / total : 0,
			lastDurationMs: total > 0 ? this.executionHistory[total - 1].durationMs : 0,
		};
	}

	/**
	 * Get the full execution history.
	 *
	 * @returns Array of all test results from previous executions
	 */
	getHistory(): TestResult<O>[] {
		return [...this.executionHistory];
	}

	/**
	 * Reset the execution history and metrics.
	 */
	reset(): void {
		this.executionHistory = [];
	}

	/**
	 * Format an error value into a readable string.
	 */
	private formatError(error: unknown): string {
		if (error === null || error === undefined) {
			return "(no error)";
		}
		if (error instanceof Error) {
			return error.message;
		}
		if (typeof error === "object" && error !== null && "context" in error) {
			// GlobalError format
			const ctxErr = error as { context?: { message?: string } | unknown };
			const ctx = ctxErr.context as { message?: string } | undefined;
			return ctx?.message ?? JSON.stringify(ctx);
		}
		if (typeof error === "object") {
			return JSON.stringify(error);
		}
		return String(error);
	}
}
