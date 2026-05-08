/**
 * Workflow Runner Test Utilities
 *
 * Helpers for executing workflows in integration tests:
 * - Loading workflow fixtures
 * - Creating test contexts
 * - Executing workflows
 * - Verifying results
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowModel } from "@blokjs/helper";
import type { Context } from "@blokjs/shared";
import Configuration from "../../../src/Configuration";
import { DefaultLogger } from "../../../src/DefaultLogger";
import Runner from "../../../src/Runner";

export interface WorkflowExecutionInput {
	body?: any;
	headers?: Record<string, string>;
	query?: Record<string, string>;
	params?: Record<string, string>;
}

export interface WorkflowExecutionResult {
	success: boolean;
	data: any;
	error: any;
	ctx: Context;
	duration: number;
	steps?: Record<string, any>;
}

/**
 * Load a workflow fixture from JSON file
 */
export function loadWorkflow(fixtureName: string): WorkflowModel {
	const fixturePath = path.resolve(__dirname, "../fixtures/workflows", fixtureName);

	if (!fs.existsSync(fixturePath)) {
		throw new Error(`Workflow fixture not found: ${fixturePath}`);
	}

	const content = fs.readFileSync(fixturePath, "utf-8");
	return JSON.parse(content) as WorkflowModel;
}

/**
 * Create a test context with optional input
 */
export function createTestContext(input?: WorkflowExecutionInput, workflowPath = "test-workflow"): Context {
	const ctx: Context = {
		id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
		workflow_name: "test-workflow",
		workflow_path: workflowPath,
		config: {},
		request: {
			body: input?.body || {},
			headers: input?.headers || {},
			query: input?.query || {},
			params: input?.params || {},
		},
		response: {
			data: "",
			contentType: "",
			success: true,
			error: null,
		},
		error: {
			message: [],
		},
		logger: new DefaultLogger("test", "test"),
		eventLogger: null,
		_PRIVATE_: null,
	};

	// Add env
	Object.defineProperty(ctx, "env", {
		get: () => process.env,
		enumerable: false,
	});

	return ctx;
}

/**
 * Execute a workflow and return results
 */
export async function executeWorkflow(
	workflow: WorkflowModel,
	input?: WorkflowExecutionInput,
): Promise<WorkflowExecutionResult> {
	const startTime = performance.now();

	// Create context
	const ctx = createTestContext(input, workflow.path);

	// Create configuration and runner
	const config = new Configuration({
		name: workflow.name || "test",
		nodes: {},
		workflowsPath: path.resolve(__dirname, "../fixtures/workflows"),
		nodesPath: path.resolve(__dirname, "../fixtures/nodes"),
	});

	const runner = new Runner();

	try {
		// Execute workflow
		await runner.start(ctx, workflow, config.nodeTypes());

		const duration = performance.now() - startTime;

		return {
			success: ctx.response.success,
			data: ctx.response.data,
			error: ctx.response.error,
			ctx,
			duration,
			steps: extractStepResults(ctx),
		};
	} catch (error: any) {
		const duration = performance.now() - startTime;

		return {
			success: false,
			data: null,
			error: {
				message: error.message,
				stack: error.stack,
			},
			ctx,
			duration,
		};
	}
}

/**
 * Extract step results from context variables
 */
function extractStepResults(ctx: Context): Record<string, any> {
	const steps: Record<string, any> = {};

	// ctx.vars contains results from each step
	if (ctx.vars) {
		for (const [stepName, result] of Object.entries(ctx.vars)) {
			steps[stepName] = result;
		}
	}

	return steps;
}

/**
 * Execute a simple node (for performance testing)
 */
export async function executeSimpleNode(
	nodeType: string,
	nodeName: string,
	input: any,
	runtime?: string,
): Promise<WorkflowExecutionResult> {
	const workflow: WorkflowModel = {
		name: "simple-node-test",
		path: "simple-node-test",
		trigger: { manual: {} },
		steps: [
			{
				name: "test-node",
				type: nodeType,
				runtime,
				config: {
					name: nodeName,
					inputs: input,
				},
			},
		],
	};

	return executeWorkflow(workflow, { body: input });
}

/**
 * Assert workflow execution succeeded
 */
export function assertWorkflowSuccess(result: WorkflowExecutionResult): void {
	if (!result.success) {
		const errorDetails = JSON.stringify(result.error, null, 2);
		throw new Error(
			`Workflow execution failed:\n${errorDetails}\n\nContext: ${JSON.stringify(
				{
					id: result.ctx.id,
					workflow: result.ctx.workflow_name,
					response: result.ctx.response,
				},
				null,
				2,
			)}`,
		);
	}
}

/**
 * Assert workflow execution failed with expected error
 */
export function assertWorkflowError(result: WorkflowExecutionResult, expectedError?: string | RegExp): void {
	if (result.success) {
		throw new Error("Expected workflow to fail, but it succeeded");
	}

	if (expectedError) {
		const errorMessage = result.error?.message || result.ctx.response.error?.message || "";

		if (typeof expectedError === "string") {
			if (!errorMessage.includes(expectedError)) {
				throw new Error(`Expected error to contain "${expectedError}", but got: ${errorMessage}`);
			}
		} else if (expectedError instanceof RegExp) {
			if (!expectedError.test(errorMessage)) {
				throw new Error(`Expected error to match ${expectedError}, but got: ${errorMessage}`);
			}
		}
	}
}

/**
 * Measure execution time of a function
 */
export async function measureExecutionTime<T>(fn: () => Promise<T>): Promise<{ result: T; duration: number }> {
	const startTime = performance.now();
	const result = await fn();
	const duration = performance.now() - startTime;

	return { result, duration };
}
