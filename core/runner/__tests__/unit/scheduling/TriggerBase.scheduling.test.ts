import type { Context } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Runner from "../../../src/Runner";
import TriggerBase from "../../../src/TriggerBase";
import { DebounceCoordinator } from "../../../src/scheduling/DebounceCoordinator";
import { DeferredDispatchSignal } from "../../../src/scheduling/DeferredDispatchSignal";
import { DeferredRunScheduler } from "../../../src/scheduling/DeferredRunScheduler";
import { RunTracker } from "../../../src/tracing/RunTracker";

class TestTrigger extends TriggerBase {
	async listen(): Promise<number> {
		return 0;
	}

	override getRunner(): Runner {
		return new Runner([]);
	}

	setTriggerConfig(cfg: Record<string, unknown>): void {
		this.configuration.trigger = cfg as never;
		this.configuration.name = "scheduled-wf";
	}
}

function makeCtx(body: unknown = { tenantId: "t1" }): Context {
	const ctx = {
		id: "req-1",
		workflow_name: "scheduled-wf",
		workflow_path: "/test.ts",
		request: {
			body,
			headers: {},
			params: {},
			query: {},
			method: "POST",
			path: "/test",
		} as unknown as Context["request"],
		response: {
			data: null,
			contentType: "application/json",
			success: true,
			error: null,
		} as Context["response"],
		error: { message: [] } as Context["error"],
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: {} as unknown as Context["config"],
		vars: {},
		env: {} as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;
	Object.defineProperty(ctx, "req", { get: () => ctx.request, enumerable: true, configurable: true });
	Object.defineProperty(ctx, "prev", { get: () => ctx.response, enumerable: true, configurable: true });
	return ctx;
}

describe("TriggerBase — scheduling gates (Tier 2 #5 + #7)", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
		DebounceCoordinator.resetInstance();
		process.env.BLOK_SCHEDULING_DISABLED = undefined;
	});

	afterEach(() => {
		vi.useRealTimers();
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
		DebounceCoordinator.resetInstance();
		process.env.BLOK_SCHEDULING_DISABLED = undefined;
	});

	it("zero overhead when no scheduling fields are configured", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({ http: { method: "POST", path: "/x" } });
		const result = await t.run(makeCtx());
		expect(result.ctx).toBeDefined();
	});

	// === Delay gate ===

	it("delay throws DeferredDispatchSignal and sets run status to delayed", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({ http: { method: "POST", delay: 60_000 } });

		await expect(t.run(makeCtx())).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const tracker = RunTracker.getInstance();
		const runs = tracker.getStore().getRuns({ status: "delayed" });
		expect(runs.runs.length).toBe(1);
		expect(runs.runs[0].scheduledAt).toBeDefined();
		expect(runs.runs[0].expiresAt).toBeUndefined();
	});

	it("delay + ttl persists expiresAt on the run", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({ http: { method: "POST", delay: 60_000, ttl: 120_000 } });

		await expect(t.run(makeCtx())).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const tracker = RunTracker.getInstance();
		const runs = tracker.getStore().getRuns({ status: "delayed" });
		expect(runs.runs[0].expiresAt).toBeDefined();
	});

	it("DeferredDispatchSignal carries structured info", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({ http: { method: "POST", delay: 1000 } });

		try {
			await t.run(makeCtx());
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(DeferredDispatchSignal);
			const info = (err as DeferredDispatchSignal).info;
			expect(info.workflowName).toBe("scheduled-wf");
			expect(info.status).toBe("delayed");
			expect(info.scheduledAt).toBeGreaterThan(Date.now());
			expect(info.debounced).toBe(false);
			expect(info.pingCount).toBe(1);
			expect(info.runId).toBeTruthy();
		}
	});

	it("delay schedules the timer on DeferredRunScheduler", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({ http: { method: "POST", delay: 60_000 } });

		await expect(t.run(makeCtx())).rejects.toBeInstanceOf(DeferredDispatchSignal);
		expect(DeferredRunScheduler.getInstance().size()).toBe(1);
	});

	it("when delay timer fires past expiresAt, the run is marked expired", async () => {
		vi.useFakeTimers();
		const t = new TestTrigger();
		// delay=1000ms, ttl=500ms (TTL shorter than delay → guaranteed expired by dispatch).
		t.setTriggerConfig({ http: { method: "POST", delay: 1000, ttl: 500 } });

		await expect(t.run(makeCtx())).rejects.toBeInstanceOf(DeferredDispatchSignal);

		// Advance past the delay — timer fires, TTL check trips.
		await vi.advanceTimersByTimeAsync(1100);

		const tracker = RunTracker.getInstance();
		const expired = tracker.getStore().getRuns({ status: "expired" });
		expect(expired.runs.length).toBe(1);
	});

	// === Debounce gate ===

	it("debounce trailing first ping flips status to debounced (transient)", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: {
				method: "POST",
				debounce: { key: "doc-1", mode: "trailing", delay: 500 },
			},
		});

		await expect(t.run(makeCtx())).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const tracker = RunTracker.getInstance();
		const runs = tracker.getStore().getRuns({ status: "debounced" });
		expect(runs.runs.length).toBe(1);
		expect(runs.runs[0].debounceKey).toBe("doc-1");
		expect(runs.runs[0].debounceMode).toBe("trailing");
	});

	it("debounce trailing coalesce: second ping points at the active run", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: {
				method: "POST",
				debounce: { key: "doc-1", mode: "trailing", delay: 500 },
			},
		});

		const first = t.run(makeCtx()).catch((e: unknown) => e as DeferredDispatchSignal);
		const firstSignal = (await first) as DeferredDispatchSignal;
		const activeRunId = firstSignal.info.runId;

		const second = t.run(makeCtx()).catch((e: unknown) => e as DeferredDispatchSignal);
		const secondSignal = (await second) as DeferredDispatchSignal;
		expect(secondSignal.info.intoRunId).toBe(activeRunId);
		expect(secondSignal.info.runId).not.toBe(activeRunId);
		expect(secondSignal.info.pingCount).toBe(2);
	});

	it("debounce leading first ping fires synchronously (no DeferredDispatchSignal)", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: {
				method: "POST",
				debounce: { key: "doc-1", mode: "leading", delay: 500 },
			},
		});

		// Leading + first ping = run synchronously.
		const result = await t.run(makeCtx());
		expect(result.ctx).toBeDefined();
	});

	it("debounce leading second ping coalesces (deferred dispatch signal)", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: {
				method: "POST",
				debounce: { key: "doc-1", mode: "leading", delay: 1000 },
			},
		});

		// First ping fires synchronously — no DeferredDispatchSignal.
		await t.run(makeCtx());

		// Second ping (within 1000ms window) is suppressed.
		await expect(t.run(makeCtx())).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const tracker = RunTracker.getInstance();
		const debounced = tracker.getStore().getRuns({ status: "debounced" });
		expect(debounced.runs.length).toBeGreaterThanOrEqual(1);
	});

	it("debounce key resolution failure falls open (no debouncing)", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: {
				method: "POST",
				debounce: { key: "js/ctx.nonexistent.path.userId", mode: "trailing", delay: 500 },
			},
		});

		// Resolution fails → fail-open → workflow runs immediately.
		const result = await t.run(makeCtx());
		expect(result.ctx).toBeDefined();
	});

	// === Kill-switch ===

	it("BLOK_SCHEDULING_DISABLED=1 short-circuits all gates", async () => {
		process.env.BLOK_SCHEDULING_DISABLED = "1";
		const t = new TestTrigger();
		t.setTriggerConfig({ http: { method: "POST", delay: 60_000 } });

		// Even though delay is configured, the kill-switch makes it inert.
		const result = await t.run(makeCtx());
		expect(result.ctx).toBeDefined();
	});

	// === Reentry ===

	it("delay timer fires deferred dispatch which executes the workflow", async () => {
		vi.useFakeTimers();
		const t = new TestTrigger();
		t.setTriggerConfig({ http: { method: "POST", delay: 1000 } });

		await expect(t.run(makeCtx())).rejects.toBeInstanceOf(DeferredDispatchSignal);

		await vi.advanceTimersByTimeAsync(1100);
		await Promise.resolve();
		await Promise.resolve();

		const tracker = RunTracker.getInstance();
		// After dispatch, the run should have transitioned through running → completed
		// (with an empty Runner the workflow completes immediately).
		const completed = tracker.getStore().getRuns({ status: "completed" });
		expect(completed.runs.length).toBe(1);
	});

	it("debounce trailing fires after delay window closes", async () => {
		vi.useFakeTimers();
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: {
				method: "POST",
				debounce: { key: "doc-1", mode: "trailing", delay: 500 },
			},
		});

		await expect(t.run(makeCtx())).rejects.toBeInstanceOf(DeferredDispatchSignal);

		await vi.advanceTimersByTimeAsync(600);
		await Promise.resolve();
		await Promise.resolve();

		const tracker = RunTracker.getInstance();
		const completed = tracker.getStore().getRuns({ status: "completed" });
		expect(completed.runs.length).toBe(1);
	});
});
