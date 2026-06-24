/**
 * F5 — CronTrigger.executeWorkflow must treat DeferredDispatchSignal /
 * WaitDispatchRequest as a SUCCESSFUL deferral, not a failure.
 *
 * Pre-fix a cron workflow with a `wait` step (or a delay/debounce
 * scheduling gate) threw one of these control-flow signals, which the
 * catch-all logged as "Cron job failed" and counted in `cron_errors`,
 * even though TriggerBase.run had correctly marked the run
 * delayed/queued/debounced. These tests assert the discrimination:
 * `cron_executions` is bumped, `cron_errors` is NOT, and the span is OK.
 */

import { DeferredDispatchSignal, WaitDispatchRequest } from "@blokjs/runner";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

// Capture every counter the trigger creates so we can assert which ones
// got incremented. Keyed by the counter's NAME (first createCounter arg).
const counters: Record<string, Mock> = {};
const span = {
	setAttribute: vi.fn(),
	setStatus: vi.fn(),
	recordException: vi.fn(),
	end: vi.fn(),
};

vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (_name: string, fn: (s: typeof span) => unknown) => fn(span),
			// OBS-02 T7 — per-step spans use startSpan; a SEPARATE no-op span so
			// step-span activity doesn't pollute the asserted trigger `span`.
			startSpan: () => ({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
		}),
		getActiveSpan: () => undefined,
		setSpan: (c: unknown) => c,
	},
	metrics: {
		getMeter: () => ({
			createCounter: (name: string) => {
				const add = vi.fn();
				counters[name] = add;
				return { add };
			},
			createGauge: () => ({ record: vi.fn() }),
			createHistogram: () => ({ record: vi.fn() }),
			createUpDownCounter: () => ({ add: vi.fn() }),
			createObservableGauge: () => ({ addCallback: vi.fn() }),
			createObservableCounter: () => ({ addCallback: vi.fn() }),
			createObservableUpDownCounter: () => ({ addCallback: vi.fn() }),
		}),
	},
	context: { active: () => ({}), with: (_c: unknown, fn: () => unknown) => fn() },
	propagation: { extract: (c: unknown) => c, inject: () => {} },
	SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 },
	SpanStatusCode: { OK: 0, ERROR: 1 },
	isSpanContextValid: () => false,
}));

import { CronTrigger } from "../src/CronTrigger";

/**
 * Concrete CronTrigger whose `run()` is stubbed to throw a caller-chosen
 * error, so we can drive `executeWorkflow` through each catch branch
 * without a real workflow/runner.
 */
class TestCronTrigger extends CronTrigger {
	protected nodes = {};
	protected workflows = {};
	public thrown: unknown = null;

	// The base constructor calls loadNodes()/loadWorkflows() BEFORE the
	// subclass field initializers run, so `this.nodes` is undefined at that
	// point. Override both as no-ops — this test drives executeWorkflow
	// directly and doesn't need a populated nodeMap.
	override loadNodes(): void {}
	override loadWorkflows(): void {}

	override async run(): Promise<never> {
		throw this.thrown;
	}

	// `executeWorkflow` is protected — expose it.
	async exec(jobId: string, workflowPath: string): Promise<void> {
		const job = {
			id: jobId,
			workflowPath,
			schedule: "* * * * *",
			timezone: "UTC",
			overlap: false,
			running: false,
			nextDate: () => new Date(),
			lastDate: () => new Date(),
			job: { nextDate: () => new Date(), lastDate: () => new Date() },
		};
		this.jobs.set(jobId, job as any);
		// Avoid a real Configuration.init round-trip.
		(this as any).configuration = { init: vi.fn().mockResolvedValue(undefined), name: "cron-wf", nodes: {} };
		await this.exposeExecuteWorkflow(jobId, workflowPath);
	}

	private async exposeExecuteWorkflow(jobId: string, workflowPath: string): Promise<void> {
		await (this as any).executeWorkflow(
			jobId,
			{ path: workflowPath, config: { name: "cron-wf", version: "1.0.0" } },
			{ schedule: "* * * * *", timezone: "UTC" },
			false,
		);
	}
}

describe("CronTrigger.executeWorkflow — F5 deferral discrimination", () => {
	beforeEach(() => {
		for (const k of Object.keys(counters)) delete counters[k];
		span.setAttribute.mockClear();
		span.setStatus.mockClear();
		span.recordException.mockClear();
	});

	it("treats DeferredDispatchSignal as a success (no cron_errors, span OK)", async () => {
		const t = new TestCronTrigger();
		t.thrown = new DeferredDispatchSignal({
			runId: "r1",
			workflowName: "cron-wf",
			status: "delayed",
			scheduledAt: Date.now() + 1000,
			debounced: false,
			pingCount: 1,
		});

		await t.exec("job-1", "scheduled-report");

		expect(counters.cron_errors?.mock.calls.length ?? 0).toBe(0);
		expect(counters.cron_executions?.mock.calls.length ?? 0).toBe(1);
		expect(span.setStatus).toHaveBeenCalledWith({ code: 0 }); // SpanStatusCode.OK
		expect(span.setAttribute).toHaveBeenCalledWith("deferred", true);
		expect(span.recordException).not.toHaveBeenCalled();
	});

	it("treats WaitDispatchRequest as a success (no cron_errors)", async () => {
		const t = new TestCronTrigger();
		t.thrown = new WaitDispatchRequest({
			scheduledAt: Date.now() + 5000,
			stepIndex: 1,
			stepId: "wait-step",
			lastCompletedStepIndex: 0,
		});

		await t.exec("job-2", "long-running");

		expect(counters.cron_errors?.mock.calls.length ?? 0).toBe(0);
		expect(counters.cron_executions?.mock.calls.length ?? 0).toBe(1);
		expect(span.recordException).not.toHaveBeenCalled();
	});

	it("still counts a genuine error in cron_errors (regression guard)", async () => {
		const t = new TestCronTrigger();
		t.thrown = new Error("node blew up");

		await t.exec("job-3", "flaky");

		expect(counters.cron_errors?.mock.calls.length ?? 0).toBe(1);
		expect(counters.cron_executions?.mock.calls.length ?? 0).toBe(0);
		expect(span.recordException).toHaveBeenCalled();
		expect(span.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: 1 })); // ERROR
	});
});
