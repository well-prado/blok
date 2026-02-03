import type { Context } from "@blokjs/shared";
import BlokService from "../Blok";
import BlokResponse, { type IBlokResponse } from "../BlokResponse";
import type { FunctionNode } from "../defineNode";
import type Condition from "../types/Condition";
import type JsonLikeObject from "../types/JsonLikeObject";
import type { TestContextOverrides, TestResult } from "./TestHarness";
import { TestLogger } from "./TestLogger";

/**
 * Configuration options for the WorkflowTestRunner.
 */
export interface WorkflowTestConfig {
	/** Timeout in milliseconds for the entire workflow execution. Default: 30000 */
	timeout?: number;
	/** Whether to print execution details to the console. Default: false */
	verbose?: boolean;
	/** When true, all nodes without explicit implementations will be auto-mocked. Default: false */
	mockAllNodes?: boolean;
}

/**
 * Result of a workflow test execution.
 */
export interface WorkflowTestResult {
	/** Whether the entire workflow executed successfully */
	success: boolean;
	/** Final output of the workflow */
	output: any;
	/** Ordered trace of node executions */
	trace: ExecutionTrace[];
	/** Total execution duration in milliseconds */
	durationMs: number;
	/** Per-node results keyed by node name */
	nodeResults: Map<string, TestResult<any>>;
}

/**
 * A record of a single node execution within a workflow.
 */
export interface ExecutionTrace {
	/** Name of the node that was executed */
	nodeName: string;
	/** The index of this step in the workflow */
	stepIndex: number;
	/** Input data provided to the node */
	input: any;
	/** Output data returned by the node */
	output: any;
	/** Execution duration in milliseconds */
	durationMs: number;
	/** Whether this node executed successfully */
	success: boolean;
	/** Error message if the node failed */
	error?: string;
	/** Timestamp when this node started execution */
	timestamp: number;
}

/**
 * Options for a single workflow execution.
 */
export interface WorkflowExecuteOptions {
	/** HTTP headers to populate in the context request */
	headers?: Record<string, string>;
	/** Query parameters to populate in the context request */
	query?: Record<string, string>;
	/** Path parameters to populate in the context request */
	params?: Record<string, string>;
	/** Additional context overrides */
	contextOverrides?: TestContextOverrides;
}

/**
 * Workflow step definition as parsed from a workflow JSON.
 */
interface WorkflowStep {
	name: string;
	node: string;
	inputs?: Record<string, any>;
	conditions?: any[];
	set_var?: boolean;
}

/**
 * Workflow definition structure.
 */
interface WorkflowDefinition {
	name?: string;
	steps: WorkflowStep[];
	trigger?: any;
}

/**
 * A mock node implementation wrapping a user-provided handler function.
 */
class MockNode extends BlokService<any> {
	private handler: (input: any, ctx: Context) => Promise<any>;

	constructor(name: string, handler: (input: any, ctx: Context) => Promise<any>) {
		super();
		this.name = name;
		this.handler = handler;
	}

	async handle(
		ctx: Context,
		inputs: any | JsonLikeObject | Condition[],
	): Promise<IBlokResponse | BlokService<any>[]> {
		const response = new BlokResponse();

		try {
			const result = await this.handler(inputs, ctx);
			response.setSuccess(result as JsonLikeObject);
		} catch (error: unknown) {
			const { GlobalError } = await import("@blokjs/shared");
			const globalError = new GlobalError(error instanceof Error ? error.message : String(error));
			globalError.setCode(500);
			globalError.setName(this.name);
			response.setError(globalError);
		}

		return response;
	}
}

/**
 * An auto-mock node that returns an empty object for any input.
 */
class AutoMockNode extends MockNode {
	constructor(name: string) {
		super(name, async () => ({}));
	}
}

/**
 * WorkflowTestRunner - For testing complete workflows.
 *
 * Allows you to register real or mock node implementations and execute
 * workflow definitions in a controlled test environment. Captures a full
 * execution trace showing which nodes ran, in what order, with what data.
 *
 * @example
 * ```typescript
 * import { WorkflowTestRunner } from "@blokjs/runner";
 * import { defineNode } from "@blokjs/runner";
 * import { z } from "zod";
 *
 * const runner = new WorkflowTestRunner({ verbose: true });
 *
 * // Register a real node
 * runner.registerNode("validate-input", ValidateInputNode);
 *
 * // Register a mock for an external API call
 * runner.mockNode("fetch-user", async (input) => {
 *   return { user: { id: input.userId, name: "Test User" } };
 * });
 *
 * // Load and execute workflow
 * runner.loadWorkflow({
 *   name: "get-user",
 *   steps: [
 *     { name: "step1", node: "validate-input", inputs: { userId: "abc-123" } },
 *     { name: "step2", node: "fetch-user", inputs: { userId: "${response.data.userId}" } },
 *   ],
 * });
 *
 * const result = await runner.execute({ userId: "abc-123" });
 * console.log(result.trace); // See execution order and data flow
 * ```
 */
export class WorkflowTestRunner {
	private config: Required<WorkflowTestConfig>;
	private nodes: Map<string, BlokService<any>>;
	private workflow: WorkflowDefinition | null;
	private trace: ExecutionTrace[];
	private nodeResults: Map<string, TestResult<any>>;

	constructor(config?: WorkflowTestConfig) {
		this.config = {
			timeout: config?.timeout ?? 30000,
			verbose: config?.verbose ?? false,
			mockAllNodes: config?.mockAllNodes ?? false,
		};
		this.nodes = new Map();
		this.workflow = null;
		this.trace = [];
		this.nodeResults = new Map();
	}

	/**
	 * Register a real node implementation for use in the workflow.
	 *
	 * @param name - The node name as referenced in the workflow steps
	 * @param node - A BlokService instance or a FunctionNode from defineNode()
	 */
	registerNode(name: string, node: BlokService<any> | FunctionNode<any, any>): void {
		node.name = name;
		this.nodes.set(name, node as BlokService<any>);

		if (this.config.verbose) {
			console.log(`[WorkflowTestRunner] Registered node: ${name}`);
		}
	}

	/**
	 * Register a mock node that executes the provided handler function.
	 *
	 * Use this to simulate external API calls, database queries, or any
	 * node whose real implementation you want to skip during testing.
	 *
	 * @param name - The node name as referenced in the workflow steps
	 * @param handler - Async function that receives (input, ctx) and returns output
	 */
	mockNode(name: string, handler: (input: any, ctx: Context) => Promise<any>): void {
		const mockNodeInstance = new MockNode(name, handler);
		this.nodes.set(name, mockNodeInstance);

		if (this.config.verbose) {
			console.log(`[WorkflowTestRunner] Mocked node: ${name}`);
		}
	}

	/**
	 * Load a workflow definition from a JSON object or JSON string.
	 *
	 * The workflow should have a `steps` array where each step defines:
	 * - `name`: step identifier
	 * - `node`: the node type to execute
	 * - `inputs`: input data for the node (optional)
	 *
	 * @param workflow - Workflow definition object or JSON string
	 */
	loadWorkflow(workflow: object | string): void {
		if (typeof workflow === "string") {
			this.workflow = JSON.parse(workflow) as WorkflowDefinition;
		} else {
			this.workflow = workflow as WorkflowDefinition;
		}

		if (!this.workflow.steps || !Array.isArray(this.workflow.steps)) {
			throw new Error("Workflow must have a 'steps' array");
		}

		if (this.config.verbose) {
			console.log(
				`[WorkflowTestRunner] Loaded workflow: ${this.workflow.name ?? "(unnamed)"} ` +
					`with ${this.workflow.steps.length} steps`,
			);
		}
	}

	/**
	 * Execute the loaded workflow with the given input.
	 *
	 * Each step in the workflow is executed sequentially. The output of each
	 * step is fed into the context for subsequent steps. A full execution
	 * trace is captured for inspection.
	 *
	 * @param input - Input data (populates request.body in the context)
	 * @param options - Optional execution configuration
	 * @returns WorkflowTestResult with output, trace, and per-node results
	 * @throws Error if no workflow is loaded or if a required node is not registered
	 */
	async execute(input: any, options?: WorkflowExecuteOptions): Promise<WorkflowTestResult> {
		if (!this.workflow) {
			throw new Error("No workflow loaded. Call loadWorkflow() first.");
		}

		// Reset trace for this execution
		this.trace = [];
		this.nodeResults = new Map();

		const logger = options?.contextOverrides?.logger ?? new TestLogger();
		const workflowStartTime = performance.now();

		// Build the initial context
		const ctx: Context = {
			id: options?.contextOverrides?.id ?? `test-workflow-${Date.now()}`,
			workflow_name: this.workflow.name ?? "test-workflow",
			workflow_path: options?.contextOverrides?.workflow_path ?? "/test",
			request: {
				body: input ?? {},
				headers: options?.headers ?? options?.contextOverrides?.request?.headers ?? {},
				query: options?.query ?? options?.contextOverrides?.request?.query ?? {},
				params: options?.params ?? options?.contextOverrides?.request?.params ?? {},
			},
			response: {
				data: {},
				error: null,
				success: true,
				contentType: "application/json",
			},
			error: options?.contextOverrides?.error ?? { message: [] },
			logger: logger,
			config: options?.contextOverrides?.config ?? {},
			vars: options?.contextOverrides?.vars ?? {},
			env: options?.contextOverrides?.env ?? {},
			eventLogger: logger,
			_PRIVATE_: {},
		};

		let workflowSuccess = true;
		let workflowError: any = null;

		// Create a timeout promise
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => {
				reject(new Error(`Workflow execution timed out after ${this.config.timeout}ms`));
			}, this.config.timeout);
		});

		try {
			await Promise.race([this.executeSteps(ctx, this.workflow.steps), timeoutPromise]);
		} catch (error: unknown) {
			workflowSuccess = false;
			workflowError = error;

			if (this.config.verbose) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				console.log(`[WorkflowTestRunner] Workflow failed: ${errorMsg}`);
			}
		}

		const workflowEndTime = performance.now();

		return {
			success: workflowSuccess,
			output: workflowSuccess ? ctx.response?.data : workflowError,
			trace: [...this.trace],
			durationMs: workflowEndTime - workflowStartTime,
			nodeResults: new Map(this.nodeResults),
		};
	}

	/**
	 * Get the execution trace from the most recent workflow run.
	 *
	 * @returns Array of ExecutionTrace entries in execution order
	 */
	getTrace(): ExecutionTrace[] {
		return [...this.trace];
	}

	/**
	 * Reset the runner state (clears trace, node results, and loaded workflow).
	 * Registered nodes and mocks are preserved.
	 */
	reset(): void {
		this.workflow = null;
		this.trace = [];
		this.nodeResults = new Map();
	}

	/**
	 * Fully reset the runner, including all registered nodes and mocks.
	 */
	resetAll(): void {
		this.reset();
		this.nodes = new Map();
	}

	/**
	 * Internal: Execute all workflow steps sequentially.
	 */
	private async executeSteps(ctx: Context, steps: WorkflowStep[]): Promise<void> {
		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];
			await this.executeStep(ctx, step, i);
		}
	}

	/**
	 * Internal: Execute a single workflow step.
	 */
	private async executeStep(ctx: Context, step: WorkflowStep, stepIndex: number): Promise<void> {
		const nodeName = step.node;
		let node = this.nodes.get(nodeName);

		// Auto-mock if configured
		if (!node && this.config.mockAllNodes) {
			node = new AutoMockNode(nodeName);
			this.nodes.set(nodeName, node);

			if (this.config.verbose) {
				console.log(`[WorkflowTestRunner] Auto-mocked node: ${nodeName}`);
			}
		}

		if (!node) {
			throw new Error(
				`Node "${nodeName}" is not registered. ` +
					`Call registerNode("${nodeName}", nodeImpl) or mockNode("${nodeName}", handler) before executing.`,
			);
		}

		// Determine input: use step.inputs if defined, otherwise use current response data
		const stepInput = step.inputs ?? ctx.response?.data ?? {};

		if (this.config.verbose) {
			console.log(`[WorkflowTestRunner] Step ${stepIndex}: executing "${step.name}" (node: ${nodeName})`);
		}

		const startTime = performance.now();
		const traceEntry: ExecutionTrace = {
			nodeName: step.name,
			stepIndex,
			input: stepInput,
			output: null,
			durationMs: 0,
			success: false,
			timestamp: Date.now(),
		};

		try {
			const response = (await node.handle(ctx, stepInput as JsonLikeObject)) as IBlokResponse;

			const endTime = performance.now();
			traceEntry.durationMs = endTime - startTime;

			if (response.success === false || response.error) {
				traceEntry.success = false;
				traceEntry.error = response.error?.toString() ?? "Unknown error";
				traceEntry.output = null;

				this.nodeResults.set(step.name, {
					success: false,
					data: null,
					error: response.error,
					context: ctx,
					durationMs: traceEntry.durationMs,
					logs: (ctx.logger as TestLogger).getLogs?.() ?? [],
				});

				this.trace.push(traceEntry);

				throw new Error(`Node "${step.name}" (${nodeName}) failed: ${response.error?.toString() ?? "Unknown error"}`);
			}

			// Update context response with node output
			ctx.response = {
				data: response.data,
				error: null,
				success: true,
				contentType: response.contentType ?? "application/json",
			};

			// If step sets a var, store output in vars
			if (step.set_var) {
				if (!ctx.vars) ctx.vars = {};
				(ctx.vars as Record<string, any>)[step.name] = response.data;
			}

			traceEntry.success = true;
			traceEntry.output = response.data;

			this.nodeResults.set(step.name, {
				success: true,
				data: response.data,
				error: null,
				context: ctx,
				durationMs: traceEntry.durationMs,
				logs: (ctx.logger as TestLogger).getLogs?.() ?? [],
			});
		} catch (error: unknown) {
			const endTime = performance.now();

			if (!traceEntry.durationMs) {
				traceEntry.durationMs = endTime - startTime;
			}

			if (!traceEntry.error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				traceEntry.success = false;
				traceEntry.error = errorMsg;

				this.nodeResults.set(step.name, {
					success: false,
					data: null,
					error,
					context: ctx,
					durationMs: traceEntry.durationMs,
					logs: (ctx.logger as TestLogger).getLogs?.() ?? [],
				});
			}

			this.trace.push(traceEntry);
			throw error;
		}

		this.trace.push(traceEntry);

		if (this.config.verbose) {
			console.log(
				`[WorkflowTestRunner] Step ${stepIndex}: "${step.name}" completed in ${traceEntry.durationMs.toFixed(2)}ms`,
			);
		}
	}
}
