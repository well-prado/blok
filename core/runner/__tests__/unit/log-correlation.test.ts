import type { LoggerContext } from "@blokjs/shared";
import { describe, expect, it, vi } from "vitest";
import DefaultLogger from "../../src/DefaultLogger";
import type { RunTracker } from "../../src/tracing/RunTracker";
import { TracingLogger } from "../../src/tracing/TracingLogger";

describe("DefaultLogger — OBS-03 correlation keys", () => {
	it("adds run_id / trace_id / span_id to the log line when set", () => {
		const logger = new DefaultLogger("wf", "/wf", "req-1");
		logger.setRunId("run_abc");
		logger.setTraceContext("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331");

		const line = JSON.parse(logger.injectMetadata("hello"));
		expect(line.run_id).toBe("run_abc");
		expect(line.trace_id).toBe("0af7651916cd43dd8448eb211c80319c");
		expect(line.span_id).toBe("b7ad6b7169203331");
		// Existing fields are untouched.
		expect(line.request_id).toBe("req-1");
		expect(line.workflow_name).toBe("wf");
		expect(line.message).toBe("hello");
	});

	it("omits the correlation keys when unset (back-compat)", () => {
		const line = JSON.parse(new DefaultLogger("wf", "/wf", "req-1").injectMetadata("hello"));
		expect(line).not.toHaveProperty("run_id");
		expect(line).not.toHaveProperty("trace_id");
		expect(line).not.toHaveProperty("span_id");
	});
});

describe("TracingLogger — OBS-03 threading", () => {
	function mockInner() {
		return {
			log: vi.fn(),
			logLevel: vi.fn(),
			error: vi.fn(),
			getLogs: vi.fn(() => []),
			getLogsAsText: vi.fn(() => ""),
			getLogsAsBase64: vi.fn(() => ""),
			setRunId: vi.fn(),
			setTraceContext: vi.fn(),
		};
	}
	const mockTracker = { active: false, addLog: vi.fn() } as unknown as RunTracker;

	it("stamps the run id onto the inner logger at construction", () => {
		const inner = mockInner();
		const tl = new TracingLogger(inner as unknown as LoggerContext, "run_xyz", mockTracker);
		expect(tl).toBeDefined();
		expect(inner.setRunId).toHaveBeenCalledWith("run_xyz");
	});

	it("does not set trace context when no span is active", () => {
		const inner = mockInner();
		const tl = new TracingLogger(inner as unknown as LoggerContext, "run_xyz", mockTracker);
		expect(tl).toBeDefined();
		expect(inner.setTraceContext).not.toHaveBeenCalled();
	});

	it("still forwards log calls to the inner logger (back-compat)", () => {
		const inner = mockInner();
		const tl = new TracingLogger(inner as unknown as LoggerContext, "run_xyz", mockTracker);
		tl.log("hi");
		expect(inner.log).toHaveBeenCalledWith("hi");
	});
});
