import {
	TERMINAL_RUN_EVENT_STATUS,
	TRANSIENT_RUN_EVENT_STATUS,
	formatMs,
	notificationForRunEvent,
} from "@/lib/runEvents";
import type { RunEvent } from "@/types";
import { describe, expect, it } from "vitest";

const ev = (type: string, payload?: unknown): RunEvent =>
	({ id: "e", type, runId: "r1", workflowName: "wf", timestamp: 0, payload }) as RunEvent;

describe("runEvents — notificationForRunEvent (MO-STUDIO-DOCS)", () => {
	it("completed → success toast with formatted duration", () => {
		expect(notificationForRunEvent(ev("RUN_COMPLETED", { durationMs: 1500 }))).toMatchObject({
			type: "success",
			title: "wf completed",
			message: "Finished in 1.5s",
		});
	});

	it("failed → error toast with the error message", () => {
		expect(notificationForRunEvent(ev("RUN_FAILED", { error: { message: "boom" } }))).toMatchObject({
			type: "error",
			title: "wf failed",
			message: "boom",
		});
	});

	it("crashed → error toast", () => {
		expect(notificationForRunEvent(ev("RUN_CRASHED"))).toMatchObject({ type: "error", title: "wf crashed" });
	});

	it("timedOut → error toast titled 'timed out'", () => {
		expect(notificationForRunEvent(ev("RUN_TIMED_OUT"))).toMatchObject({ type: "error", title: "wf timed out" });
	});

	it("cancelled → info toast (operator action, not a failure)", () => {
		expect(notificationForRunEvent(ev("RUN_CANCELLED"))).toMatchObject({ type: "info", title: "wf cancelled" });
	});

	it("non-notifying events → null", () => {
		for (const t of ["RUN_STARTED", "RUN_QUEUED", "RUN_DELAYED", "NODE_COMPLETED", "LOG_ENTRY", "NODE_CACHED"]) {
			expect(notificationForRunEvent(ev(t))).toBeNull();
		}
	});
});

describe("runEvents — status maps", () => {
	it("terminal map covers all terminal run events", () => {
		expect(TERMINAL_RUN_EVENT_STATUS.RUN_CRASHED).toBe("crashed");
		expect(TERMINAL_RUN_EVENT_STATUS.RUN_TIMED_OUT).toBe("timedOut");
		expect(TERMINAL_RUN_EVENT_STATUS.RUN_CANCELLED).toBe("cancelled");
		expect(TERMINAL_RUN_EVENT_STATUS.RUN_EXPIRED).toBe("expired");
	});

	it("transient map covers queued/delayed but NOT terminal events", () => {
		expect(TRANSIENT_RUN_EVENT_STATUS.RUN_QUEUED).toBe("queued");
		expect(TRANSIENT_RUN_EVENT_STATUS.RUN_DELAYED).toBe("delayed");
		expect(TRANSIENT_RUN_EVENT_STATUS.RUN_COMPLETED).toBeUndefined();
		expect(TRANSIENT_RUN_EVENT_STATUS.RUN_CRASHED).toBeUndefined();
	});

	it("formatMs is human-friendly", () => {
		expect(formatMs(500)).toBe("500ms");
		expect(formatMs(1500)).toBe("1.5s");
	});
});
