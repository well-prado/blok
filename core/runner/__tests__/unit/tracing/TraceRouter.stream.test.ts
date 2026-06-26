import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTraceRoutes } from "../../../src/tracing/TraceRouter";
import type { RunEvent, RunEventType, WorkflowRun, WorkflowRunStatus } from "../../../src/tracing/types";

// MO-TRACESTORE — the per-run SSE stream (`GET /runs/:runId/stream`). Verifies
// the terminal-close path AND the leak fix: the terminal auto-close must clear
// the heartbeat interval + remove the event listener (previously only the
// client-disconnect handler did, so a server-side close leaked both).

class FakeTracker extends EventEmitter {
	runs = new Map<string, WorkflowRun>();
	getRun(id: string): WorkflowRun | undefined {
		return this.runs.get(id);
	}
	getEvents(_id: string): RunEvent[] {
		return [];
	}
}

function fakeRes() {
	const writes: string[] = [];
	const state = { ended: false, statusCode: 200 };
	const res = {
		writes,
		state,
		setHeader() {},
		flushHeaders() {},
		status(code: number) {
			state.statusCode = code;
			return res;
		},
		json() {},
		sendStatus() {},
		write(chunk: string) {
			writes.push(chunk);
			return true;
		},
		end() {
			state.ended = true;
		},
	};
	return res;
}

function fakeReq(runId: string) {
	let closeCb: (() => void) | undefined;
	return {
		method: "GET",
		params: { runId },
		query: {},
		headers: {} as Record<string, string | undefined>,
		on(ev: string, cb: () => void) {
			if (ev === "close") closeCb = cb;
		},
		fireClose() {
			closeCb?.();
		},
	};
}

function captureStreamHandler(tracker: FakeTracker) {
	let handler: ((req: unknown, res: unknown) => void) | undefined;
	const router = {
		use() {},
		post() {},
		put() {},
		delete() {},
		get(path: string, h: (req: unknown, res: unknown) => void) {
			if (path === "/runs/:runId/stream") handler = h;
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: minimal router/tracker fakes for the handler under test
	registerTraceRoutes(router as any, tracker as any, { authorize: () => true });
	if (!handler) throw new Error("stream route not registered");
	return handler;
}

const runWith = (status: WorkflowRunStatus): WorkflowRun =>
	({
		id: "r1",
		workflowName: "w",
		workflowPath: "/w",
		triggerType: "http",
		triggerSummary: "",
		status,
		startedAt: 0,
	}) as WorkflowRun;
const evt = (type: RunEventType): RunEvent =>
	({ id: "e1", type, runId: "r1", workflowName: "w", timestamp: 0 }) as RunEvent;

describe("TraceRouter per-run SSE stream (MO-TRACESTORE)", () => {
	let tracker: FakeTracker;
	let handler: (req: unknown, res: unknown) => void;
	beforeEach(() => {
		vi.useFakeTimers();
		process.env.BLOK_TRACE_AUTH_DISABLED = "1";
		tracker = new FakeTracker();
		handler = captureStreamHandler(tracker);
	});
	afterEach(() => vi.useRealTimers());

	it("404s for an unknown run", () => {
		const res = fakeRes();
		handler(fakeReq("nope"), res);
		expect(res.state.statusCode).toBe(404);
	});

	it("closes immediately (stream-end) when connecting to an already-terminal run", () => {
		tracker.runs.set("r1", runWith("crashed"));
		const res = fakeRes();
		handler(fakeReq("r1"), res);
		expect(res.writes.join("")).toContain("stream-end");
		expect(res.state.ended).toBe(true);
		expect(tracker.listenerCount("event")).toBe(0); // never subscribed
	});

	it("stays open for a running run, then auto-closes on a terminal event", () => {
		tracker.runs.set("r1", runWith("running"));
		const res = fakeRes();
		handler(fakeReq("r1"), res);
		expect(res.state.ended).toBe(false);
		tracker.emit("event", evt("RUN_TIMED_OUT"));
		expect(res.writes.join("")).toContain("stream-end");
		expect(res.state.ended).toBe(true);
	});

	it("does NOT close on a non-terminal event (queued/delayed/started)", () => {
		tracker.runs.set("r1", runWith("running"));
		const res = fakeRes();
		handler(fakeReq("r1"), res);
		for (const t of ["RUN_STARTED", "RUN_QUEUED", "RUN_DELAYED"] as RunEventType[]) tracker.emit("event", evt(t));
		expect(res.writes.join("")).not.toContain("stream-end");
		expect(res.state.ended).toBe(false);
	});

	it("LEAK FIX: terminal auto-close removes the listener AND clears the heartbeat", () => {
		tracker.runs.set("r1", runWith("running"));
		const res = fakeRes();
		handler(fakeReq("r1"), res);
		expect(tracker.listenerCount("event")).toBe(1);

		tracker.emit("event", evt("RUN_CRASHED")); // terminal → cleanup + end
		expect(tracker.listenerCount("event")).toBe(0); // listener removed

		const before = res.writes.length;
		vi.advanceTimersByTime(15_000); // 3 heartbeat intervals
		expect(res.writes.length).toBe(before); // heartbeat cleared — no further writes
	});

	it("client disconnect removes the listener + clears the heartbeat", () => {
		tracker.runs.set("r1", runWith("running"));
		const res = fakeRes();
		const req = fakeReq("r1");
		handler(req, res);
		expect(tracker.listenerCount("event")).toBe(1);

		req.fireClose();
		expect(tracker.listenerCount("event")).toBe(0);
		const before = res.writes.length;
		vi.advanceTimersByTime(15_000);
		expect(res.writes.length).toBe(before);
	});
});
