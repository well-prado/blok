import { describe, expect, it } from "vitest";
import type { WatchRunEvent } from "../../../src/commands/watch/format";
import { parseSseBuffer } from "../../../src/commands/watch/sse";

function frame(type: string, extra: Partial<WatchRunEvent> = {}): string {
	const event: WatchRunEvent = { id: type, type, runId: "run_1", workflowName: "wf", timestamp: 0, ...extra };
	return `event: ${type}\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

describe("parseSseBuffer", () => {
	it("extracts run events, ignores heartbeats + control frames, and keeps a partial trailing frame", () => {
		const buffer = [
			":heartbeat\n\n",
			'event: connected\ndata: {"timestamp":1}\n\n',
			frame("NODE_COMPLETED", { nodeName: "validate", payload: { durationMs: 9 } }),
			'event: RUN_COMPLETED\nid: e2\ndata: {"id":"e2","type":"RUN_COMPLE', // partial, no terminating blank line
		].join("");

		const { events, rest } = parseSseBuffer(buffer);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("NODE_COMPLETED");
		expect(events[0].nodeName).toBe("validate");
		expect(rest).toContain("RUN_COMPLE"); // the partial frame is preserved for the next chunk
	});

	it("tolerates a malformed JSON frame without throwing", () => {
		const { events } = parseSseBuffer("event: NODE_FAILED\ndata: {not json}\n\n");
		expect(events).toHaveLength(0);
	});

	it("ignores a data frame that isn't a run event", () => {
		const { events } = parseSseBuffer('event: stream-end\ndata: {"reason":"run_finished"}\n\n');
		expect(events).toHaveLength(0);
	});

	it("parses multiple frames in one buffer in order", () => {
		const { events } = parseSseBuffer(frame("RUN_STARTED") + frame("NODE_COMPLETED") + frame("RUN_COMPLETED"));
		expect(events.map((e) => e.type)).toEqual(["RUN_STARTED", "NODE_COMPLETED", "RUN_COMPLETED"]);
	});

	it("handles CRLF line endings", () => {
		const crlf = frame("RUN_STARTED").replace(/\n/g, "\r\n");
		const { events } = parseSseBuffer(crlf);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("RUN_STARTED");
	});
});
