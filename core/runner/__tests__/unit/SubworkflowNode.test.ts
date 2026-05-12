import type { Context, ResponseContext } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	it("default-allows composition when no authorize hook is installed", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-default-allow",
			source: "/c.ts",
			workflow: makeChildWorkflowDef("child-default-allow"),
		});
		const node = makeSubworkflowNode({ stepName: "call", subworkflowName: "child-default-allow" });
		const parentCtx = makeParentCtx();
		parentCtx.config = { call: { inputs: {} } } as unknown as Context["config"];

		const result = await node.run(parentCtx);
		expect(result.success).toBe(true);
	});

	it("denies composition when the authorize hook returns false", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-restricted",
			source: "/c.ts",
			workflow: makeChildWorkflowDef("child-restricted"),
		});
		WorkflowRegistry.getInstance().setAuthorizeFn(() => false);
		const node = makeSubworkflowNode({ stepName: "call", subworkflowName: "child-restricted" });
		const parentCtx = makeParentCtx();
		parentCtx.config = { call: { inputs: {} } } as unknown as Context["config"];

		await expect(node.run(parentCtx)).rejects.toThrow(/Sub-workflow access denied/);
	});

	it("authorize hook receives parent + child name + ctx", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-tenant-a",
			source: "/c.ts",
			workflow: makeChildWorkflowDef("child-tenant-a"),
		});
		const calls: Array<[string, string, string]> = [];
		WorkflowRegistry.getInstance().setAuthorizeFn((parent, child, ctx) => {
			calls.push([parent, child, ctx.workflow_name ?? ""]);
			return true;
		});
		const node = makeSubworkflowNode({ stepName: "call", subworkflowName: "child-tenant-a" });
		const parentCtx = makeParentCtx();
		parentCtx.config = { call: { inputs: {} } } as unknown as Context["config"];

		await node.run(parentCtx);

		expect(calls).toEqual([["parent-wf", "child-tenant-a", "parent-wf"]]);
	});

	it("supports async authorize hooks (e.g. tenant DB lookups)", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-async-allow",
			source: "/c.ts",
			workflow: makeChildWorkflowDef("child-async-allow"),
		});
		WorkflowRegistry.getInstance().setAuthorizeFn(async () => {
			await new Promise((r) => setTimeout(r, 1));
			return true;
		});
		const node = makeSubworkflowNode({ stepName: "call", subworkflowName: "child-async-allow" });
		const parentCtx = makeParentCtx();
		parentCtx.config = { call: { inputs: {} } } as unknown as Context["config"];

		const result = await node.run(parentCtx);
		expect(result.success).toBe(true);
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
			async run(_ctx: Context): Promise<ResponseContext> {
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

// =============================================================================
// Tier 2 #4 follow-up — wait: false (fire-and-forget)
// =============================================================================

describe("SubworkflowNode — fire-and-forget (wait: false)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		RunTracker.resetInstance();
	});

	afterEach(() => {
		WorkflowRegistry.resetInstance();
		RunTracker.resetInstance();
	});

	function flush(): Promise<void> {
		// setImmediate macrotask + a few microtask ticks for the chained
		// then/catch handlers + tracker.completeRun.
		return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
	}

	it("returns immediately with {runId, workflowName, scheduledAt} — does NOT await child", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-async",
			source: "/child-async.ts",
			workflow: makeChildWorkflowDef("child-async"),
		});
		const node = makeSubworkflowNode({
			stepName: "fire-it",
			subworkflowName: "child-async",
			wait: false,
		});

		const parentCtx = makeParentCtx();
		parentCtx.config = { "fire-it": { inputs: { from: "p" } } } as unknown as Context["config"];

		const result = await node.run(parentCtx);

		expect(result.success).toBe(true);
		expect(result.error).toBeNull();
		const data = result.data as { runId: string; workflowName: string; scheduledAt: number };
		expect(data.workflowName).toBe("child-async");
		expect(typeof data.runId).toBe("string");
		expect(data.runId.length).toBeGreaterThan(0);
		expect(typeof data.scheduledAt).toBe("number");
		expect(data.scheduledAt).toBeLessThanOrEqual(Date.now());

		// Child still in `running` BEFORE setImmediate fires.
		const tracker = RunTracker.getInstance();
		const childRunBefore = tracker.getStore().getRun(data.runId);
		expect(childRunBefore?.status).toBe("running");

		// Wait for the async dispatch to complete.
		await flush();

		const childRunAfter = tracker.getStore().getRun(data.runId);
		expect(childRunAfter?.status).toBe("completed");
	});

	it("dispatch metadata lands on parent state[<id>] via applyStepOutput", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-bg",
			source: "/child-bg.ts",
			workflow: makeChildWorkflowDef("child-bg"),
		});
		const node = makeSubworkflowNode({
			stepName: "send-receipt",
			subworkflowName: "child-bg",
			wait: false,
		});

		const parentCtx = makeParentCtx();
		parentCtx.config = { "send-receipt": { inputs: {} } } as unknown as Context["config"];
		(parentCtx as unknown as { state: Record<string, unknown> }).state = {};

		await node.run(parentCtx);
		await flush();

		const state = (parentCtx as unknown as { state: Record<string, unknown> }).state;
		const stored = state["send-receipt"] as { runId: string; workflowName: string };
		expect(stored.workflowName).toBe("child-bg");
		expect(typeof stored.runId).toBe("string");
	});

	it("attaches parentRunId + parentNodeRunId on the async child run", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-bg",
			source: "/child-bg.ts",
			workflow: makeChildWorkflowDef("child-bg"),
		});
		const node = makeSubworkflowNode({
			stepName: "fire",
			subworkflowName: "child-bg",
			wait: false,
		});

		const parentCtx = makeParentCtx();
		parentCtx.config = { fire: { inputs: {} } } as unknown as Context["config"];
		(parentCtx as Record<string, unknown>)._traceNodeId = "parent_node_xyz";

		const result = await node.run(parentCtx);
		await flush();

		const data = result.data as { runId: string };
		const tracker = RunTracker.getInstance();
		const childRun = tracker.getStore().getRun(data.runId);
		expect(childRun?.parentRunId).toBe((parentCtx as Record<string, unknown>)._traceRunId);
		expect(childRun?.parentNodeRunId).toBe("parent_node_xyz");
	});

	it("child failure marks child run as failed but does NOT throw to the parent", async () => {
		// Failing child handler: throws inside execute.
		class FailingNode extends EchoBodyNode {
			constructor() {
				super("fail-node");
			}
			override async run(): Promise<ResponseContext> {
				throw new Error("boom");
			}
		}
		WorkflowRegistry.getInstance().register({
			name: "child-fail",
			source: "/child-fail.ts",
			workflow: {
				name: "child-fail",
				version: "1.0.0",
				trigger: { manual: {} },
				steps: [{ id: "go", use: "fail-node", type: "module", inputs: {} }],
			},
		});

		const node = new SubworkflowNode();
		node.name = "fire";
		node.node = "@blokjs/subworkflow";
		node.type = "subworkflow";
		node.subworkflow = "child-fail";
		node.wait = false;
		node.globalOptions = {
			nodes: {
				getNode: (name: string) => (name === "fail-node" ? new FailingNode() : null),
			},
		} as unknown as SubworkflowNode["globalOptions"];

		const parentCtx = makeParentCtx();
		parentCtx.config = { fire: { inputs: {} } } as unknown as Context["config"];

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		// Parent step does NOT throw despite child failing.
		const result = await node.run(parentCtx);
		expect(result.success).toBe(true);
		expect(result.error).toBeNull();

		await flush();

		const data = result.data as { runId: string };
		const tracker = RunTracker.getInstance();
		const childRun = tracker.getStore().getRun(data.runId);
		expect(childRun?.status).toBe("failed");
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("multiple parallel fire-and-forget invocations create distinct child runs", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-multi",
			source: "/child-multi.ts",
			workflow: makeChildWorkflowDef("child-multi"),
		});

		const parentCtx = makeParentCtx();
		const tracker = RunTracker.getInstance();
		const parentRunId = (parentCtx as Record<string, unknown>)._traceRunId as string;

		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const node = makeSubworkflowNode({
				stepName: `fire-${i}`,
				subworkflowName: "child-multi",
				wait: false,
			});
			parentCtx.config = { [`fire-${i}`]: { inputs: {} } } as unknown as Context["config"];
			const result = await node.run(parentCtx);
			ids.push((result.data as { runId: string }).runId);
		}
		await flush();

		// All three child runs exist and are linked to the same parent.
		const children = tracker.getRunsByParent(parentRunId);
		expect(children.length).toBe(3);
		const childIds = children.map((c) => c.id).sort();
		expect(childIds).toEqual(ids.sort());
	});

	it("respects the persistence rules — ephemeral skips state", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-eph",
			source: "/child-eph.ts",
			workflow: makeChildWorkflowDef("child-eph"),
		});
		const node = makeSubworkflowNode({
			stepName: "fire",
			subworkflowName: "child-eph",
			wait: false,
		});
		node.ephemeral = true; // skip state persistence

		const parentCtx = makeParentCtx();
		parentCtx.config = { fire: { inputs: {} } } as unknown as Context["config"];
		(parentCtx as unknown as { state: Record<string, unknown> }).state = {};

		await node.run(parentCtx);
		await flush();

		const state = (parentCtx as unknown as { state: Record<string, unknown> }).state;
		expect(state.fire).toBeUndefined();
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

/**
 * G3 — polymorphic sub-workflow names + `allowList` safety guard.
 *
 * The capability shipped under v0.7 PR 4 for the webhook trigger's
 * namespace-prefixed dispatch (`stripe.invoice.paid` style). G3 promotes
 * it to a first-class subworkflow-step feature with an opt-in allow-list
 * for production hardening.
 */
describe("SubworkflowNode — polymorphic dispatch (G3)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		RunTracker.resetInstance();
	});

	afterEach(() => {
		WorkflowRegistry.resetInstance();
		RunTracker.resetInstance();
	});

	it("resolves a `js/` expression against the live ctx and dispatches the named child", async () => {
		WorkflowRegistry.getInstance().register({
			name: "handler.payment",
			source: "/handler-payment.ts",
			workflow: makeChildWorkflowDef("handler.payment"),
		});
		const node = makeSubworkflowNode({
			stepName: "dispatch",
			subworkflowName: "js/ctx.req.body.kind",
		});

		const parentCtx = makeParentCtx();
		parentCtx.request = {
			body: { kind: "handler.payment" },
			headers: {},
			params: {},
			query: {},
		} as unknown as Context["request"];
		parentCtx.config = { dispatch: { inputs: { payload: "x" } } } as unknown as Context["config"];

		const result = await node.run(parentCtx);

		expect(result.success).toBe(true);
		// Child workflow received the parent's resolved inputs verbatim.
		const childResponse = result.data as { echoed: { payload: string } };
		expect(childResponse.echoed).toEqual({ payload: "x" });
	});

	it("resolves a `$.<path>` expression by normalising it to `js/ctx....`", async () => {
		WorkflowRegistry.getInstance().register({
			name: "handler.shipping",
			source: "/handler-shipping.ts",
			workflow: makeChildWorkflowDef("handler.shipping"),
		});
		const node = makeSubworkflowNode({
			stepName: "dispatch",
			subworkflowName: "$.req.body.kind",
		});

		const parentCtx = makeParentCtx();
		parentCtx.request = {
			body: { kind: "handler.shipping" },
			headers: {},
			params: {},
			query: {},
		} as unknown as Context["request"];
		parentCtx.config = { dispatch: { inputs: {} } } as unknown as Context["config"];

		const result = await node.run(parentCtx);
		expect(result.success).toBe(true);
	});

	it("throws when the expression resolves to an empty string (clearer than 'not found')", async () => {
		const node = makeSubworkflowNode({
			stepName: "dispatch",
			subworkflowName: "js/ctx.req.body.kind",
		});
		const parentCtx = makeParentCtx();
		parentCtx.request = {
			body: { kind: "" },
			headers: {},
			params: {},
			query: {},
		} as unknown as Context["request"];
		parentCtx.config = { dispatch: { inputs: {} } } as unknown as Context["config"];

		await expect(node.run(parentCtx)).rejects.toThrow(/Polymorphic sub-workflow name .* resolved to/);
	});

	it("admits the dispatch when the resolved name is in `allowList`", async () => {
		WorkflowRegistry.getInstance().register({
			name: "handler.payment",
			source: "/handler-payment.ts",
			workflow: makeChildWorkflowDef("handler.payment"),
		});
		const node = makeSubworkflowNode({
			stepName: "dispatch",
			subworkflowName: "js/ctx.req.body.kind",
		});
		node.allowList = Object.freeze(["handler.payment", "handler.shipping"]);

		const parentCtx = makeParentCtx();
		parentCtx.request = {
			body: { kind: "handler.payment" },
			headers: {},
			params: {},
			query: {},
		} as unknown as Context["request"];
		parentCtx.config = { dispatch: { inputs: {} } } as unknown as Context["config"];

		const result = await node.run(parentCtx);
		expect(result.success).toBe(true);
	});

	it("rejects the dispatch when the resolved name is NOT in `allowList`", async () => {
		WorkflowRegistry.getInstance().register({
			name: "internal.admin-action",
			source: "/internal-admin.ts",
			workflow: makeChildWorkflowDef("internal.admin-action"),
		});
		const node = makeSubworkflowNode({
			stepName: "dispatch",
			subworkflowName: "js/ctx.req.body.kind",
		});
		// Authoring intent: a webhook receiver should only ever dispatch
		// two handlers — never the internal admin workflow even if a
		// malicious ctx body asked for it.
		node.allowList = Object.freeze(["handler.payment", "handler.shipping"]);

		const parentCtx = makeParentCtx();
		parentCtx.request = {
			body: { kind: "internal.admin-action" },
			headers: {},
			params: {},
			query: {},
		} as unknown as Context["request"];
		parentCtx.config = { dispatch: { inputs: {} } } as unknown as Context["config"];

		await expect(node.run(parentCtx)).rejects.toThrow(
			/Sub-workflow dispatch blocked: resolved name "internal\.admin-action" is not in the step's `allowList`/,
		);
	});

	it("enforces `allowList` against the namespace-prefixed name, not the raw resolution", async () => {
		WorkflowRegistry.getInstance().register({
			name: "stripe.invoice.paid",
			source: "/stripe-invoice-paid.ts",
			workflow: makeChildWorkflowDef("stripe.invoice.paid"),
		});
		const node = makeSubworkflowNode({
			stepName: "dispatch",
			subworkflowName: "js/ctx.req.body.type",
		});
		node.namespace = "stripe";
		// Authors write the prefixed name in the allow-list — what they
		// actually want to permit dispatching to.
		node.allowList = Object.freeze(["stripe.invoice.paid"]);

		const parentCtx = makeParentCtx();
		parentCtx.request = {
			body: { type: "invoice.paid" },
			headers: {},
			params: {},
			query: {},
		} as unknown as Context["request"];
		parentCtx.config = { dispatch: { inputs: {} } } as unknown as Context["config"];

		const result = await node.run(parentCtx);
		expect(result.success).toBe(true);
	});

	it("rejects the dispatch when the namespace-prefixed name isn't allow-listed", async () => {
		WorkflowRegistry.getInstance().register({
			name: "stripe.invoice.payment_failed",
			source: "/c.ts",
			workflow: makeChildWorkflowDef("stripe.invoice.payment_failed"),
		});
		const node = makeSubworkflowNode({
			stepName: "dispatch",
			subworkflowName: "js/ctx.req.body.type",
		});
		node.namespace = "stripe";
		node.allowList = Object.freeze(["stripe.invoice.paid"]);

		const parentCtx = makeParentCtx();
		parentCtx.request = {
			body: { type: "invoice.payment_failed" },
			headers: {},
			params: {},
			query: {},
		} as unknown as Context["request"];
		parentCtx.config = { dispatch: { inputs: {} } } as unknown as Context["config"];

		await expect(node.run(parentCtx)).rejects.toThrow(/"stripe\.invoice\.payment_failed" is not in the step's/);
	});

	it("`allowList` also guards a literal `subworkflow:` name (defence-in-depth audit)", async () => {
		WorkflowRegistry.getInstance().register({
			name: "child-restricted-literal",
			source: "/c.ts",
			workflow: makeChildWorkflowDef("child-restricted-literal"),
		});
		const node = makeSubworkflowNode({
			stepName: "call",
			subworkflowName: "child-restricted-literal",
		});
		node.allowList = Object.freeze(["different-workflow-entirely"]);

		const parentCtx = makeParentCtx();
		parentCtx.config = { call: { inputs: {} } } as unknown as Context["config"];

		await expect(node.run(parentCtx)).rejects.toThrow(/"child-restricted-literal" is not in the step's/);
	});

	it("no-op when `allowList` is undefined (back-compat: polymorphic dispatch without a guard still works)", async () => {
		WorkflowRegistry.getInstance().register({
			name: "handler.anything",
			source: "/c.ts",
			workflow: makeChildWorkflowDef("handler.anything"),
		});
		const node = makeSubworkflowNode({
			stepName: "dispatch",
			subworkflowName: "js/ctx.req.body.kind",
		});
		// allowList intentionally not set.

		const parentCtx = makeParentCtx();
		parentCtx.request = {
			body: { kind: "handler.anything" },
			headers: {},
			params: {},
			query: {},
		} as unknown as Context["request"];
		parentCtx.config = { dispatch: { inputs: {} } } as unknown as Context["config"];

		const result = await node.run(parentCtx);
		expect(result.success).toBe(true);
	});
});
