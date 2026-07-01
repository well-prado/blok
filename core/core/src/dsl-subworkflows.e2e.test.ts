/**
 * Handle-DSL sub-workflows — LIVE E2E (issue #603).
 *
 * Proves the `subworkflow:` step primitive against real execution — a real
 * parent workflow driven through the full `Configuration → Runner` pipeline,
 * a child seeded in the process-wide `WorkflowRegistry`, and (for http-self)
 * a REAL HTTP server on a live localhost socket so the cross-process dispatch
 * makes a genuine `fetch` over the wire, not a mocked one.
 *
 * Five behaviours, each with non-vacuous assertions on real state + lineage:
 *   1. in-process wait:true (default) — parent blocks, child's ctx.response
 *      lands on the parent step's state[id]; child WorkflowRun carries the
 *      parent's runId (lineage).
 *   2. wait:false — parent step returns IMMEDIATELY with
 *      {runId, workflowName, scheduledAt} while the child runs async
 *      (setImmediate); the child run transitions running → completed.
 *   3. http-self dispatch — child dispatched as a real HTTP request to
 *      BLOK_SELF_BASE_URL against a live server; we assert the child ran on
 *      the FAR side of the socket + lineage headers crossed the wire.
 *   4. polymorphic name — `subworkflow: "$.req.body.kind"` resolves at
 *      dispatch time to the right child.
 *   5. allowList — a resolved name NOT in the allowList is rejected at run
 *      time with a structured error (and never reaches materialization).
 *
 * No external infra: the store is in-memory under vitest (NODE_ENV=test) and
 * the HTTP server is stood up in-process on an ephemeral port. Every workflow
 * name is namespaced with a per-run random SUFFIX so concurrent suites on the
 * same process never collide (campaign guardrail #2).
 *
 * Runs by default (like the mcp/websocket/cron live integration suites) — the
 * "live infra" is a real localhost socket, not a container.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Configuration, type GlobalOptions, Runner } from "@blokjs/core/runtime";
import RunnerNode from "@blokjs/runner/RunnerNode";
import { SubworkflowNode } from "@blokjs/runner/SubworkflowNode";
import { RunTracker } from "@blokjs/runner/tracing/RunTracker";
import { WorkflowRegistry } from "@blokjs/runner/workflow/WorkflowRegistry";
import type { Context, ResponseContext } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SUFFIX = Math.random().toString(36).slice(2);

/**
 * Child handler — echoes its `ctx.request.body` back so tests can prove the
 * parent's resolved inputs became the child's request body (function-call
 * semantics) AND that the child actually executed (`ran` marker).
 */
class EchoNode extends RunnerNode {
	constructor() {
		super();
		this.name = "echo";
		this.node = "echo";
		this.type = "module";
		this.active = true;
	}
	async run(ctx: Context): Promise<ResponseContext> {
		return { success: true, data: { echoed: ctx.request.body, ran: "child" }, error: null };
	}
}

function childDef(name: string, withHttp = false) {
	return {
		name,
		version: "1.0.0",
		trigger: withHttp ? { http: { method: "POST", path: `/${name}` } } : { manual: {} },
		steps: [{ id: "echo", use: "echo", type: "module", inputs: {} }],
	};
}

/** Node registry that resolves the single `echo` handler used by every child. */
function opts(): GlobalOptions {
	return {
		nodes: { getNode: (n: string) => (n === "echo" ? new EchoNode() : null) },
	} as unknown as GlobalOptions;
}

/**
 * Build a parent Context the way `TriggerBase.createContext` would — with the
 * `req`/`prev` getter aliases so `js/ctx.req.body` / `$.req.body` expressions
 * resolve through the Mapper (used by polymorphic name resolution + inputs).
 * Registers a real parent run so sub-runs get a parentRunId to attach to.
 */
function makeParentCtx(name: string, body: unknown, config: Context["config"]): Context {
	const run = RunTracker.getInstance().startRun({
		workflowName: name,
		workflowPath: `/${name}.ts`,
		triggerType: "http",
		triggerSummary: `POST /${name}`,
		nodeCount: 1,
	});
	const ctx = {
		id: `req-${SUFFIX}`,
		workflow_name: name,
		workflow_path: `/${name}.ts`,
		request: { body, headers: {}, params: {}, query: {} },
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log() {}, error() {} },
		config,
		vars: {},
		env: {},
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;
	(ctx as Record<string, unknown>)._traceRunId = run.id;
	Object.defineProperty(ctx, "req", { get: () => ctx.request, enumerable: true, configurable: true });
	Object.defineProperty(ctx, "prev", { get: () => ctx.response, enumerable: true, configurable: true });
	return ctx;
}

/** Build a raw SubworkflowNode wired as Configuration.subworkflowResolver would. */
function makeNode(o: {
	stepName: string;
	name: string;
	wait?: boolean;
	dispatch?: "in-process" | "http-self";
	allowList?: readonly string[];
}): SubworkflowNode {
	const node = new SubworkflowNode();
	node.name = o.stepName;
	node.node = "@blokjs/subworkflow";
	node.type = "subworkflow";
	node.subworkflow = o.name;
	node.wait = o.wait !== false;
	if (o.dispatch) node.dispatch = o.dispatch;
	if (o.allowList) node.allowList = Object.freeze([...o.allowList]);
	node.globalOptions = opts();
	return node;
}

/** setImmediate macrotask + microtask ticks — drains the wait:false chain. */
function flushAsync(): Promise<void> {
	return new Promise((r) => setImmediate(() => setImmediate(r)));
}

describe("dsl sub-workflows — live E2E (#603)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		RunTracker.resetInstance();
	});
	afterEach(() => {
		WorkflowRegistry.resetInstance();
		RunTracker.resetInstance();
	});

	// === (1) in-process wait:true (default) — parent blocks, child response
	// lands on state[id], lineage recorded. Driven through the WHOLE parent
	// pipeline (Configuration.init → Runner.run), not a direct node call.
	it("in-process wait:true — parent blocks; child response lands on state[id] with lineage", async () => {
		const child = `child.echo-${SUFFIX}`;
		const parent = `parent.sync-${SUFFIX}`;
		WorkflowRegistry.getInstance().register({ name: child, source: `/${child}.ts`, workflow: childDef(child) });

		const parentWf = {
			name: parent,
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			// `wait` defaults to true; inputs carry the parent body into the child.
			steps: [{ id: "call", subworkflow: child, inputs: { from: "js/ctx.req.body" } }],
		};
		const cfg = new Configuration();
		await cfg.init(parent, opts(), parentWf);
		const runner = new Runner(cfg.steps);

		const ctx = makeParentCtx(parent, { hello: "world" }, cfg.nodes as unknown as Context["config"]);
		const parentRunId = (ctx as Record<string, unknown>)._traceRunId as string;

		await runner.run(ctx);

		// Child ran + its ctx.response is on the parent step's state slot.
		const state = (ctx as unknown as { state: Record<string, unknown> }).state;
		const out = state.call as { echoed: { from: { hello: string } }; ran: string };
		expect(out.ran).toBe("child");
		// Parent's resolved inputs became the child's request.body verbatim.
		expect(out.echoed).toEqual({ from: { hello: "world" } });

		// Lineage: exactly one sub-run, completed, pointing back at the parent.
		const subruns = RunTracker.getInstance().getRunsByParent(parentRunId);
		expect(subruns).toHaveLength(1);
		expect(subruns[0].workflowName).toBe(child);
		expect(subruns[0].parentRunId).toBe(parentRunId);
		expect(subruns[0].status).toBe("completed");
	});

	// === (2) wait:false — returns dispatch metadata immediately; child runs
	// async and transitions to completed independently of the parent.
	it("wait:false — returns {runId, workflowName, scheduledAt}; child runs async → completed", async () => {
		const child = `child.async-${SUFFIX}`;
		const parent = `parent.async-${SUFFIX}`;
		WorkflowRegistry.getInstance().register({ name: child, source: `/${child}.ts`, workflow: childDef(child) });

		const node = makeNode({ stepName: "fire", name: child, wait: false });
		const ctx = makeParentCtx(parent, {}, { fire: { inputs: { from: "p" } } } as unknown as Context["config"]);
		(ctx as Record<string, unknown>)._traceNodeId = "pnode-async";

		const result = await node.run(ctx);

		// Immediate dispatch metadata — NOT the child's response.
		expect(result.success).toBe(true);
		expect(result.error).toBeNull();
		const meta = result.data as { runId: string; workflowName: string; scheduledAt: number };
		expect(meta.workflowName).toBe(child);
		expect(typeof meta.runId).toBe("string");
		expect(meta.runId.length).toBeGreaterThan(0);
		expect(typeof meta.scheduledAt).toBe("number");
		expect(meta.scheduledAt).toBeLessThanOrEqual(Date.now());

		const tracker = RunTracker.getInstance();
		// Child is still `running` BEFORE the setImmediate macrotask fires.
		expect(tracker.getStore().getRun(meta.runId)?.status).toBe("running");

		await flushAsync();

		// Child completed independently; lineage attached.
		const childRun = tracker.getStore().getRun(meta.runId);
		expect(childRun?.status).toBe("completed");
		expect(childRun?.parentRunId).toBe((ctx as Record<string, unknown>)._traceRunId);
		expect(childRun?.parentNodeRunId).toBe("pnode-async");

		// Dispatch metadata also landed on parent state[id].
		const state = (ctx as unknown as { state: Record<string, unknown> }).state;
		expect((state.fire as { workflowName: string }).workflowName).toBe(child);
	});

	// === (3) http-self — child dispatched as a REAL HTTP request to a live
	// server; assert the child ran on the far side + lineage crossed the wire.
	describe("http-self dispatch (real socket)", () => {
		let server: http.Server;
		const savedBase = process.env.BLOK_SELF_BASE_URL;
		const child = `child.http-${SUFFIX}`;
		// Far-side observability: what the receiving server actually saw.
		const seen: { count: number; body?: unknown; headers?: http.IncomingHttpHeaders } = { count: 0 };

		beforeEach(async () => {
			seen.count = 0;
			seen.body = undefined;
			seen.headers = undefined;
			WorkflowRegistry.getInstance().register({
				name: child,
				source: `/${child}.ts`,
				workflow: childDef(child, true),
			});

			// Real HTTP server: on each request it materializes + runs the child
			// workflow through Configuration → Runner and returns its response.
			// This is the "far side" of the http-self hop — a genuine second
			// execution reached only over the socket.
			server = http.createServer((req, res) => {
				const chunks: Buffer[] = [];
				req.on("data", (c) => chunks.push(c as Buffer));
				req.on("end", () => {
					void (async () => {
						seen.count++;
						seen.headers = req.headers;
						const raw = Buffer.concat(chunks).toString();
						const body = raw.length > 0 ? JSON.parse(raw) : {};
						seen.body = body;
						const cfg = new Configuration();
						await cfg.init(child, opts(), childDef(child, true));
						const runner = new Runner(cfg.steps);
						const cctx = makeParentCtx(child, body, cfg.nodes as unknown as Context["config"]);
						await runner.run(cctx);
						res.writeHead(200, { "content-type": "application/json" });
						res.end(JSON.stringify(cctx.response));
					})();
				});
			});
			await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
			const addr = server.address() as AddressInfo;
			process.env.BLOK_SELF_BASE_URL = `http://127.0.0.1:${addr.port}`;
		});

		afterEach(async () => {
			await new Promise<void>((r) => server.close(() => r()));
			if (savedBase === undefined) {
				Reflect.deleteProperty(process.env, "BLOK_SELF_BASE_URL");
			} else {
				process.env.BLOK_SELF_BASE_URL = savedBase;
			}
		});

		it("wait:true — real fetch → real socket → child runs far side; response + lineage cross the wire", async () => {
			const node = makeNode({ stepName: "dispatch", name: child, dispatch: "http-self" });
			const ctx = makeParentCtx("parent-http", {}, {
				dispatch: { inputs: { payload: "over-the-wire" } },
			} as unknown as Context["config"]);
			const parentRunId = (ctx as Record<string, unknown>)._traceRunId as string;
			(ctx as Record<string, unknown>)._traceNodeId = "pnode-http";

			const result = await node.run(ctx);

			// The child executed on the FAR side of the socket exactly once.
			expect(seen.count).toBe(1);
			// The parent step's resolved inputs became the request body.
			expect(seen.body).toEqual({ payload: "over-the-wire" });
			// Lineage headers crossed the HTTP boundary.
			expect(seen.headers?.["x-blok-parent-run-id"]).toBe(parentRunId);
			expect(seen.headers?.["x-blok-parent-node-run-id"]).toBe("pnode-http");
			expect(seen.headers?.["x-blok-subworkflow-depth"]).toBe("1");
			// The child's response came back over the wire as the step output.
			const data = result.data as { echoed: { payload: string }; ran: string };
			expect(data.ran).toBe("child");
			expect(data.echoed).toEqual({ payload: "over-the-wire" });
		});

		it("throws when the child has no HTTP trigger (http-self requires trigger.http.path)", async () => {
			const noHttp = `child.nohttp-${SUFFIX}`;
			WorkflowRegistry.getInstance().register({
				name: noHttp,
				source: `/${noHttp}.ts`,
				workflow: childDef(noHttp, false), // manual trigger — no http.path
			});
			const node = makeNode({ stepName: "dispatch", name: noHttp, dispatch: "http-self" });
			const ctx = makeParentCtx("parent-http2", {}, { dispatch: { inputs: {} } } as unknown as Context["config"]);

			await expect(node.run(ctx)).rejects.toThrow(/requires the child workflow .* to have an HTTP trigger/);
			// Never reached the socket.
			expect(seen.count).toBe(0);
		});
	});

	// === (4) polymorphic name — `$.req.body.kind` resolves at dispatch time.
	it("polymorphic name — $.req.body.kind resolves dynamically to the right child", async () => {
		const payment = `handler.payment-${SUFFIX}`;
		const shipping = `handler.shipping-${SUFFIX}`;
		WorkflowRegistry.getInstance().register({ name: payment, source: `/${payment}.ts`, workflow: childDef(payment) });
		WorkflowRegistry.getInstance().register({
			name: shipping,
			source: `/${shipping}.ts`,
			workflow: childDef(shipping),
		});

		// Same node shape, different body → different child. Prove BOTH branches
		// so the dispatch is genuinely data-driven, not hard-coded.
		for (const kind of [payment, shipping]) {
			const node = makeNode({ stepName: "route", name: "$.req.body.kind" });
			const ctx = makeParentCtx(`router-${kind}`, { kind }, {
				route: { inputs: { tag: kind } },
			} as unknown as Context["config"]);
			const parentRunId = (ctx as Record<string, unknown>)._traceRunId as string;

			const result = await node.run(ctx);

			expect(result.success).toBe(true);
			expect((result.data as { echoed: { tag: string } }).echoed).toEqual({ tag: kind });
			// The sub-run recorded under this parent is the dynamically-chosen child.
			const subruns = RunTracker.getInstance().getRunsByParent(parentRunId);
			expect(subruns).toHaveLength(1);
			expect(subruns[0].workflowName).toBe(kind);
		}
	});

	// === (5) allowList — a resolved name outside the list is rejected at run
	// time with a structured error, before any materialization / dispatch.
	it("allowList — resolved name NOT in the allowList is rejected with a structured error", async () => {
		const admin = `internal.admin-${SUFFIX}`;
		const allowed = `handler.payment-${SUFFIX}`;
		// The blocked target IS registered — proving the rejection is the
		// allowList, not a missing-workflow error.
		WorkflowRegistry.getInstance().register({ name: admin, source: `/${admin}.ts`, workflow: childDef(admin) });
		WorkflowRegistry.getInstance().register({ name: allowed, source: `/${allowed}.ts`, workflow: childDef(allowed) });

		const node = makeNode({
			stepName: "route",
			name: "$.req.body.kind",
			allowList: [allowed], // admin is deliberately NOT listed
		});
		const ctx = makeParentCtx("router-guard", { kind: admin }, {
			route: { inputs: {} },
		} as unknown as Context["config"]);
		const parentRunId = (ctx as Record<string, unknown>)._traceRunId as string;

		await expect(node.run(ctx)).rejects.toThrow(
			new RegExp(`Sub-workflow dispatch blocked: resolved name "${admin}" is not in the step's \`allowList\``),
		);

		// The blocked dispatch created NO child run — rejection happened before
		// materialization.
		expect(RunTracker.getInstance().getRunsByParent(parentRunId)).toHaveLength(0);

		// Sanity: the SAME guarded shape dispatches fine when the body asks for
		// an allow-listed child — proving the guard admits legitimate names.
		const okNode = makeNode({ stepName: "route2", name: "$.req.body.kind", allowList: [allowed] });
		const okCtx = makeParentCtx("router-ok", { kind: allowed }, {
			route2: { inputs: { tag: "ok" } },
		} as unknown as Context["config"]);
		const okResult = await okNode.run(okCtx);
		expect(okResult.success).toBe(true);
		expect((okResult.data as { echoed: { tag: string } }).echoed).toEqual({ tag: "ok" });
	});
});
