import type { Context, ResponseContext } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Configuration from "../../src/Configuration";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import { SubworkflowNode } from "../../src/SubworkflowNode";
import { RunTracker } from "../../src/tracing/RunTracker";
import { createChildContext } from "../../src/utils/createChildContext";
import { WorkflowRegistry } from "../../src/workflow/WorkflowRegistry";

/**
 * Test handler — used as the chain-init style step inside child workflows.
 * Reads `ctx.req.body.payload` and returns it as data so tests can assert
 * on input/output flow across the parent → child boundary.
 */
class EchoBodyNode extends RunnerNode {
	public lastSeenBody: unknown = null;

	constructor(name = "echo") {
		super();
		this.name = name;
		this.node = name;
		this.type = "module";
		this.active = true;
	}

	async run(ctx: Context): Promise<ResponseContext> {
		this.lastSeenBody = ctx.request.body;
		return { success: true, data: { echoed: ctx.request.body }, error: null };
	}
}

/**
 * Build a minimal raw v2 workflow that registers a single echo step.
 * Used to feed the registry — the SubworkflowNode then materializes
 * a Configuration from this object via Configuration.init(preloaded).
 */
function makeChildWorkflowDef(name: string) {
	return {
		name,
		version: "1.0.0",
		trigger: { manual: {} },
		steps: [
			{
				id: "echo",
				use: "echo",
				type: "module",
				inputs: { payload: "js/ctx.req.body" },
			},
		],
	};
}

/**
 * Build a parent ctx for direct SubworkflowNode invocation. The
 * SubworkflowNode reads inputs from `ctx.config[step.name]` (resolved
 * by the blueprint mapper in production); we set them by hand here.
 */
function makeParentCtx(overrides: Partial<Context> = {}): Context {
	const tracker = RunTracker.getInstance();
	const run = tracker.startRun({
		workflowName: "parent-wf",
		workflowPath: "/parent.ts",
		triggerType: "http",
		triggerSummary: "POST /parent",
		nodeCount: 1,
	});
	const ctx: Context = {
		id: "parent-req",
		workflow_name: "parent-wf",
		workflow_path: "/parent.ts",
		request: {
			body: { from: "parent" },
			headers: {},
			params: {},
			query: {},
		} as unknown as Context["request"],
		response: { data: null, contentType: "application/json", success: true, error: null } as Context["response"],
		error: { message: [] } as Context["error"],
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: {} as unknown as Context["config"],
		vars: {},
		env: {} as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
		...overrides,
	};
	(ctx as Record<string, unknown>)._traceRunId = run.id;
	// Production `TriggerBase.createContext` defines req/prev as getter
	// aliases for request/response — mirror that here so v2 expressions
	// like `js/ctx.req.body` resolve correctly through blueprintMapper.
	Object.defineProperty(ctx, "req", {
		get() {
			return ctx.request;
		},
		enumerable: true,
		configurable: true,
	});
	Object.defineProperty(ctx, "prev", {
		get() {
			return ctx.response;
		},
		enumerable: true,
		configurable: true,
	});
	return ctx;
}

/**
 * Build a SubworkflowNode wired as Configuration.subworkflowResolver
 * would build it. Skips going through Configuration.init for the
 * parent — direct unit-level invocation.
 */
function makeSubworkflowNode(opts: {
	stepName: string;
	subworkflowName: string;
	wait?: boolean;
}): SubworkflowNode {
	const node = new SubworkflowNode();
	node.name = opts.stepName;
	node.node = "@blokjs/subworkflow";
	node.type = "subworkflow";
	node.subworkflow = opts.subworkflowName;
	node.wait = opts.wait !== false;
	// globalOptions provides the `nodes` registry so child Configuration
	// can resolve `module:` step references (the EchoBodyNode handler).
	node.globalOptions = {
		nodes: {
			getNode: (name: string) => {
				if (name === "echo") return new EchoBodyNode("echo");
				return null;
			},
		},
	} as unknown as SubworkflowNode["globalOptions"];
	return node;
}

describe("SubworkflowNode — dispatch", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		RunTracker.resetInstance();
	});

	afterEach(() => {
		WorkflowRegistry.resetInstance();
		RunTracker.resetInstance();
	});

	it("invokes the named child workflow and returns its ctx.response", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-echo",
			source: "/child-echo.ts",
			workflow: makeChildWorkflowDef("child-echo"),
		});
		const node = makeSubworkflowNode({ stepName: "call-child", subworkflowName: "child-echo" });

		const parentCtx = makeParentCtx();
		// Parent step's resolved inputs live on ctx.config[step.name].inputs
		// after blueprintMapper runs. We hand-set the post-mapper shape here
		// to match production.
		parentCtx.config = {
			"call-child": { inputs: { from: "parent-input" } },
		} as unknown as Context["config"];

		const result = await node.run(parentCtx);

		expect(result.success).toBe(true);
		expect(result.error).toBeNull();
		// Result.data is the child's ctx.response — RunnerSteps assigns
		// `ctx.response = model.data` after each step, so by the end of
		// the child run ctx.response holds the final step's data shape
		// (here: the echo node's `{ echoed: ... }`).
		const childResponse = result.data as { echoed: { from: string } };
		expect(childResponse.echoed).toEqual({ from: "parent-input" });
	});

	it("isolates child state from parent (parent state untouched)", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-isolated",
			source: "/child.ts",
			workflow: makeChildWorkflowDef("child-isolated"),
		});
		const node = makeSubworkflowNode({ stepName: "call-isolated", subworkflowName: "child-isolated" });

		const parentCtx = makeParentCtx();
		parentCtx.config = { "call-isolated": { inputs: { value: 42 } } } as unknown as Context["config"];
		// Pre-populate parent state — child must NOT see this.
		(parentCtx as unknown as { state: Record<string, unknown> }).state = { secret: "parent-only" };

		await node.run(parentCtx);

		// Parent state is unchanged by child execution.
		const parentState = (parentCtx as unknown as { state: Record<string, unknown> }).state;
		expect(parentState.secret).toBe("parent-only");
	});

	it("throws a clear error when the child workflow is not registered", async () => {
		const node = makeSubworkflowNode({ stepName: "call-missing", subworkflowName: "no-such-workflow" });
		const parentCtx = makeParentCtx();
		parentCtx.config = { "call-missing": { inputs: {} } } as unknown as Context["config"];

		await expect(node.run(parentCtx)).rejects.toThrow(/not found in WorkflowRegistry/);
	});

	it("child run is queryable via tracker.getRunsByParent (Phase 4 lineage API)", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-by-parent",
			source: "/c.ts",
			workflow: makeChildWorkflowDef("child-by-parent"),
		});
		const node = makeSubworkflowNode({ stepName: "lookup", subworkflowName: "child-by-parent" });

		const parentCtx = makeParentCtx();
		const parentRunId = (parentCtx as Record<string, unknown>)._traceRunId as string;
		parentCtx.config = { lookup: { inputs: {} } } as unknown as Context["config"];

		// Fire the child once.
		await node.run(parentCtx);

		const tracker = RunTracker.getInstance();
		const subruns = tracker.getRunsByParent(parentRunId);
		expect(subruns).toHaveLength(1);
		expect(subruns[0].workflowName).toBe("child-by-parent");
		expect(subruns[0].parentRunId).toBe(parentRunId);

		// Sibling: a parent with no children returns an empty array.
		expect(tracker.getRunsByParent("nonexistent-parent")).toEqual([]);
	});

	it("attaches parentRunId + parentNodeRunId on the child's WorkflowRun", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-lineage",
			source: "/child.ts",
			workflow: makeChildWorkflowDef("child-lineage"),
		});
		const node = makeSubworkflowNode({ stepName: "call-lineage", subworkflowName: "child-lineage" });

		const parentCtx = makeParentCtx();
		const parentRunId = (parentCtx as Record<string, unknown>)._traceRunId as string;
		(parentCtx as Record<string, unknown>)._traceNodeId = "node-abc";
		parentCtx.config = { "call-lineage": { inputs: {} } } as unknown as Context["config"];

		await node.run(parentCtx);

		// One sub-run was created with the right lineage.
		const tracker = RunTracker.getInstance();
		const runs = tracker.getStore().getRuns({ limit: 100 }).runs;
		const child = runs.find((r) => r.workflowName === "child-lineage");
		expect(child).toBeDefined();
		expect(child?.parentRunId).toBe(parentRunId);
		expect(child?.parentNodeRunId).toBe("node-abc");
	});

	it("propagates child failure to the parent (caller's retry/failNode loop catches it)", async () => {
		class ThrowingNode extends RunnerNode {
			constructor() {
				super();
				this.name = "boom";
				this.node = "boom";
				this.type = "module";
				this.active = true;
			}
			async run() {
				throw new Error("child kaboom");
			}
		}
		WorkflowRegistry.getInstance().register({
			name: "child-fail",
			source: "/c.ts",
			workflow: {
				name: "child-fail",
				version: "1.0.0",
				trigger: { manual: {} },
				steps: [{ id: "boom", use: "boom", type: "module", inputs: {} }],
			},
		});
		const node = new SubworkflowNode();
		node.name = "call-fail";
		node.node = "@blokjs/subworkflow";
		node.type = "subworkflow";
		node.subworkflow = "child-fail";
		node.wait = true;
		node.globalOptions = {
			nodes: { getNode: () => new ThrowingNode() },
		} as unknown as SubworkflowNode["globalOptions"];

		const parentCtx = makeParentCtx();
		parentCtx.config = { "call-fail": { inputs: {} } } as unknown as Context["config"];

		await expect(node.run(parentCtx)).rejects.toThrow(/child kaboom/);

		// Child run was failNode'd, not abandoned.
		const tracker = RunTracker.getInstance();
		const runs = tracker.getStore().getRuns({ limit: 100 }).runs;
		const child = runs.find((r) => r.workflowName === "child-fail");
		expect(child?.status).toBe("failed");
	});

	it("respects BLOK_MAX_SUBWORKFLOW_DEPTH (rejects beyond cap)", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-deep",
			source: "/c.ts",
			workflow: makeChildWorkflowDef("child-deep"),
		});
		const node = makeSubworkflowNode({ stepName: "deep", subworkflowName: "child-deep" });
		const parentCtx = makeParentCtx();
		// Pretend we're already at depth 10 (the default cap).
		(parentCtx as Record<string, unknown>)._subworkflowDepth = 10;
		parentCtx.config = { deep: { inputs: {} } } as unknown as Context["config"];

		await expect(node.run(parentCtx)).rejects.toThrow(/recursion limit exceeded/);
	});

	it("inputs flow from parent step → child request.body (function-call semantics)", async () => {
		// Capture in a closure — moduleResolver clones nodeHandler instances,
		// so writes to `this.lastSeenBody` happen on the clone, not the
		// original. Use a shared sink to assert what the child actually saw.
		const seen: { body: unknown } = { body: null };
		class CapturingNode extends RunnerNode {
			constructor() {
				super();
				this.name = "echo";
				this.node = "echo";
				this.type = "module";
				this.active = true;
			}
			async run(ctx: Context): Promise<ResponseContext> {
				seen.body = ctx.request.body;
				return { success: true, data: { ok: true }, error: null };
			}
		}
		WorkflowRegistry.getInstance().register({
			name: "child-inputs",
			source: "/c.ts",
			workflow: makeChildWorkflowDef("child-inputs"),
		});
		const node = new SubworkflowNode();
		node.name = "with-inputs";
		node.node = "@blokjs/subworkflow";
		node.type = "subworkflow";
		node.subworkflow = "child-inputs";
		node.wait = true;
		node.globalOptions = {
			nodes: { getNode: () => new CapturingNode() },
		} as unknown as SubworkflowNode["globalOptions"];

		const parentCtx = makeParentCtx();
		parentCtx.config = {
			"with-inputs": { inputs: { user: { id: 1 }, amount: 99.99 } },
		} as unknown as Context["config"];

		await node.run(parentCtx);

		// The child's echo node saw the parent step's resolved inputs as
		// its ctx.request.body — same shape, no transformation.
		expect(seen.body).toEqual({ user: { id: 1 }, amount: 99.99 });
	});

	it("works through Configuration + Runner end-to-end (parent has subworkflow step)", async () => {
		// Register child in the workflow registry.
		WorkflowRegistry.getInstance().register({
			name: "e2e-child",
			source: "/e2e-child.ts",
			workflow: makeChildWorkflowDef("e2e-child"),
		});

		// Build a parent workflow with a subworkflow step + run it through
		// the full Configuration → Runner pipeline.
		const parentWorkflow = {
			name: "e2e-parent",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				{
					id: "call-e2e",
					subworkflow: "e2e-child",
					inputs: { from: "js/ctx.req.body" },
				},
			],
		};
		const echo = new EchoBodyNode("echo");
		const opts = {
			nodes: { getNode: () => echo },
		} as unknown as NonNullable<SubworkflowNode["globalOptions"]>;

		const parentConfig = new Configuration();
		await parentConfig.init("e2e-parent", opts, parentWorkflow);
		const runner = new Runner(parentConfig.steps);

		const parentCtx = makeParentCtx({
			workflow_name: "e2e-parent",
			workflow_path: "/e2e-parent.ts",
			request: {
				body: { hello: "world" },
				headers: {},
				params: {},
				query: {},
			} as unknown as Context["request"],
			config: parentConfig.nodes as unknown as Context["config"],
		});

		await runner.run(parentCtx);

		// Parent step's output landed on state[call-e2e] = child's ctx.response.
		// EchoBodyNode reads ctx.request.body directly (not the resolved
		// inputs.payload), so the echoed value is the entire parent inputs
		// object — `{ from: <parent body> }` per the workflow definition.
		const state = (parentCtx as unknown as { state: Record<string, unknown> }).state;
		const callOutput = state["call-e2e"] as { echoed: { from: { hello: string } } };
		expect(callOutput.echoed).toEqual({ from: { hello: "world" } });
	});
});

describe("createChildContext", () => {
	it("creates an isolated child ctx with fresh state", () => {
		const parent: Context = {
			id: "parent",
			workflow_name: "parent-wf",
			request: {
				body: { from: "parent" },
				headers: {},
				params: {},
				query: {},
			} as unknown as Context["request"],
			response: { data: "parent-data", contentType: "", success: true, error: null } as Context["response"],
			error: { message: [] } as Context["error"],
			logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
			config: { foo: { inputs: {} } } as unknown as Context["config"],
			eventLogger: null,
			_PRIVATE_: null,
		};
		(parent as unknown as { state: Record<string, unknown> }).state = { secret: "parent-only" };

		const child = createChildContext(parent, {
			workflowName: "child-wf",
			workflowPath: "/child.ts",
			body: { from: "input" },
			config: { childStep: { inputs: {} } } as unknown as Context["config"],
		});

		expect(child.id).not.toBe("parent");
		expect(child.workflow_name).toBe("child-wf");
		expect(child.request.body).toEqual({ from: "input" });
		// Fresh state — parent's secret is NOT visible.
		expect(child.state).toEqual({});
		// Logger + env are shared by reference.
		expect(child.logger).toBe(parent.logger);
		// req / prev getters work.
		expect(child.req).toBe(child.request);
		expect(child.prev).toBe(child.response);
	});
});
