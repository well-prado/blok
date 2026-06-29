import type { Context } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Runner from "../../../src/Runner";
import TriggerBase from "../../../src/TriggerBase";
import { ConcurrencyLimitError } from "../../../src/concurrency/ConcurrencyLimitError";
import { DeferredDispatchSignal } from "../../../src/scheduling/DeferredDispatchSignal";
import { DeferredRunScheduler } from "../../../src/scheduling/DeferredRunScheduler";
import { RunTracker } from "../../../src/tracing/RunTracker";

/**
 * Minimal concrete TriggerBase subclass for unit-testing run() flow.
 * Returns a no-op Runner — the test focuses on the gate, not step execution.
 */
class TestTrigger extends TriggerBase {
	async listen(): Promise<number> {
		return 0;
	}

	override getRunner(): Runner {
		return new Runner([]);
	}

	// Test-only setter to prime the trigger config the gate reads.
	setTriggerConfig(cfg: Record<string, unknown>): void {
		this.configuration.trigger = cfg as never;
		this.configuration.name = "test-wf";
	}
}

function makeCtx(body: unknown = { tenantId: "tenant-x" }): Context {
	const ctx = {
		id: "req-1",
		workflow_name: "test-wf",
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
		logger: { log: () => {}, logLevel: () => {}, error: () => {} } as unknown as Context["logger"],
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

describe("TriggerBase — concurrency gate (Tier 2 #6)", () => {
	const prevMapperMode = process.env.BLOK_MAPPER_MODE;

	beforeEach(() => {
		RunTracker.resetInstance();
		process.env.BLOK_CONCURRENCY_DISABLED = undefined;
	});

	afterEach(() => {
		RunTracker.resetInstance();
		process.env.BLOK_CONCURRENCY_DISABLED = undefined;
		// biome-ignore lint/performance/noDelete: restore literal absence (default mode)
		if (prevMapperMode === undefined) delete process.env.BLOK_MAPPER_MODE;
		else process.env.BLOK_MAPPER_MODE = prevMapperMode;
	});

	it("zero overhead when no concurrencyKey is configured", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({ http: { method: "POST", path: "/x" } });

		const result = await t.run(makeCtx());
		expect(result.ctx).toBeDefined();
	});

	it("acquires a slot, releases it in finally on success", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", path: "/x", concurrencyKey: "tenant-x", concurrencyLimit: 1 },
		});

		await t.run(makeCtx());

		// Lock released — a fresh acquire on the same key should succeed.
		const tracker = RunTracker.getInstance();
		const probe = await tracker.acquireConcurrencySlot("test-wf", "tenant-x", 1, "probe-run", Date.now() + 60_000);
		expect(probe.acquired).toBe(true);
	});

	it("throws ConcurrencyLimitError when the limit is hit and flips run status to throttled", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "tenant-x", concurrencyLimit: 1 },
		});

		// Pre-acquire a slot so the next run hits the limit.
		const tracker = RunTracker.getInstance();
		const preAcquire = await tracker.acquireConcurrencySlot(
			"test-wf",
			"tenant-x",
			1,
			"holder-run",
			Date.now() + 60_000,
		);
		expect(preAcquire.acquired).toBe(true);

		await expect(t.run(makeCtx())).rejects.toBeInstanceOf(ConcurrencyLimitError);

		// The run row created by tracker.startRun should now be marked
		// "throttled" — not "failed", because no step ran.
		const runs = tracker.getStore().getRuns({ status: "throttled" });
		expect(runs.runs.length).toBeGreaterThanOrEqual(1);
		const throttled = runs.runs.find((r) => r.workflowName === "test-wf");
		expect(throttled).toBeDefined();
		expect(throttled?.status).toBe("throttled");
	});

	it("denies when concurrencyKey resolves from a request expression", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "js/ctx.request.body.tenantId", concurrencyLimit: 1 },
		});

		const tracker = RunTracker.getInstance();
		await tracker.acquireConcurrencySlot("test-wf", "tenant-derived", 1, "holder", Date.now() + 60_000);

		await expect(t.run(makeCtx({ tenantId: "tenant-derived" }))).rejects.toBeInstanceOf(ConcurrencyLimitError);

		const throttled = tracker
			.getStore()
			.getRuns({ status: "throttled" })
			.runs.find((r) => r.workflowName === "test-wf");
		expect(throttled).toBeDefined();
	});

	it("ConcurrencyLimitError carries structured info", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "tenant-y", concurrencyLimit: 2 },
		});

		const tracker = RunTracker.getInstance();
		await tracker.acquireConcurrencySlot("test-wf", "tenant-y", 2, "h1", Date.now() + 60_000);
		await tracker.acquireConcurrencySlot("test-wf", "tenant-y", 2, "h2", Date.now() + 60_000);

		try {
			await t.run(makeCtx());
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ConcurrencyLimitError);
			const info = (err as ConcurrencyLimitError).info;
			expect(info.workflowName).toBe("test-wf");
			expect(info.concurrencyKey).toBe("tenant-y");
			expect(info.concurrencyLimit).toBe(2);
			expect(info.currentInFlight).toBe(2);
			expect(info.retryAfterMs).toBeGreaterThan(0);
			expect(info.runId).toBeTruthy();
		}
	});

	it("emits a RUN_THROTTLED event when the gate denies", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "tenant-z", concurrencyLimit: 1 },
		});

		const tracker = RunTracker.getInstance();
		await tracker.acquireConcurrencySlot("test-wf", "tenant-z", 1, "holder", Date.now() + 60_000);

		const events: Array<{ type: string; runId: string }> = [];
		const handler = (event: { type: string; runId: string }) => events.push(event);
		tracker.on("event", handler);

		try {
			await t.run(makeCtx());
		} catch {
			// Expected throw.
		} finally {
			tracker.off("event", handler);
		}

		const throttledEvents = events.filter((e) => e.type === "RUN_THROTTLED");
		expect(throttledEvents.length).toBe(1);
	});

	it("BLOK_CONCURRENCY_DISABLED=1 short-circuits the gate", async () => {
		process.env.BLOK_CONCURRENCY_DISABLED = "1";
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "tenant-x", concurrencyLimit: 1 },
		});

		const tracker = RunTracker.getInstance();
		// Pre-fill the bucket — without the kill-switch this would deny.
		await tracker.acquireConcurrencySlot("test-wf", "tenant-x", 1, "holder", Date.now() + 60_000);

		// The kill-switch makes the gate inert, so this run completes normally.
		const result = await t.run(makeCtx());
		expect(result.ctx).toBeDefined();
	});

	it("strict mode (default): a THROWING key expression fails the run, never silently bypasses the limit", async () => {
		// biome-ignore lint/performance/noDelete: exercise the default (strict) mode
		delete process.env.BLOK_MAPPER_MODE;
		const t = new TestTrigger();
		// `ctx.nonexistent` is undefined → `.path` throws → threw === true.
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "js/ctx.nonexistent.path.userId", concurrencyLimit: 1 },
		});

		await expect(t.run(makeCtx())).rejects.toThrow(/key expression .* threw/);

		// The run is marked "failed" (a misconfig surfaced), NOT silently completed.
		const tracker = RunTracker.getInstance();
		const failed = tracker
			.getStore()
			.getRuns({ status: "failed" })
			.runs.find((r) => r.workflowName === "test-wf");
		expect(failed).toBeDefined();
	});

	it("warn mode: a THROWING key expression falls open (limit not enforced) instead of failing", async () => {
		process.env.BLOK_MAPPER_MODE = "warn";
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "js/ctx.nonexistent.path.userId", concurrencyLimit: 1 },
		});

		// Falls open — the gate is skipped, the run completes.
		const result = await t.run(makeCtx());
		expect(result.ctx).toBeDefined();
	});

	it("a key that resolves to undefined WITHOUT throwing falls open in every mode (absence is not an error)", async () => {
		// biome-ignore lint/performance/noDelete: default (strict) mode — proves only THROWS fail-fast
		delete process.env.BLOK_MAPPER_MODE;
		const t = new TestTrigger();
		// body has no `absent` field → `ctx.request.body.absent` is undefined,
		// no throw → threw === false → fall-open even under strict.
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "js/ctx.request.body.absent", concurrencyLimit: 1 },
		});

		const result = await t.run(makeCtx({ tenantId: "tenant-x" }));
		expect(result.ctx).toBeDefined();
	});

	it("warn mode: concurrencyKey referencing state only a later step could create falls open", async () => {
		// A key that depends on step output can never resolve at gate entry (the
		// gate runs before any step). In strict mode that's a surfaced misconfig;
		// in warn mode it falls open.
		process.env.BLOK_MAPPER_MODE = "warn";
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "js/ctx.state.after.tenantId", concurrencyLimit: 1 },
		});

		const tracker = RunTracker.getInstance();
		await tracker.acquireConcurrencySlot("test-wf", "tenant-after", 1, "holder", Date.now() + 60_000);

		const ctx = makeCtx();
		(ctx as unknown as { state: Record<string, unknown> }).state = {};
		const result = await t.run(ctx);
		expect(result.ctx).toBeDefined();

		const throttled = tracker
			.getStore()
			.getRuns({ status: "throttled" })
			.runs.find((r) => r.workflowName === "test-wf");
		expect(throttled).toBeUndefined();
	});

	it("releases the slot when a step error propagates out of runner.run", async () => {
		// Subclass that throws during run to verify the finally still releases.
		class ExplodingTrigger extends TestTrigger {
			override getRunner(): Runner {
				const r = new Runner([]);
				r.run = async () => {
					throw new Error("boom");
				};
				return r;
			}
		}

		const t = new ExplodingTrigger();
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "tenant-explode", concurrencyLimit: 1 },
		});

		await expect(t.run(makeCtx())).rejects.toThrow("boom");

		// Lock released — fresh acquire succeeds.
		const tracker = RunTracker.getInstance();
		const probe = await tracker.acquireConcurrencySlot(
			"test-wf",
			"tenant-explode",
			1,
			"probe-run",
			Date.now() + 60_000,
		);
		expect(probe.acquired).toBe(true);
	});
});

describe("TriggerBase — concurrency gate with onLimit:'queue' (Tier 2 #6 follow-up)", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
		process.env.BLOK_CONCURRENCY_DISABLED = undefined;
	});

	afterEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
		process.env.BLOK_CONCURRENCY_DISABLED = undefined;
	});

	it("defers the run as DeferredDispatchSignal when limit hit and onLimit:'queue'", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "tenant-q", concurrencyLimit: 1, onLimit: "queue" },
		});

		const tracker = RunTracker.getInstance();
		await tracker.acquireConcurrencySlot("test-wf", "tenant-q", 1, "holder", Date.now() + 60_000);

		await expect(t.run(makeCtx())).rejects.toBeInstanceOf(DeferredDispatchSignal);
	});

	it("DeferredDispatchSignal carries status='queued' and scheduledAt in the future", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "tenant-q2", concurrencyLimit: 1, onLimit: "queue" },
		});

		const tracker = RunTracker.getInstance();
		await tracker.acquireConcurrencySlot("test-wf", "tenant-q2", 1, "holder", Date.now() + 60_000);

		const before = Date.now();
		try {
			await t.run(makeCtx());
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(DeferredDispatchSignal);
			const info = (err as DeferredDispatchSignal).info;
			expect(info.status).toBe("queued");
			expect(info.scheduledAt).toBeGreaterThanOrEqual(before + 1000);
			expect(info.debounced).toBe(false);
			expect(info.pingCount).toBe(1);
			expect(info.runId).toBeTruthy();
			expect(info.workflowName).toBe("test-wf");
		}
	});

	it("flips run status to 'queued' and registers a retry timer", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "tenant-q3", concurrencyLimit: 1, onLimit: "queue" },
		});

		const tracker = RunTracker.getInstance();
		const scheduler = DeferredRunScheduler.getInstance();
		await tracker.acquireConcurrencySlot("test-wf", "tenant-q3", 1, "holder", Date.now() + 60_000);

		try {
			await t.run(makeCtx());
		} catch {
			// expected
		}

		const queuedRuns = tracker.getStore().getRuns({ status: "queued" });
		expect(queuedRuns.runs.length).toBeGreaterThanOrEqual(1);
		const queued = queuedRuns.runs.find((r) => r.workflowName === "test-wf");
		expect(queued).toBeDefined();
		expect(queued?.scheduledAt).toBeGreaterThan(0);
		expect(scheduler.size()).toBeGreaterThan(0);
	});

	it("emits a RUN_QUEUED event when the gate defers", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "tenant-q4", concurrencyLimit: 1, onLimit: "queue" },
		});

		const tracker = RunTracker.getInstance();
		await tracker.acquireConcurrencySlot("test-wf", "tenant-q4", 1, "holder", Date.now() + 60_000);

		const events: Array<{ type: string; payload?: unknown }> = [];
		const handler = (e: { type: string; payload?: unknown }) => events.push(e);
		tracker.on("event", handler);

		try {
			await t.run(makeCtx());
		} catch {
			// expected
		} finally {
			tracker.off("event", handler);
		}

		const queuedEvents = events.filter((e) => e.type === "RUN_QUEUED");
		expect(queuedEvents.length).toBe(1);
		const payload = queuedEvents[0].payload as {
			concurrencyKey: string;
			concurrencyLimit: number;
			currentInFlight: number;
			scheduledAt: number;
		};
		expect(payload.concurrencyKey).toBe("tenant-q4");
		expect(payload.concurrencyLimit).toBe(1);
		expect(payload.currentInFlight).toBe(1);
		expect(payload.scheduledAt).toBeGreaterThan(0);
	});

	it("granted-slot path is unchanged when onLimit:'queue' but slot is available", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "tenant-q5", concurrencyLimit: 1, onLimit: "queue" },
		});

		// No holder pre-acquired — gate should grant cleanly.
		const result = await t.run(makeCtx());
		expect(result.ctx).toBeDefined();

		// Lock released after run.
		const tracker = RunTracker.getInstance();
		const probe = await tracker.acquireConcurrencySlot("test-wf", "tenant-q5", 1, "probe", Date.now() + 60_000);
		expect(probe.acquired).toBe(true);
	});

	it("after holder releases, timer-fired re-acquire grants the queued run", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: { method: "POST", concurrencyKey: "tenant-q6", concurrencyLimit: 1, onLimit: "queue" },
		});

		const tracker = RunTracker.getInstance();
		const scheduler = DeferredRunScheduler.getInstance();
		await tracker.acquireConcurrencySlot("test-wf", "tenant-q6", 1, "holder", Date.now() + 60_000);

		// Queue the run.
		try {
			await t.run(makeCtx());
		} catch {
			// expected
		}

		// Holder releases its slot.
		await tracker.releaseConcurrencySlot("test-wf", "tenant-q6", "holder");

		// Manually drain the scheduler — re-enters run() which will now acquire.
		await scheduler.drainAll();

		// The previously-queued run should now have transitioned to "completed"
		// (TestTrigger.getRunner returns an empty runner, so the workflow finishes immediately).
		const completed = tracker
			.getStore()
			.getRuns({ status: "completed" })
			.runs.find((r) => r.workflowName === "test-wf");
		expect(completed).toBeDefined();
	});

	// Review fix-up · CONCERN-4. The B3 backoff formula
	// `factor ** attempt` is a JS Number op; with attempt=1024 and
	// factor=2 it overflows to Infinity. Math.min clamps the final
	// retryAfterMs (so the bug was "safe by accident"), but
	// `factor ** 1024` is also expensive. The fix clamps the exponent
	// at 30 before exponentiation. This test verifies the clamp by
	// seeding a run with a high pingCount and asserting the resulting
	// scheduledAt stays within `now + maxBackoffMs`.
	it("backoff exponent is clamped (no Infinity even at very high attempt counts)", async () => {
		const t = new TestTrigger();
		t.setTriggerConfig({
			http: {
				method: "POST",
				concurrencyKey: "tenant-q7",
				concurrencyLimit: 1,
				onLimit: "queue",
				concurrencyQueueRetry: { minBackoffMs: 1000, maxBackoffMs: 30_000, factor: 2 },
			},
		});

		const tracker = RunTracker.getInstance();
		await tracker.acquireConcurrencySlot("test-wf", "tenant-q7", 1, "holder", Date.now() + 60_000);

		// First denial — establishes the run in `queued` state with pingCount=1.
		try {
			await t.run(makeCtx());
		} catch {
			// expected
		}

		const queued = tracker
			.getStore()
			.getRuns({ status: "queued" })
			.runs.find((r) => r.workflowName === "test-wf");
		if (!queued) throw new Error("expected a queued run");

		// Force pingCount to a value that would overflow without the clamp:
		// 2^1024 = Infinity in JS Number land.
		tracker.getStore().updateRun(queued.id, { pingCount: 1024 });

		// Re-defer via dispatchDeferred re-entry. The gate hits the same
		// queue path; the formula uses pingCount=1024, which without the
		// clamp would compute `2^1024` (Infinity) before Math.min saves it.
		await DeferredRunScheduler.getInstance().drainAll();

		const refreshed = tracker.getStore().getRun(queued.id);
		// The run flips back to `queued` after re-denial. scheduledAt
		// must be at most `maxBackoffMs` past now — never Infinity, never
		// the wrong order of magnitude.
		const scheduledAt = refreshed?.scheduledAt;
		expect(scheduledAt).toBeDefined();
		if (scheduledAt === undefined) return;
		expect(Number.isFinite(scheduledAt)).toBe(true);
		expect(scheduledAt - Date.now()).toBeLessThanOrEqual(30_000);
		expect(scheduledAt - Date.now()).toBeGreaterThan(0);
	});
});
