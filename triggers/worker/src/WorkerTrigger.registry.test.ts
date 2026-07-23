/**
 * WorkerTrigger — registry population + global middleware env seeding
 *
 * Covers:
 *   - F6 (worker part): `registerWorkflowsFromNodeMap` feeds the
 *     WorkflowRegistry from the worker's own nodeMap so worker-only
 *     deployments can resolve trigger-level / process-global middleware and
 *     `subworkflow:` steps. Workflows flagged `middleware: true` register with
 *     `isMiddleware`.
 *   - F14 (worker part): `seedGlobalMiddlewareFromEnv` seeds
 *     `BLOK_GLOBAL_MIDDLEWARE` into the registry (HTTP did this before; a
 *     pure worker process dropped it). Programmatic `setGlobalMiddleware`
 *     takes precedence (idempotency guard).
 */

import { type WorkflowV2Builder, workflow } from "@blokjs/helper";
import { type BlokService, WorkflowRegistry, defineNode } from "@blokjs/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkerTrigger } from "./WorkerTrigger";

const echoNode = defineNode({
	name: "echo",
	description: "echoes",
	input: z.object({}).passthrough(),
	output: z.object({}).passthrough(),
	async execute(_ctx, input) {
		return input;
	},
});

function workerWf(name: string): WorkflowV2Builder {
	return workflow({
		name,
		version: "1.0.0",
		trigger: { worker: { queue: "q" } },
		steps: [{ id: "process", use: "echo", type: "module", inputs: {} }],
	}) as unknown as WorkflowV2Builder;
}

/**
 * A middleware-flagged workflow. The v2 `workflow()` helper drops the
 * `middleware` field, so we build the envelope shape the worker registers
 * from (`{ _config }`) directly, mirroring a normalized JSON middleware
 * workflow.
 */
function middlewareWf(name: string): WorkflowV2Builder {
	const config = {
		name,
		version: "1.0.0",
		middleware: true,
		steps: [{ id: "gate", use: "echo", type: "module", inputs: {} }],
	};
	return {
		_blokV2: true,
		_config: config,
		toJson: () => JSON.stringify(config),
	} as unknown as WorkflowV2Builder;
}

class TestWorkerTrigger extends WorkerTrigger {
	protected nodes: Record<string, BlokService<unknown>> = { echo: echoNode as unknown as BlokService<unknown> };
	protected workflows: Record<string, WorkflowV2Builder>;

	constructor(workflows: Record<string, WorkflowV2Builder>) {
		super();
		this.workflows = workflows;
		this.loadNodes();
		this.loadWorkflows();
	}

	public seedRegistry() {
		this.registerWorkflowsFromNodeMap();
	}
	public seedGlobalMw() {
		this.seedGlobalMiddlewareFromEnv();
	}
}

describe("WorkerTrigger.registerWorkflowsFromNodeMap (F6)", () => {
	beforeEach(() => WorkflowRegistry.resetInstance());
	afterEach(() => WorkflowRegistry.resetInstance());

	it("registers worker workflows under their name for sub-workflow lookup", () => {
		const trigger = new TestWorkerTrigger({ jobs: workerWf("send-email") });
		trigger.seedRegistry();

		const registry = WorkflowRegistry.getInstance();
		const entry = registry.get("send-email");
		expect(entry).toBeDefined();
		expect(entry?.isMiddleware ?? false).toBe(false);
	});

	it("registers middleware:true workflows with isMiddleware", () => {
		const trigger = new TestWorkerTrigger({ auth: middlewareWf("auth-gate") });
		trigger.seedRegistry();

		const registry = WorkflowRegistry.getInstance();
		// getMiddleware only returns entries registered with isMiddleware:true.
		expect(registry.getMiddleware("auth-gate")).toBeDefined();
	});

	it("is idempotent — re-registering the same (name, source) does not throw", () => {
		const trigger = new TestWorkerTrigger({ jobs: workerWf("send-email") });
		trigger.seedRegistry();
		expect(() => trigger.seedRegistry()).not.toThrow();
		expect(WorkflowRegistry.getInstance().get("send-email")).toBeDefined();
	});
});

describe("WorkerTrigger.seedGlobalMiddlewareFromEnv (F14)", () => {
	const prev = process.env.BLOK_GLOBAL_MIDDLEWARE;

	beforeEach(() => WorkflowRegistry.resetInstance());
	afterEach(() => {
		WorkflowRegistry.resetInstance();
		// biome-ignore lint/performance/noDelete: restore literal absence.
		if (prev === undefined) delete process.env.BLOK_GLOBAL_MIDDLEWARE;
		else process.env.BLOK_GLOBAL_MIDDLEWARE = prev;
	});

	it("seeds BLOK_GLOBAL_MIDDLEWARE into the registry's global chain", () => {
		process.env.BLOK_GLOBAL_MIDDLEWARE = "request-id, audit-log";
		const trigger = new TestWorkerTrigger({ jobs: workerWf("wf-x") });
		trigger.seedGlobalMw();

		expect(WorkflowRegistry.getInstance().getGlobalMiddleware()).toEqual(["request-id", "audit-log"]);
	});

	it("does NOT override a programmatic setGlobalMiddleware (precedence)", () => {
		WorkflowRegistry.getInstance().setGlobalMiddleware(["explicit"]);
		process.env.BLOK_GLOBAL_MIDDLEWARE = "from-env";

		const trigger = new TestWorkerTrigger({ jobs: workerWf("wf-x") });
		trigger.seedGlobalMw();

		expect(WorkflowRegistry.getInstance().getGlobalMiddleware()).toEqual(["explicit"]);
	});

	it("is a no-op when BLOK_GLOBAL_MIDDLEWARE is unset", () => {
		// biome-ignore lint/performance/noDelete: env-var reset must reach `undefined`, not the string "undefined".
		delete process.env.BLOK_GLOBAL_MIDDLEWARE;
		const trigger = new TestWorkerTrigger({ jobs: workerWf("wf-x") });
		trigger.seedGlobalMw();

		expect(WorkflowRegistry.getInstance().getGlobalMiddleware()).toEqual([]);
	});
});

describe("WorkerTrigger — ADR 0015 input-gate scope", () => {
	it("does NOT validate declared workflow input (job.data is not the schema's subject)", () => {
		// The invoking-trigger scope fix: a `{ http, worker }` workflow fired via
		// worker must not run the http-side `input` gate against job.data.
		// `validatesDeclaredInput` is protected and stateless — assert on the prototype.
		const flag = (WorkerTrigger.prototype as unknown as { validatesDeclaredInput(): boolean }).validatesDeclaredInput();
		expect(flag).toBe(false);
	});
});
