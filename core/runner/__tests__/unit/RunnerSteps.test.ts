import type { Context } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";

/**
 * Minimal RunnerNode that captures `ctx._stepInfo` at execute time so we can
 * verify what `RunnerSteps` populates into the context for runtime adapters.
 */
class CaptureStepInfoNode extends RunnerNode {
	public captured: unknown = null;

	async run(ctx: Context) {
		this.captured = (ctx as Record<string, unknown>)._stepInfo;
		return { success: true, data: { ok: true }, error: null };
	}
}

/** Flow-style RunnerNode that returns nested steps for the runner to expand. */
class FlowNode extends RunnerNode {
	private readonly nested: RunnerNode[];

	constructor(name: string, nested: RunnerNode[]) {
		super();
		this.name = name;
		this.flow = true;
		this.nested = nested;
	}

	async run() {
		return { success: true, data: this.nested, error: null };
	}

	async processFlow() {
		return { success: true, data: this.nested as unknown, error: null };
	}
}

function makeCtx(overrides: Partial<Context> = {}): Context {
	return {
		id: "test-run",
		workflow_name: "test-wf",
		workflow_path: "/test",
		request: { body: {}, headers: {}, params: {}, query: {} } as unknown as Context["request"],
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: {} as unknown as Context["config"],
		vars: {},
		env: {} as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
		...overrides,
	};
}

function makeNode(name: string): CaptureStepInfoNode {
	const n = new CaptureStepInfoNode();
	n.name = name;
	n.node = name;
	n.type = "module";
	n.active = true;
	return n;
}

describe("RunnerSteps populates ctx._stepInfo", () => {
	it("sets ctx._stepInfo for every executed step in a flat workflow", async () => {
		const a = makeNode("step-a");
		const b = makeNode("step-b");
		const c = makeNode("step-c");
		const runner = new Runner([a, b, c]);

		await runner.run(makeCtx());

		expect(a.captured).toEqual({ name: "step-a", index: 0, total: 3, depth: 0 });
		expect(b.captured).toEqual({ name: "step-b", index: 1, total: 3, depth: 0 });
		expect(c.captured).toEqual({ name: "step-c", index: 2, total: 3, depth: 0 });
	});

	it("sets depth=1 for steps executed inside a flow node", async () => {
		const branch = makeNode("branch-step");
		const flow = new FlowNode("decide", [branch]);
		const runner = new Runner([flow]);

		await runner.run(makeCtx());

		expect(branch.captured).toEqual({
			name: "branch-step",
			// At depth=1 the runner concatenates flow_steps with the remaining tail
			// (none here), so total=1 and index=0.
			index: 0,
			total: 1,
			depth: 1,
		});
	});

	it("sets depth=1 and correct totals for nested+tail steps after a flow node", async () => {
		const branchA = makeNode("branch-a");
		const branchB = makeNode("branch-b");
		const flow = new FlowNode("decide", [branchA, branchB]);
		const tail = makeNode("tail");
		const runner = new Runner([flow, tail]);

		await runner.run(makeCtx());

		// At depth=1, the merged branch has [branchA, branchB, tail] → total=3.
		expect(branchA.captured).toEqual({ name: "branch-a", index: 0, total: 3, depth: 1 });
		expect(branchB.captured).toEqual({ name: "branch-b", index: 1, total: 3, depth: 1 });
		expect(tail.captured).toEqual({ name: "tail", index: 2, total: 3, depth: 1 });
	});

	it("does not crash when the workflow contains zero steps", async () => {
		const runner = new Runner([]);
		await expect(runner.run(makeCtx())).resolves.toBeDefined();
	});

	it("skips inactive steps without populating their _stepInfo", async () => {
		const active = makeNode("active");
		const inactive = makeNode("inactive");
		inactive.active = false;
		const runner = new Runner([inactive, active]);

		await runner.run(makeCtx());

		// The inactive node never ran, so its captured value remains the initial null.
		expect(inactive.captured).toBeNull();
		// The active node ran with index=1 (the inactive step still occupies index 0).
		expect(active.captured).toEqual({ name: "active", index: 1, total: 2, depth: 0 });
	});
});

describe("RunnerSteps step-prefix log includes transport tag for runtime nodes", () => {
	class TransportNode extends CaptureStepInfoNode {
		public readonly transport: string;
		constructor(name: string, transport: string) {
			super();
			this.name = name;
			this.node = name;
			this.type = `runtime.${name}`;
			this.active = true;
			this.transport = transport;
		}
	}

	it("includes the adapter transport in the step prefix when present", async () => {
		const messages: string[] = [];
		const ctx = makeCtx({
			logger: {
				log: (msg: string) => messages.push(msg),
				error: () => {},
			} as unknown as Context["logger"],
		});
		const node = new TransportNode("python3", "grpc");
		const runner = new Runner([node]);

		await runner.run(ctx);

		const startedLine = messages.find((m) => m.includes("→ started"));
		expect(startedLine).toBeDefined();
		expect(startedLine).toContain("(runtime.python3, grpc)");
	});

	it("omits the transport tag when the step doesn't expose one (module/local nodes)", async () => {
		const messages: string[] = [];
		const ctx = makeCtx({
			logger: {
				log: (msg: string) => messages.push(msg),
				error: () => {},
			} as unknown as Context["logger"],
		});
		// Plain CaptureStepInfoNode has no `transport` field — represents a
		// module/local TS node going through NodeJsRuntimeAdapter without
		// the wrapper.
		const node = makeNode("module-step");
		const runner = new Runner([node]);

		await runner.run(ctx);

		const startedLine = messages.find((m) => m.includes("→ started"));
		expect(startedLine).toBeDefined();
		expect(startedLine).toContain("(module)");
		expect(startedLine).not.toMatch(/,\s*(grpc|http|module)\)/);
	});
});
