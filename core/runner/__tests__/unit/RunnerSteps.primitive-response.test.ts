/**
 * Regression — Bug 4: a step whose output `data` is a PRIMITIVE (or any
 * value that can't take a writable `contentType` property) must not crash
 * the NEXT step.
 *
 * Root cause: `RunnerSteps` runs `ctx.response.contentType = step.contentType`
 * unconditionally at the top of every step iteration. Between steps,
 * `ctx.response` holds the previous step's raw `.data` (`ctx.response =
 * model.data`). When that data is a primitive, the assignment throws — under
 * Bun/JSC the wording is "Attempted to assign to readonly property"; under
 * V8 it's "Cannot create property 'contentType' on string ...". Either way
 * the run dies between steps even though the producing step succeeded.
 *
 * Observed in the wild via a `runtime.python3` node returning a primitive
 * top-level result for certain inputs, but it is engine-level (not transport-
 * specific) and reproduces with a plain in-process node.
 */

import type { Context, ResponseContext } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";

/** Node that returns an arbitrary (possibly primitive) value as its data. */
class ValueNode extends RunnerNode {
	constructor(
		name: string,
		private readonly value: unknown,
	) {
		super();
		this.name = name;
		this.node = name;
		this.type = "module";
		this.active = true;
	}
	async run(): Promise<ResponseContext> {
		return { success: true, data: this.value, error: null };
	}
}

/** Node that records what it saw in `ctx.prev`/`ctx.response` when it ran. */
class SinkNode extends RunnerNode {
	public ran = false;
	public seenResponse: unknown = undefined;
	constructor(name: string) {
		super();
		this.name = name;
		this.node = name;
		this.type = "module";
		this.active = true;
	}
	async run(ctx: Context): Promise<ResponseContext> {
		this.ran = true;
		this.seenResponse = ctx.response;
		return { success: true, data: { ok: true }, error: null };
	}
}

function makeCtx(overrides: Partial<Context> = {}): Context {
	return {
		id: "test-run",
		workflow_name: "primitive-wf",
		workflow_path: "/test",
		request: { body: {}, headers: {}, params: {}, query: {} } as unknown as Context["request"],
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {}, logLevel: () => {} } as unknown as Context["logger"],
		config: {} as unknown as Context["config"],
		state: {},
		vars: {},
		env: {} as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
		...overrides,
	};
}

describe("RunnerSteps — primitive prior-step output (Bug 4)", () => {
	it("does not crash the next step when the prior step returns a string", async () => {
		const producer = new ValueNode("returns-string", "a-bare-string");
		const sink = new SinkNode("next");
		const runner = new Runner([producer, sink]);

		await expect(runner.run(makeCtx())).resolves.toBeDefined();
		expect(sink.ran).toBe(true);
	});

	it("does not crash when the prior step returns a number", async () => {
		const producer = new ValueNode("returns-number", 42);
		const sink = new SinkNode("next");
		const runner = new Runner([producer, sink]);

		await expect(runner.run(makeCtx())).resolves.toBeDefined();
		expect(sink.ran).toBe(true);
	});

	it("does not crash when the prior step returns a frozen object", async () => {
		const producer = new ValueNode("returns-frozen", Object.freeze({ results: [1, 2, 3] }));
		const sink = new SinkNode("next");
		const runner = new Runner([producer, sink]);

		await expect(runner.run(makeCtx())).resolves.toBeDefined();
		expect(sink.ran).toBe(true);
	});
});
