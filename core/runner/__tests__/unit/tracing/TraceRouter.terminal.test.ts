import { describe, expect, it } from "vitest";
import { TERMINAL_RUN_EVENTS, TERMINAL_RUN_STATUSES } from "../../../src/tracing/TraceRouter";
import type { RunEventType, WorkflowRunStatus } from "../../../src/tracing/types";

// OBS-04 — the SSE run stream closes when a run reaches a terminal state. The
// bug: it only closed on completed/failed, so a run ending crashed/timedOut/
// throttled/expired/cancelled left the client socket hanging. These sets drive
// the close; this test pins the terminal/transient split so a future status
// addition can't silently regress the stream-close (either by hanging on a new
// terminal state, or by closing early on a transient one).
describe("TraceRouter terminal-state SSE close (OBS-04)", () => {
	it("treats every truly-terminal run status as terminal", () => {
		const terminal: WorkflowRunStatus[] = [
			"completed",
			"failed",
			"cancelled",
			"crashed",
			"timedOut",
			"throttled",
			"expired",
		];
		for (const s of terminal) expect(TERMINAL_RUN_STATUSES.has(s)).toBe(true);
	});

	it("never closes on a transient/in-progress status (would cut the stream off mid-run)", () => {
		const transient: WorkflowRunStatus[] = ["pending", "running", "delayed", "queued", "debounced"];
		for (const s of transient) expect(TERMINAL_RUN_STATUSES.has(s)).toBe(false);
	});

	it("the terminal event set mirrors the terminal status set", () => {
		const terminalEvents: RunEventType[] = [
			"RUN_COMPLETED",
			"RUN_FAILED",
			"RUN_CANCELLED",
			"RUN_CRASHED",
			"RUN_TIMED_OUT",
			"RUN_THROTTLED",
			"RUN_EXPIRED",
		];
		for (const e of terminalEvents) expect(TERMINAL_RUN_EVENTS.has(e)).toBe(true);
		// the transient run events must NOT auto-close the stream
		for (const e of ["RUN_STARTED", "RUN_DELAYED", "RUN_QUEUED", "RUN_DEBOUNCED"] as RunEventType[]) {
			expect(TERMINAL_RUN_EVENTS.has(e)).toBe(false);
		}
		expect(TERMINAL_RUN_EVENTS.size).toBe(TERMINAL_RUN_STATUSES.size);
	});
});
