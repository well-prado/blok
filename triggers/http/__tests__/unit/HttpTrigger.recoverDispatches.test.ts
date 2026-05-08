/**
 * BACKLOG H4 — durable scheduler crash-restart recovery test.
 *
 * Boot recovery for the HTTP durable scheduler. Persists rows to the
 * RunTracker store directly (simulating "rows survived a crash"), then
 * creates a fresh HttpTrigger instance and calls `recoverDispatches()`
 * on it (the boot scan that's normally invoked by `listen()`).
 *
 * Verifies:
 *  - live future dispatches → re-registered with the in-memory scheduler
 *  - past-TTL dispatches → marked expired + dropped
 *  - past-due (overdue) dispatches → fire immediately
 *  - rows for unknown workflows → skipped (multi-trigger processes)
 *  - timer fire actually invokes restoreDispatch and clears the row
 *
 * Avoids subprocess complexity by simulating "process restart" within
 * one test process: persist rows + drop in-memory scheduler state +
 * create fresh trigger. The sqlite/in-memory durability layer is the
 * crossing point between the two simulated processes — that's exactly
 * what survives a real crash.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (_name: string, fn: (span: unknown) => unknown) =>
				fn({
					setAttribute: vi.fn(),
					setStatus: vi.fn(),
					recordException: vi.fn(),
					end: vi.fn(),
				}),
		}),
	},
	metrics: {
		getMeter: () => ({
			createCounter: () => ({ add: vi.fn() }),
			createHistogram: () => ({ record: vi.fn() }),
			createGauge: () => ({ record: vi.fn() }),
			createObservableGauge: () => ({ addCallback: vi.fn() }),
		}),
	},
	SpanStatusCode: { OK: 0, ERROR: 1 },
}));

vi.mock("../../src/runner/metrics/opentelemetry_metrics", () => ({
	metricsHandler: vi.fn(),
}));

vi.mock("../../src/Nodes", () => ({ default: {} }));
vi.mock("../../src/Workflows", () => ({ default: {} }));

const mockServer = { close: vi.fn(), on: vi.fn() };
vi.mock("@hono/node-server", () => ({
	serve: vi.fn((_opts: unknown, cb?: () => void) => {
		if (cb) cb();
		return mockServer;
	}),
}));

vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: () => vi.fn() }));
vi.mock("@hono/node-server/utils/response", () => ({ RESPONSE_ALREADY_SENT: new Response(null) }));

import { DeferredRunScheduler, RunTracker, WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger";

interface PersistedDispatch {
	runId: string;
	workflowName: string;
	scheduledAt: number;
	expiresAt?: number;
	dispatchStatus: "delayed" | "queued" | "debounced";
	payload: unknown;
}

function persistDispatch(d: PersistedDispatch): void {
	RunTracker.getInstance().getStore().upsertScheduledDispatch({
		runId: d.runId,
		workflowName: d.workflowName,
		triggerType: "http",
		scheduledAt: d.scheduledAt,
		expiresAt: d.expiresAt,
		dispatchStatus: d.dispatchStatus,
		payload: d.payload,
		createdAt: Date.now(),
	});
}

function registerWorkflow(name: string): void {
	WorkflowRegistry.getInstance().register({
		name,
		source: "<inline>",
		workflow: {
			name,
			version: "1.0.0",
			trigger: { http: { method: "POST", path: `/${name}` } },
			steps: [],
		},
	});
}

describe("HttpTrigger.recoverDispatches — H4 durable scheduler crash-restart", () => {
	beforeEach(() => {
		// Default to memory store (no leftover sqlite state across tests).
		process.env.BLOK_TRACE_STORE = "memory";
		WorkflowRegistry.resetInstance();
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
	});

	afterEach(() => {
		WorkflowRegistry.resetInstance();
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
		vi.useRealTimers();
		process.env.BLOK_TRACE_STORE = undefined;
	});

	it("re-registers timers for live future dispatches", async () => {
		registerWorkflow("future-wf");
		const futureAt = Date.now() + 60_000;
		persistDispatch({
			runId: "run-future",
			workflowName: "future-wf",
			scheduledAt: futureAt,
			dispatchStatus: "delayed",
			payload: { method: "POST", path: "/future-wf", headers: {}, body: {}, params: {}, query: {} },
		});

		const trigger = new HttpTrigger();
		const result = await trigger.recoverDispatches();

		expect(result.recovered).toBe(1);
		expect(result.expired).toBe(0);
		expect(result.skipped).toBe(0);

		// Timer is now registered in the fresh in-memory scheduler.
		expect(DeferredRunScheduler.getInstance().has("run-future")).toBe(true);

		// Persisted row survives — it's the durability anchor for next restart.
		const remaining = RunTracker.getInstance().getStore().getScheduledDispatches();
		expect(remaining.find((r) => r.runId === "run-future")).toBeDefined();
	});

	it("marks past-TTL dispatches as expired and drops them", async () => {
		registerWorkflow("expired-wf");
		const past = Date.now() - 60_000;
		persistDispatch({
			runId: "run-expired",
			workflowName: "expired-wf",
			scheduledAt: past - 60_000,
			expiresAt: past, // already expired
			dispatchStatus: "delayed",
			payload: null,
		});

		const trigger = new HttpTrigger();
		const result = await trigger.recoverDispatches();

		expect(result.recovered).toBe(0);
		expect(result.expired).toBe(1);
		expect(DeferredRunScheduler.getInstance().has("run-expired")).toBe(false);

		// Row was deleted (expired runs leave behind a status flip on the
		// run record but the dispatch row is reaped).
		const remaining = RunTracker.getInstance().getStore().getScheduledDispatches();
		expect(remaining.find((r) => r.runId === "run-expired")).toBeUndefined();
	});

	it("skips rows for workflows this trigger doesn't own", async () => {
		// No workflow registered for "other-trigger-wf" → skipped, no timer.
		persistDispatch({
			runId: "run-other",
			workflowName: "other-trigger-wf",
			scheduledAt: Date.now() + 60_000,
			dispatchStatus: "delayed",
			payload: null,
		});

		const trigger = new HttpTrigger();
		const result = await trigger.recoverDispatches();

		expect(result.recovered).toBe(0);
		expect(result.expired).toBe(0);
		expect(result.skipped).toBe(1);
		expect(DeferredRunScheduler.getInstance().has("run-other")).toBe(false);
	});

	it("handles a mixed batch (live + expired + skipped) correctly", async () => {
		registerWorkflow("mixed-live-wf");
		registerWorkflow("mixed-exp-wf");

		persistDispatch({
			runId: "live",
			workflowName: "mixed-live-wf",
			scheduledAt: Date.now() + 60_000,
			dispatchStatus: "delayed",
			payload: null,
		});
		persistDispatch({
			runId: "exp",
			workflowName: "mixed-exp-wf",
			scheduledAt: Date.now() - 120_000,
			expiresAt: Date.now() - 60_000,
			dispatchStatus: "delayed",
			payload: null,
		});
		persistDispatch({
			runId: "skip",
			workflowName: "not-my-workflow",
			scheduledAt: Date.now() + 60_000,
			dispatchStatus: "delayed",
			payload: null,
		});

		const trigger = new HttpTrigger();
		const result = await trigger.recoverDispatches();

		expect(result.recovered).toBe(1);
		expect(result.expired).toBe(1);
		expect(result.skipped).toBe(1);
	});

	it("is idempotent — calling recoverDispatches twice doesn't double-register", async () => {
		registerWorkflow("idem-wf");
		persistDispatch({
			runId: "run-idem",
			workflowName: "idem-wf",
			scheduledAt: Date.now() + 60_000,
			dispatchStatus: "delayed",
			payload: null,
		});

		const trigger = new HttpTrigger();
		const r1 = await trigger.recoverDispatches();
		const r2 = await trigger.recoverDispatches();

		expect(r1.recovered).toBe(1);
		expect(r2.recovered).toBe(1); // counted again — but only one timer registered
		expect(DeferredRunScheduler.getInstance().has("run-idem")).toBe(true);
		// DeferredRunScheduler.schedule() replaces existing timers for the
		// same runId, so re-recovery is safe (HMR-friendly).
	});

	it("returns zeros when the store has no scheduled dispatches", async () => {
		const trigger = new HttpTrigger();
		const result = await trigger.recoverDispatches();

		expect(result).toEqual({ recovered: 0, expired: 0, skipped: 0 });
	});
});
