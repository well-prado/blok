/**
 * WorkerTrigger.handleJob — workflow resolution tests
 *
 * Covers:
 *   - Bug 03 (primary): a worker workflow with a DOTTED name/map key
 *     (`publish.site`) resolves from the in-memory nodeMap and runs WITHOUT
 *     throwing `File type not supported`.
 *   - Bug 03 (init contract): `handleJob` invokes `Configuration.init` with
 *     THREE args `(path, nodeMap, preloaded)` where `preloaded` is the
 *     in-memory workflow object. Guards against regressing to the 2-arg
 *     disk-resolver path.
 *   - F11: a multi-trigger workflow (`{ http, worker }`, http declared FIRST)
 *     is still discovered by `getWorkerWorkflows`.
 *   - Non-dotted regression: the common case still resolves.
 */

import { type WorkflowV2Builder, workflow } from "@blokjs/helper";
import { type BlokService, Configuration, type TriggerResponse, defineNode } from "@blokjs/runner";
import { GlobalError, WORKFLOW_INPUT_VALIDATION } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type WorkerJob, WorkerTrigger } from "./WorkerTrigger";

// A trivial node so `Configuration.init` resolves the workflow's single step.
const echoNode = defineNode({
	name: "echo",
	description: "echoes its input",
	input: z.object({}).passthrough(),
	output: z.object({}).passthrough(),
	async execute(_ctx, input) {
		return input;
	},
});

/**
 * Build a worker WorkflowModel-shaped entry. `workflow()` returns the
 * `{ _blokV2, _config, toJson }` envelope the trigger reads via `._config`.
 */
function makeWorkerWorkflow(
	name: string,
	queue: string,
	extraTriggers: Record<string, unknown> = {},
): WorkflowV2Builder {
	return workflow({
		name,
		version: "1.0.0",
		trigger: { ...extraTriggers, worker: { queue } },
		steps: [{ id: "process", use: "echo", type: "module", inputs: { payload: "js/ctx.request.body" } }],
	}) as unknown as WorkflowV2Builder;
}

/**
 * Test subclass: exposes `handleJob` / `getWorkerWorkflows`, wires the
 * in-memory adapter, and (by default) stubs `run` to a no-op success so the
 * test exercises the resolution path without needing a live node execution.
 */
class TestWorkerTrigger extends WorkerTrigger {
	protected nodes: Record<string, BlokService<unknown>> = { echo: echoNode as unknown as BlokService<unknown> };
	protected workflows: Record<string, WorkflowV2Builder>;

	public runCalls = 0;

	constructor(workflows: Record<string, WorkflowV2Builder>) {
		super();
		this.workflows = workflows;
		this.loadNodes();
		this.loadWorkflows();
	}

	// Avoid actually executing the workflow body (no network) — we only care
	// about resolution. Return a minimal TriggerResponse.
	override async run(ctx: import("@blokjs/shared").Context): Promise<TriggerResponse> {
		this.runCalls++;
		return { ctx, metrics: {} as never };
	}

	// expose protected members for the test
	public callHandleJob(job: WorkerJob, model: { path: string; config: never }) {
		const config = (model.config as { trigger: { worker: never } }).trigger.worker;
		return this.handleJob(job, model as never, config);
	}
	public discover() {
		return this.getWorkerWorkflows();
	}
}

function fakeJob(overrides: Partial<WorkerJob> = {}): WorkerJob {
	return {
		id: "job-1",
		data: { hello: "world" },
		headers: {},
		queue: "publish",
		priority: 0,
		attempts: 0,
		maxRetries: 0,
		createdAt: new Date(),
		raw: {},
		complete: vi.fn(async () => {}),
		fail: vi.fn(async () => {}),
		...overrides,
	};
}

describe("WorkerTrigger.handleJob — resolution (Bug 03)", () => {
	let initSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		initSpy = vi.spyOn(Configuration.prototype, "init");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves a DOTTED workflow name from memory without 'File type not supported'", async () => {
		// WORKFLOWS_PATH points at a dir with NO publish.json — success proves
		// resolution came from memory, not disk.
		const prev = process.env.WORKFLOWS_PATH;
		process.env.WORKFLOWS_PATH = "/tmp/__blok_nonexistent_workflows__";

		try {
			const wf = makeWorkerWorkflow("publish.site", "publish");
			const trigger = new TestWorkerTrigger({ "publish.site": wf });
			const model = trigger.discover()[0];
			expect(model).toBeDefined();

			const job = fakeJob();
			await expect(trigger.callHandleJob(job, model as never)).resolves.toBeUndefined();

			// No "File type not supported" anywhere — the job completed.
			expect(job.complete).toHaveBeenCalledTimes(1);
			expect(job.fail).not.toHaveBeenCalled();
			expect(trigger.runCalls).toBe(1);
		} finally {
			process.env.WORKFLOWS_PATH = prev;
		}
	});

	it("invokes Configuration.init with three args (path, nodeMap, preloaded=in-memory object)", async () => {
		const wf = makeWorkerWorkflow("publish.site", "publish");
		const trigger = new TestWorkerTrigger({ "publish.site": wf });
		const model = trigger.discover()[0];

		await trigger.callHandleJob(fakeJob(), model as never);

		expect(initSpy).toHaveBeenCalled();
		const calls = initSpy.mock.calls as unknown as unknown[][];
		const call = calls.find((c) => c[0] === "publish.site");
		expect(call).toBeDefined();
		// 3 args: (path, nodeMap, preloaded)
		expect(call?.length).toBeGreaterThanOrEqual(3);
		// preloaded === the in-memory nodeMap.workflows[path] object
		expect(call?.[2]).toBe(wf);
	});

	it("falls back to workflow.config for preloaded when the map entry is absent", async () => {
		const wf = makeWorkerWorkflow("publish.site", "publish");
		const trigger = new TestWorkerTrigger({ "publish.site": wf });
		const model = trigger.discover()[0];

		// Simulate a missing nodeMap entry for this path.
		(trigger as unknown as { nodeMap: { workflows: Record<string, unknown> } }).nodeMap.workflows = {};

		await trigger.callHandleJob(fakeJob(), model as never);

		const calls = initSpy.mock.calls as unknown as unknown[][];
		const call = calls.find((c) => c[0] === "publish.site");
		expect(call).toBeDefined();
		// preloaded falls back to the pre-extracted config (never undefined).
		expect(call?.[2]).toBeDefined();
		expect(call?.[2]).toBe((model as { config: unknown }).config);
	});

	it("resolves a NON-dotted workflow name (common-case regression)", async () => {
		const wf = makeWorkerWorkflow("publish-site", "publish");
		const trigger = new TestWorkerTrigger({ "publish-site": wf });
		const model = trigger.discover()[0];

		const job = fakeJob();
		await trigger.callHandleJob(job, model as never);

		expect(job.complete).toHaveBeenCalledTimes(1);
		expect(job.fail).not.toHaveBeenCalled();
	});
});

describe("WorkerTrigger.getWorkerWorkflows — multi-trigger discovery (F11)", () => {
	it("discovers the worker trigger even when http is declared FIRST", () => {
		const wf = makeWorkerWorkflow("multi", "jobs", { http: { method: "POST", path: "/multi" } });
		const trigger = new TestWorkerTrigger({ multi: wf });

		const found = trigger.discover();
		expect(found).toHaveLength(1);
		expect(found[0].config.name).toBe("multi");
		expect(found[0].config.trigger?.worker?.queue).toBe("jobs");
	});

	it("ignores workflows with no worker trigger", () => {
		const httpOnly = workflow({
			name: "http-only",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/x" } },
			steps: [{ id: "process", use: "echo", type: "module", inputs: {} }],
		}) as unknown as WorkflowV2Builder;
		const trigger = new TestWorkerTrigger({ "http-only": httpOnly });

		expect(trigger.discover()).toHaveLength(0);
	});
});

/**
 * ADR 0015 — a deterministic input-validation failure must go straight to
 * DLQ/terminal (`job.fail(err, false)`), NOT burn the retry budget. We simulate
 * the gate rejecting by throwing its tagged GlobalError from `run`.
 */
class ValidationFailingWorkerTrigger extends TestWorkerTrigger {
	override async run(): Promise<never> {
		const err = new GlobalError("Input validation failed: query (Required)");
		err.setCode(400);
		err.setName(WORKFLOW_INPUT_VALIDATION);
		throw err;
	}
}

describe("WorkerTrigger.handleJob — validation 400 → DLQ (ADR 0015)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("routes a tagged validation failure to job.fail(err, false) — terminal, no retry", async () => {
		const wf = makeWorkerWorkflow("v.wf", "publish");
		const trigger = new ValidationFailingWorkerTrigger({ "v.wf": wf });
		const model = trigger.discover()[0];

		// A retry budget EXISTS (maxRetries 3) — the fix must NOT use it.
		const job = fakeJob({ maxRetries: 3, attempts: 0 });
		await trigger.callHandleJob(job, model as never);

		expect(job.fail).toHaveBeenCalledTimes(1);
		expect(job.fail).toHaveBeenCalledWith(expect.any(Error), false); // requeue=false → DLQ/terminal
		expect(job.complete).not.toHaveBeenCalled();
	});
});
