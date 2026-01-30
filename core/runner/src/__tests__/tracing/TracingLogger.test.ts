import { describe, it, expect, beforeEach, vi } from "vitest";
import { TracingLogger } from "../../tracing/TracingLogger";
import { RunTracker } from "../../tracing/RunTracker";
import type { LoggerContext } from "@nanoservice-ts/shared";

function createMockLogger(): LoggerContext {
	return {
		log: vi.fn(),
		logLevel: vi.fn(),
		error: vi.fn(),
		getLogs: vi.fn(() => ["log1", "log2"]),
		getLogsAsText: vi.fn(() => "log1\nlog2"),
		getLogsAsBase64: vi.fn(() => "bG9nMQ=="),
	};
}

describe("TracingLogger", () => {
	let tracker: RunTracker;
	let mockLogger: LoggerContext;

	beforeEach(() => {
		RunTracker.resetInstance();
		tracker = new RunTracker();
		mockLogger = createMockLogger();
	});

	it("should forward log() to inner logger and tracker", () => {
		const run = tracker.startRun({
			workflowName: "test",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /",
			nodeCount: 1,
		});

		const logger = new TracingLogger(mockLogger, run.id, tracker);
		logger.log("hello world");

		expect(mockLogger.log).toHaveBeenCalledWith("hello world");

		const logs = tracker.getLogs(run.id);
		const found = logs.find((l) => l.message === "hello world");
		expect(found).toBeDefined();
		expect(found?.level).toBe("info");
	});

	it("should forward logLevel() to inner logger and tracker", () => {
		const run = tracker.startRun({
			workflowName: "test",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /",
			nodeCount: 1,
		});

		const logger = new TracingLogger(mockLogger, run.id, tracker);
		logger.logLevel("warn", "something fishy");

		expect(mockLogger.logLevel).toHaveBeenCalledWith("warn", "something fishy");

		const logs = tracker.getLogs(run.id);
		const found = logs.find((l) => l.message === "something fishy");
		expect(found?.level).toBe("warn");
	});

	it("should forward error() to inner logger and tracker", () => {
		const run = tracker.startRun({
			workflowName: "test",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /",
			nodeCount: 1,
		});

		const logger = new TracingLogger(mockLogger, run.id, tracker);
		logger.error("fail", "Error: at line 42");

		expect(mockLogger.error).toHaveBeenCalledWith("fail", "Error: at line 42");

		const logs = tracker.getLogs(run.id);
		const found = logs.find((l) => l.message === "fail");
		expect(found?.level).toBe("error");
		expect(found?.data).toEqual({ stack: "Error: at line 42" });
	});

	it("should handle error() without stack", () => {
		const run = tracker.startRun({
			workflowName: "test",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /",
			nodeCount: 1,
		});

		const logger = new TracingLogger(mockLogger, run.id, tracker);
		logger.error("fail");

		expect(mockLogger.error).toHaveBeenCalledWith("fail", "");

		const logs = tracker.getLogs(run.id);
		const found = logs.find((l) => l.message === "fail");
		expect(found?.data).toBeUndefined();
	});

	it("should delegate getLogs/getLogsAsText/getLogsAsBase64", () => {
		const logger = new TracingLogger(mockLogger, "run-1", tracker);

		expect(logger.getLogs()).toEqual(["log1", "log2"]);
		expect(logger.getLogsAsText()).toBe("log1\nlog2");
		expect(logger.getLogsAsBase64()).toBe("bG9nMQ==");
	});

	it("should normalize log levels correctly", () => {
		const run = tracker.startRun({
			workflowName: "test",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /",
			nodeCount: 1,
		});

		const logger = new TracingLogger(mockLogger, run.id, tracker);

		logger.logLevel("DEBUG", "debug msg");
		logger.logLevel("WARNING", "warn msg");
		logger.logLevel("FATAL", "fatal msg");
		logger.logLevel("custom", "custom msg");

		const logs = tracker.getLogs(run.id);
		const levels = logs.map((l) => l.level);
		expect(levels).toEqual(["debug", "warn", "error", "info"]);
	});
});
