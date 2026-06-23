import { describe, expect, it } from "vitest";
import { type WatchRunEvent, formatEvent } from "../../../src/commands/watch/format";

function ev(partial: Partial<WatchRunEvent>): WatchRunEvent {
	return {
		id: "e1",
		type: "RUN_STARTED",
		runId: "run_abc123def456",
		workflowName: "users.signup",
		timestamp: 0,
		...partial,
	};
}

describe("formatEvent", () => {
	it("renders RUN_STARTED with the workflow name", () => {
		const line = formatEvent(ev({ type: "RUN_STARTED" }), { color: false });
		expect(line).toContain("▶");
		expect(line).toContain("users.signup");
	});

	it("renders NODE_COMPLETED with its duration", () => {
		const line = formatEvent(ev({ type: "NODE_COMPLETED", nodeName: "validate", payload: { durationMs: 12 } }), {
			color: false,
		});
		expect(line).toContain("✓");
		expect(line).toContain("validate");
		expect(line).toContain("12ms");
	});

	it("renders NODE_FAILED with the error code + message", () => {
		const line = formatEvent(
			ev({
				type: "NODE_FAILED",
				nodeName: "charge-card",
				payload: { error: { message: "insufficient_funds", code: 402 }, durationMs: 5 },
			}),
			{ color: false },
		);
		expect(line).toContain("✗");
		expect(line).toContain("charge-card");
		expect(line).toContain("402");
		expect(line).toContain("insufficient_funds");
	});

	it("renders the RUN_FAILED terminal line with duration + error", () => {
		const line = formatEvent(ev({ type: "RUN_FAILED", payload: { durationMs: 143, error: { message: "boom" } } }), {
			color: false,
		});
		expect(line).toContain("FAILED");
		expect(line).toContain("143ms");
		expect(line).toContain("boom");
	});

	it("renders the abnormal-termination states (crash / timeout / cancel)", () => {
		expect(formatEvent(ev({ type: "RUN_CRASHED" }), { color: false })).toContain("CRASHED");
		expect(formatEvent(ev({ type: "RUN_TIMED_OUT", payload: { durationMs: 30000 } }), { color: false })).toContain(
			"TIMED OUT",
		);
		expect(formatEvent(ev({ type: "RUN_CANCELLED" }), { color: false })).toContain("cancelled");
	});

	it("skips noisy events by default but shows them with verbose", () => {
		expect(formatEvent(ev({ type: "NODE_STARTED", nodeName: "x" }), { color: false })).toBeNull();
		expect(formatEvent(ev({ type: "LOG_ENTRY" }), { color: false })).toBeNull();
		expect(formatEvent(ev({ type: "VARS_UPDATED" }), { color: false })).toBeNull();
		expect(formatEvent(ev({ type: "NODE_STARTED", nodeName: "x" }), { color: false, verbose: true })).toContain("x");
	});

	it("emits no ANSI escapes when color is disabled", () => {
		const line = formatEvent(ev({ type: "RUN_STARTED" }), { color: false });
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI absence
		expect(line).not.toMatch(/\[/);
	});

	it("emits ANSI escapes when color is enabled", () => {
		const line = formatEvent(ev({ type: "NODE_FAILED", nodeName: "x", payload: {} }), { color: true });
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI presence
		expect(line).toMatch(/\[/);
	});
});
