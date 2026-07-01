import type { Context, NodeBase } from "@blokjs/shared";
import BlokService from "../Blok";
import BlokResponse, { type IBlokResponse } from "../BlokResponse";
import Configuration from "../Configuration";
import Runner from "../Runner";
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
	// biome-ignore lint/suspicious/noExplicitAny: test utility handles arbitrary data
	output: any;
	/** Ordered trace of node executions */
	trace: ExecutionTrace[];
	/** Total execution duration in milliseconds */
	durationMs: number;
	/** Per-node results keyed by node name */
	// biome-ignore lint/suspicious/noExplicitAny: test utility handles arbitrary data
	nodeResults: Map<string, TestResult<any>>;
	/**
	 * Final `ctx.state` after the run — per-step persisted outputs keyed by step
	 * id (`state[<id>]`). Populated when the workflow runs through the REAL
	 * engine (v2 / DSL builders / flow constructs). A step that did not run (an
	 * untaken branch arm) is absent, and a step that threw writes nothing — so
	 * `state[id] === undefined` is a truthful "did this step succeed?" check.
	 * Undefined on the legacy sequential path.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: state slots hold arbitrary data
	state?: Record<string, any>;
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
	// biome-ignore lint/suspicious/noExplicitAny: test utility handles arbitrary data
	input: any;
	/** Output data returned by the node */
	// biome-ignore lint/suspicious/noExplicitAny: test utility handles arbitrary data
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
	// biome-ignore lint/suspicious/noExplicitAny: workflow inputs are arbitrary
	inputs?: Record<string, any>;
	// biome-ignore lint/suspicious/noExplicitAny: condition shapes are dynamic
	conditions?: any[];
}

/**
 * Workflow definition structure.
 */
interface WorkflowDefinition {
	name?: string;
	steps: WorkflowStep[];
	// biome-ignore lint/suspicious/noExplicitAny: trigger config is dynamic
	trigger?: any;
}

/**
 * A mock node implementation wrapping a user-provided handler function.
 */
// biome-ignore lint/suspicious/noExplicitAny: mock node needs generic any for test flexibility
class MockNode extends BlokService<any> {
	// biome-ignore lint/suspicious/noExplicitAny: mock handler accepts arbitrary inputs/outputs
	private handler: (input: any, ctx: Context) => Promise<any>;

	// biome-ignore lint/suspicious/noExplicitAny: mock handler accepts arbitrary inputs/outputs
	constructor(name: string, handler: (input: any, ctx: Context) => Promise<any>) {
		super();
		this.name = name;
		this.handler = handler;
	}

	// biome-ignore lint/suspicious/noExplicitAny: matches BlokService.handle signature
	async handle(ctx: Context, inputs: any | JsonLikeObject | Condition[]): Promise<IBlokResponse | BlokService<any>[]> {
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
	// biome-ignore lint/suspicious/noExplicitAny: node registry holds heterogeneous node types
	private nodes: Map<string, BlokService<any>>;
	private workflow: WorkflowDefinition | null;
	/**
	 * The real v2 workflow model (a DSL builder's `_config`, or a v2 JSON
	 * workflow using `use`/`type` steps and/or flow constructs). When set,
	 * execute() runs it through the real Configuration + Runner instead of the
	 * legacy sequential executor, so branch/forEach/switchOn/tryCatch, the
	 * Mapper, and `ctx.state` persistence behave exactly as in production.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: workflow IR is loosely typed
	private v2Model: Record<string, any> | null;
	private trace: ExecutionTrace[];
	// biome-ignore lint/suspicious/noExplicitAny: test results hold arbitrary data
	private nodeResults: Map<string, TestResult<any>>;

	constructor(config?: WorkflowTestConfig) {
		this.config = {
			timeout: config?.timeout ?? 30000,
			verbose: config?.verbose ?? false,
			mockAllNodes: config?.mockAllNodes ?? false,
		};
		this.nodes = new Map();
		this.workflow = null;
		this.v2Model = null;
		this.trace = [];
		this.nodeResults = new Map();
	}

	/**
	 * Register a real node implementation for use in the workflow.
	 *
	 * @param name - The node name as referenced in the workflow steps
	 * @param node - A BlokService instance or a FunctionNode from defineNode()
	 */
	// biome-ignore lint/suspicious/noExplicitAny: accepts heterogeneous node types for test flexibility
	registerNode(name: string, node: BlokService<any> | FunctionNode<any, any>): void {
		node.name = name;
		// biome-ignore lint/suspicious/noExplicitAny: cast required for heterogeneous node storage
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
	// biome-ignore lint/suspicious/noExplicitAny: mock handler accepts arbitrary inputs/outputs
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
		// biome-ignore lint/suspicious/noExplicitAny: workflow shapes are heterogeneous (legacy / v2 JSON / DSL builder)
		let parsed: any = typeof workflow === "string" ? JSON.parse(workflow) : workflow;
		// A @blokjs/core DSL builder carries its lowered v2 IR on `_config`.
		if (parsed && typeof parsed === "object" && parsed._config) parsed = parsed._config;

		if (!parsed?.steps || !Array.isArray(parsed.steps)) {
			throw new Error("Workflow must have a 'steps' array");
		}

		// Discriminate legacy vs real-v2. The legacy sequential executor only
		// understands `{ name, node }` steps; anything using `id`/`use`/`type`
		// or a flow construct (branch/forEach/switchOn/tryCatch, or a nested
		// `steps` pipeline) is a real v2 workflow and must run through the real
		// engine so control flow + `ctx.state` persistence behave as in production.
		const isLegacy = parsed.steps.every(
			// biome-ignore lint/suspicious/noExplicitAny: heterogeneous step shapes
			(s: any) =>
				s &&
				typeof s === "object" &&
				"node" in s &&
				!("use" in s) &&
				!("type" in s) &&
				!("id" in s) &&
				!Array.isArray(s.steps),
		);

		this.workflow = parsed as WorkflowDefinition;
		this.v2Model = isLegacy ? null : (parsed as Record<string, unknown>);

		if (this.config.verbose) {
			console.log(
				`[WorkflowTestRunner] Loaded ${isLegacy ? "legacy" : "v2"} workflow: ${parsed.name ?? "(unnamed)"} ` +
					`with ${parsed.steps.length} steps`,
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
	// biome-ignore lint/suspicious/noExplicitAny: test utility accepts arbitrary input data
	async execute(input: any, options?: WorkflowExecuteOptions): Promise<WorkflowTestResult> {
		if (!this.workflow) {
			throw new Error("No workflow loaded. Call loadWorkflow() first.");
		}

		// Real v2 workflows (flow constructs / DSL builders) run through the real
		// engine so branch/forEach/switchOn/tryCatch + ctx.state behave as in
		// production. Legacy `{ name, node }` workflows keep the simple executor.
		if (this.v2Model) {
			return this.executeV2(input, options);
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
		// biome-ignore lint/suspicious/noExplicitAny: error can be any type
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
	 * Run the loaded v2 workflow through the REAL Configuration + Runner. This
	 * exercises the production flow-node machinery (branch/forEach/switchOn/
	 * tryCatch), the Mapper, and `ctx.state` persistence — unlike the legacy
	 * sequential executor. Registered/mocked nodes are resolved via `getNode`.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: test utility accepts arbitrary input data
	private async executeV2(input: any, options?: WorkflowExecuteOptions): Promise<WorkflowTestResult> {
		this.trace = [];
		this.nodeResults = new Map();
		const logger = options?.contextOverrides?.logger ?? new TestLogger();
		const startTime = performance.now();

		const config = new Configuration();
		const nodes = this.nodes;
		const mockAllNodes = this.config.mockAllNodes;
		// biome-ignore lint/suspicious/noExplicitAny: GlobalOptions is an internal runner shape
		const globalOptions: any = {
			nodes: {
				getNode: (name: string) => {
					let node = nodes.get(name);
					if (!node && mockAllNodes) {
						node = new AutoMockNode(name);
						nodes.set(name, node);
					}
					return node ?? null;
				},
			},
		};

		// biome-ignore lint/suspicious/noExplicitAny: v2 model is loosely typed
		const model = this.v2Model as Record<string, any>;
		await config.init((model.name as string) ?? "test-workflow", globalOptions, model);

		const state: Record<string, unknown> = {};
		const ctx = {
			id: options?.contextOverrides?.id ?? `test-workflow-${Date.now()}`,
			workflow_name: (model.name as string) ?? "test-workflow",
			workflow_path: options?.contextOverrides?.workflow_path ?? "/test",
			request: {
				body: input ?? {},
				headers: options?.headers ?? options?.contextOverrides?.request?.headers ?? {},
				query: options?.query ?? options?.contextOverrides?.request?.query ?? {},
				params: options?.params ?? options?.contextOverrides?.request?.params ?? {},
			},
			response: { data: null, error: null, success: true, contentType: "application/json" },
			error: options?.contextOverrides?.error ?? { message: [] },
			logger,
			config: config.nodes,
			vars: state,
			state,
			env: options?.contextOverrides?.env ?? {},
			eventLogger: logger,
			_PRIVATE_: {},
		} as unknown as Context;

		let workflowSuccess = true;
		// biome-ignore lint/suspicious/noExplicitAny: error can be any type
		let workflowError: any = null;
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(
				() => reject(new Error(`Workflow execution timed out after ${this.config.timeout}ms`)),
				this.config.timeout,
			);
		});
		try {
			await Promise.race([new Runner(config.steps as NodeBase[]).run(ctx), timeoutPromise]);
		} catch (error: unknown) {
			workflowSuccess = false;
			workflowError = error;
			if (this.config.verbose) {
				console.log(`[WorkflowTestRunner] Workflow failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const durationMs = performance.now() - startTime;

		// Derive a per-step trace + nodeResults from the REAL ctx.state. A step
		// that ran and succeeded persists to `state[<id>]`; an untaken branch arm
		// or a thrown step is absent — exactly the truthful signal authors assert.
		const logs = (logger as TestLogger).getLogs?.() ?? [];
		let stepIndex = 0;
		for (const [key, value] of Object.entries(state)) {
			this.nodeResults.set(key, { success: true, data: value, error: null, context: ctx, durationMs: 0, logs });
			this.trace.push({
				nodeName: key,
				stepIndex: stepIndex++,
				input: null,
				output: value,
				durationMs: 0,
				success: true,
				timestamp: Date.now(),
			});
		}

		return {
			success: workflowSuccess,
			output: workflowSuccess ? ctx.response?.data : workflowError,
			trace: [...this.trace],
			durationMs,
			nodeResults: new Map(this.nodeResults),
			state,
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
		this.v2Model = null;
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
