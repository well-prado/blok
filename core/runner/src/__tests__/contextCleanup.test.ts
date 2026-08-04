import { describe, expect, it, vi } from "vitest";
import { RunCancelledError } from "../RunCancelledError";
import type Runner from "../Runner";
import TriggerBase from "../TriggerBase";
import { registerContextCleanup, runContextCleanups } from "../contextCleanup";
import { DeferredDispatchSignal } from "../scheduling/DeferredDispatchSignal";
import { StepTimeoutError } from "../timeouts/StepTimeoutError";

class CleanupTrigger extends TriggerBase {
	constructor(private readonly failure?: Error) {
		super();
	}

	async listen(): Promise<number> {
		return 0;
	}

	override getRunner(): Runner {
		return {
			getStepCount: () => 0,
			run: async (ctx) => {
				if (this.failure) throw this.failure;
				return ctx;
			},
		} as Runner;
	}
}

describe("context cleanup", () => {
	it.each([
		["success", undefined],
		["node failure", new Error("node failed")],
		["assertion failure", Object.assign(new Error("assertion failed"), { name: "AssertionError" })],
		["cancellation", new RunCancelledError("run-1")],
		["timeout", new StepTimeoutError("slow-step", 10)],
	])("runs after %s", async (_name, failure) => {
		const trigger = new CleanupTrigger(failure);
		const ctx = trigger.createContext();
		const cleanup = vi.fn();
		registerContextCleanup(ctx, cleanup);

		if (failure) await expect(trigger.run(ctx)).rejects.toBe(failure);
		else await expect(trigger.run(ctx)).resolves.toBeDefined();

		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("runs remaining cleanups once without masking the workflow result", async () => {
		const original = new Error("workflow failed");
		const trigger = new CleanupTrigger(original);
		const ctx = trigger.createContext();
		const remaining = vi.fn();
		registerContextCleanup(ctx, () => {
			throw new Error("cleanup failed");
		});
		registerContextCleanup(ctx, remaining);

		await expect(trigger.run(ctx)).rejects.toBe(original);
		expect(remaining).toHaveBeenCalledOnce();
		await runContextCleanups(ctx);
		expect(remaining).toHaveBeenCalledOnce();
	});

	it("keeps resources alive while a run is deferred", async () => {
		const deferred = new DeferredDispatchSignal({
			runId: "run-1",
			workflowName: "deferred-browser",
			status: "delayed",
			scheduledAt: Date.now() + 1_000,
			debounced: false,
			pingCount: 1,
		});
		const trigger = new CleanupTrigger(deferred);
		const ctx = trigger.createContext();
		const cleanup = vi.fn();
		registerContextCleanup(ctx, cleanup);

		await expect(trigger.run(ctx)).rejects.toBe(deferred);
		expect(cleanup).not.toHaveBeenCalled();
		await runContextCleanups(ctx);
		expect(cleanup).toHaveBeenCalledOnce();
	});
});
