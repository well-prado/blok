import type { Context, NodeBase } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { RunCancelledError } from "../../src/RunCancelledError";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";

class RecordingNode extends RunnerNode {
	constructor(
		name: string,
		private readonly executed: string[],
	) {
		super();
		this.name = name;
		this.node = name;
		this.type = "module";
		this.active = true;
	}

	async run() {
		this.executed.push(this.name);
		return { success: true, data: { ok: true }, error: null };
	}
}

class DebugGate {
	private readonly pending = new Map<string, () => void>();
	private readonly observers = new Map<string, () => void>();
	readonly pauses: string[] = [];

	constructor(
		private readonly mode: "breakpoint" | "step",
		private readonly breakpoints = new Set<string>(),
	) {}

	async beforeStep(ctx: Context, step: NodeBase): Promise<void> {
		if (this.mode === "breakpoint" && !this.breakpoints.has(step.name)) return;
		this.pauses.push(step.name);

		await new Promise<void>((resolve) => {
			const signal = ctx.signal;
			const release = () => {
				signal?.removeEventListener("abort", release);
				this.pending.delete(step.name);
				resolve();
			};
			this.pending.set(step.name, release);
			signal?.addEventListener("abort", release, { once: true });
			this.observers.get(step.name)?.();
			this.observers.delete(step.name);
		});
	}

	waitForPause(stepName: string): Promise<void> {
		if (this.pending.has(stepName)) return Promise.resolve();
		return new Promise((resolve) => this.observers.set(stepName, resolve));
	}

	resume(stepName: string): void {
		const release = this.pending.get(stepName);
		if (!release) throw new Error(`Step ${stepName} is not paused.`);
		release();
	}

	get pendingCount(): number {
		return this.pending.size;
	}
}

class DebugRunner extends Runner {
	constructor(
		steps: NodeBase[],
		private readonly gate: DebugGate,
	) {
		super(steps);
	}

	protected override beforeStep(ctx: Context, step: NodeBase): Promise<void> {
		return this.gate.beforeStep(ctx, step);
	}
}

function makeContext(controller = new AbortController()): Context {
	return {
		id: "debug-run",
		workflow_name: "browser-login",
		workflow_path: "/browser-login",
		request: { body: {}, headers: {}, params: {}, query: {} } as unknown as Context["request"],
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: {} as Context["config"],
		vars: {},
		env: {} as Context["env"],
		eventLogger: null,
		signal: controller.signal,
		_PRIVATE_: { abortController: controller },
	};
}

function nodes(names: string[], executed: string[]): NodeBase[] {
	return names.map((name) => new RecordingNode(name, executed));
}

describe("RunnerSteps debug gate spike", () => {
	it("pauses before a browser click, remains alive, resumes, and completes", async () => {
		const executed: string[] = [];
		const gate = new DebugGate("breakpoint", new Set(["browser-click"]));
		const runner = new DebugRunner(nodes(["browser-goto", "browser-click", "assert-url"], executed), gate);
		let finished = false;
		const run = runner.run(makeContext()).then(() => {
			finished = true;
		});

		await gate.waitForPause("browser-click");
		expect(executed).toEqual(["browser-goto"]);
		expect(finished).toBe(false);

		gate.resume("browser-click");
		await run;

		expect(executed).toEqual(["browser-goto", "browser-click", "assert-url"]);
		expect(gate.pendingCount).toBe(0);
	});

	it("step mode releases exactly one executable step at a time", async () => {
		const executed: string[] = [];
		const gate = new DebugGate("step");
		const runner = new DebugRunner(nodes(["first", "second"], executed), gate);
		const run = runner.run(makeContext());

		await gate.waitForPause("first");
		expect(executed).toEqual([]);
		gate.resume("first");

		await gate.waitForPause("second");
		expect(executed).toEqual(["first"]);
		gate.resume("second");

		await run;
		expect(executed).toEqual(["first", "second"]);
		expect(gate.pauses).toEqual(["first", "second"]);
	});

	it("cancellation releases a paused gate and leaves no pending resource", async () => {
		const executed: string[] = [];
		const controller = new AbortController();
		const gate = new DebugGate("breakpoint", new Set(["browser-click"]));
		const runner = new DebugRunner(nodes(["browser-click"], executed), gate);
		const run = runner.run(makeContext(controller));

		await gate.waitForPause("browser-click");
		controller.abort();

		await expect(run).rejects.toBeInstanceOf(RunCancelledError);
		expect(executed).toEqual([]);
		expect(gate.pendingCount).toBe(0);
	});
});
