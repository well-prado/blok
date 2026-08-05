import type { Context, NodeBase } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebugController } from "../../debug/DebugController";
import { RunTracker } from "../../tracing/RunTracker";

describe("DebugController", () => {
	let tracker: RunTracker;

	beforeEach(() => {
		RunTracker.resetInstance();
		DebugController.resetInstance();
		tracker = RunTracker.getInstance();
	});

	afterEach(() => {
		vi.useRealTimers();
		DebugController.resetInstance();
		RunTracker.resetInstance();
		vi.unstubAllEnvs();
	});

	function startDebugRun() {
		const run = tracker.startRun({
			workflowName: "debug-me",
			workflowPath: "debug-me.ts",
			triggerType: "studio",
			triggerSummary: "studio",
			nodeCount: 2,
		});
		const abortController = new AbortController();
		tracker.registerAbortController(run.id, abortController);
		const ctx = {
			_traceRunId: run.id,
			signal: abortController.signal,
			config: { first: { inputs: { url: "https://example.com" } } },
		} as unknown as Context;
		return { run, ctx, abortController };
	}

	it("pauses before the first step, then steps to the next one", async () => {
		const { run, ctx } = startDebugRun();
		const session = DebugController.getInstance().attach([]);

		const firstStep = {
			name: "first",
			blueprintMapper: () => ({ url: "https://resolved.example.com" }),
		} as unknown as NodeBase;
		const firstPause = session.beforeStep(ctx, firstStep, 0, 2, false);
		await vi.waitFor(() => expect(tracker.getRun(run.id)?.status).toBe("paused"));
		expect(DebugController.getInstance().control(run.id, "step")).toMatchObject({ ok: true, status: "running" });
		await firstPause;

		const secondPause = session.beforeStep(ctx, { name: "second" } as unknown as NodeBase, 1, 2, false);
		await vi.waitFor(() => expect(tracker.getRun(run.id)?.status).toBe("paused"));
		expect(DebugController.getInstance().control(run.id, "continue")).toMatchObject({ ok: true });
		await secondPause;

		expect(tracker.getEvents(run.id).map((event) => event.type)).toEqual([
			"RUN_STARTED",
			"RUN_PAUSED",
			"RUN_RESUMED",
			"RUN_PAUSED",
			"RUN_RESUMED",
		]);
		expect(tracker.getEvents(run.id).find((event) => event.type === "RUN_PAUSED")?.payload).toMatchObject({
			stepId: "first",
			inputs: { url: "https://resolved.example.com" },
		});
		session.dispose();
	});

	it("runs to a breakpoint without an entry pause when stopOnEntry is false (Run to here)", async () => {
		const { run, ctx } = startDebugRun();
		const session = DebugController.getInstance().attach(["third"], { stopOnEntry: false });

		// Earlier steps flow through without pausing.
		await session.beforeStep(ctx, { name: "first" } as unknown as NodeBase, 0, 3, false);
		await session.beforeStep(ctx, { name: "second" } as unknown as NodeBase, 1, 3, false);
		expect(tracker.getRun(run.id)?.status).toBe("running");
		expect(tracker.getEvents(run.id).some((event) => event.type === "RUN_PAUSED")).toBe(false);

		// The breakpoint step pauses.
		const pause = session.beforeStep(
			ctx,
			{ name: "third", blueprintMapper: () => ({ ok: true }) } as unknown as NodeBase,
			2,
			3,
			false,
		);
		await vi.waitFor(() => expect(tracker.getRun(run.id)?.status).toBe("paused"));
		expect(tracker.getEvents(run.id).find((event) => event.type === "RUN_PAUSED")?.payload).toMatchObject({
			stepId: "third",
		});
		expect(DebugController.getInstance().control(run.id, "continue")).toMatchObject({ ok: true });
		await pause;
		session.dispose();
	});

	it("stops a paused run through the existing abort controller", async () => {
		const { run, ctx, abortController } = startDebugRun();
		const session = DebugController.getInstance().attach([]);
		const pause = session.beforeStep(ctx, { name: "first" } as unknown as NodeBase, 0, 1, false);
		await vi.waitFor(() => expect(tracker.getRun(run.id)?.status).toBe("paused"));

		expect(DebugController.getInstance().control(run.id, "stop")).toMatchObject({ ok: true, status: "cancelled" });
		await pause;
		expect(abortController.signal.aborted).toBe(true);
		expect(tracker.getRun(run.id)?.status).toBe("cancelled");
		session.dispose();
	});

	it("cancels a pause when its TTL expires", async () => {
		vi.useFakeTimers();
		vi.stubEnv("BLOK_DEBUG_PAUSE_TTL_MS", "10");
		const { run, ctx } = startDebugRun();
		const session = DebugController.getInstance().attach([]);
		const pause = session.beforeStep(ctx, { name: "first" } as unknown as NodeBase, 0, 1, false);

		expect(tracker.getRun(run.id)?.status).toBe("paused");
		await vi.advanceTimersByTimeAsync(10);
		await pause;
		expect(tracker.getRun(run.id)?.status).toBe("cancelled");
		session.dispose();
	});
});
