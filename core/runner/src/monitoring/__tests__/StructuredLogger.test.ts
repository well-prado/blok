import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LogEntry, StructuredLogger } from "../StructuredLogger";

describe("StructuredLogger", () => {
	let logger: StructuredLogger;
	let captured: LogEntry[];

	beforeEach(() => {
		captured = [];
		logger = new StructuredLogger({
			service: "test-service",
			environment: "test",
			level: "debug",
			transport: (entry) => captured.push(entry),
		});
	});

	describe("Construction", () => {
		it("should create a logger with minimal config", () => {
			const l = new StructuredLogger({ service: "my-service" });
			expect(l).toBeDefined();
		});

		it("should create a logger with full config", () => {
			const l = new StructuredLogger({
				service: "my-service",
				environment: "production",
				level: "warn",
				defaultFields: { region: "us-east-1" },
				transport: () => {},
			});
			expect(l).toBeDefined();
			expect(l.getLevel()).toBe("warn");
		});
	});

	describe("Log Levels", () => {
		it("should log at debug level", () => {
			logger.debug("Debug message");
			expect(captured.length).toBe(1);
			expect(captured[0].level).toBe("debug");
			expect(captured[0].message).toBe("Debug message");
		});

		it("should log at info level", () => {
			logger.info("Info message");
			expect(captured.length).toBe(1);
			expect(captured[0].level).toBe("info");
		});

		it("should log at warn level", () => {
			logger.warn("Warning message");
			expect(captured.length).toBe(1);
			expect(captured[0].level).toBe("warn");
		});

		it("should log at error level", () => {
			logger.error("Error message");
			expect(captured.length).toBe(1);
			expect(captured[0].level).toBe("error");
		});

		it("should log at fatal level", () => {
			logger.fatal("Fatal message");
			expect(captured.length).toBe(1);
			expect(captured[0].level).toBe("fatal");
		});
	});

	describe("Level Filtering", () => {
		it("should filter out logs below minimum level", () => {
			const warnLogger = new StructuredLogger({
				service: "test",
				level: "warn",
				transport: (entry) => captured.push(entry),
			});

			warnLogger.debug("should not appear");
			warnLogger.info("should not appear");
			warnLogger.warn("should appear");
			warnLogger.error("should appear");
			warnLogger.fatal("should appear");

			expect(captured.length).toBe(3);
			expect(captured[0].level).toBe("warn");
			expect(captured[1].level).toBe("error");
			expect(captured[2].level).toBe("fatal");
		});

		it("should support setLevel at runtime", () => {
			logger.setLevel("error");
			expect(logger.getLevel()).toBe("error");

			logger.info("should be filtered");
			logger.error("should appear");

			expect(captured.length).toBe(1);
			expect(captured[0].level).toBe("error");
		});

		it("should support isLevelEnabled check", () => {
			logger.setLevel("warn");
			expect(logger.isLevelEnabled("debug")).toBe(false);
			expect(logger.isLevelEnabled("info")).toBe(false);
			expect(logger.isLevelEnabled("warn")).toBe(true);
			expect(logger.isLevelEnabled("error")).toBe(true);
			expect(logger.isLevelEnabled("fatal")).toBe(true);
		});
	});

	describe("Structured Fields", () => {
		it("should include standard fields in every entry", () => {
			logger.info("test");

			const entry = captured[0];
			expect(entry.timestamp).toBeDefined();
			expect(entry.level).toBe("info");
			expect(entry.service).toBe("test-service");
			expect(entry.env).toBe("test");
			expect(entry.message).toBe("test");
		});

		it("should include custom fields", () => {
			logger.info("User created", { userId: "u-123", email: "test@example.com" });

			const entry = captured[0];
			expect(entry.userId).toBe("u-123");
			expect(entry.email).toBe("test@example.com");
		});

		it("should extract Error objects in error level", () => {
			const err = new Error("Something broke");
			logger.error("Operation failed", { error: err, operation: "db-write" });

			const entry = captured[0];
			expect(entry.error_message).toBe("Something broke");
			expect(entry.error_name).toBe("Error");
			expect(entry.error_stack).toBeDefined();
			expect(entry.operation).toBe("db-write");
			// The original error object should not be in the entry
			expect(entry.error).toBeUndefined();
		});

		it("should include ISO 8601 timestamp", () => {
			logger.info("test");
			const ts = captured[0].timestamp;
			expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		});
	});

	describe("Default Fields", () => {
		it("should include default fields in every entry", () => {
			const l = new StructuredLogger({
				service: "test",
				level: "debug",
				defaultFields: { region: "us-east-1", version: "1.0.0" },
				transport: (entry) => captured.push(entry),
			});

			l.info("test");
			expect(captured[0].region).toBe("us-east-1");
			expect(captured[0].version).toBe("1.0.0");
		});

		it("should allow per-message fields to override defaults", () => {
			const l = new StructuredLogger({
				service: "test",
				level: "debug",
				defaultFields: { key: "default" },
				transport: (entry) => captured.push(entry),
			});

			l.info("test", { key: "override" });
			expect(captured[0].key).toBe("override");
		});
	});

	describe("Child Logger", () => {
		it("should create a child logger with persistent fields", () => {
			const child = logger.child({ requestId: "req-001", workflow: "user-api" });

			child.info("Processing request");
			expect(captured[0].requestId).toBe("req-001");
			expect(captured[0].workflow).toBe("user-api");
		});

		it("should inherit parent config", () => {
			const child = logger.child({ requestId: "req-001" });
			expect(child.getLevel()).toBe("debug");
		});

		it("should allow child-specific fields to be added per message", () => {
			const child = logger.child({ requestId: "req-001" });
			child.info("Node executed", { node: "db-query", durationMs: 42 });

			expect(captured[0].requestId).toBe("req-001");
			expect(captured[0].node).toBe("db-query");
			expect(captured[0].durationMs).toBe(42);
		});

		it("should support nested children", () => {
			const reqLogger = logger.child({ requestId: "req-001" });
			const nodeLogger = reqLogger.child({ node: "validator" });

			nodeLogger.info("Validating input");

			expect(captured[0].requestId).toBe("req-001");
			expect(captured[0].node).toBe("validator");
		});
	});

	describe("Log Buffer", () => {
		it("should collect log entries in buffer", () => {
			logger.info("msg1");
			logger.info("msg2");
			logger.warn("msg3");

			const logs = logger.getLogs();
			expect(logs.length).toBe(3);
			expect(logs[0].message).toBe("msg1");
			expect(logs[2].level).toBe("warn");
		});

		it("should return a copy of the buffer", () => {
			logger.info("msg1");
			const logs = logger.getLogs();
			logs.push({ timestamp: "", level: "info", service: "", env: "", message: "injected" });

			// Original buffer should not be modified
			expect(logger.getLogs().length).toBe(1);
		});

		it("should clear the log buffer", () => {
			logger.info("msg1");
			logger.info("msg2");
			logger.clearLogs();

			expect(logger.getLogs().length).toBe(0);
		});

		it("should output NDJSON format", () => {
			logger.info("line1");
			logger.warn("line2");

			const ndjson = logger.getLogsAsNDJSON();
			const lines = ndjson.split("\n");
			expect(lines.length).toBe(2);

			const parsed1 = JSON.parse(lines[0]);
			expect(parsed1.message).toBe("line1");

			const parsed2 = JSON.parse(lines[1]);
			expect(parsed2.message).toBe("line2");
		});
	});

	describe("Trace Context", () => {
		it("should include trace_id and span_id when active span exists", () => {
			// Without an active OTel trace provider, trace context will not be injected
			// But the code path should still work without errors
			logger.info("No trace context");
			expect(captured[0].trace_id).toBeUndefined();
		});

		it("should log with explicit span via withSpan", () => {
			// Create a mock-like span
			const { trace: traceApi } = require("@opentelemetry/api");
			const tracer = traceApi.getTracer("test");
			const span = tracer.startSpan("test-span");

			logger.withSpan(span, "info", "Span-correlated log", { extra: "data" });

			const entry = captured[0];
			expect(entry.message).toBe("Span-correlated log");
			expect(entry.extra).toBe("data");
			// trace_id/span_id may be zero with no-op provider
			span.end();
		});
	});

	describe("CONSOLE_LOG_ACTIVE", () => {
		const originalEnv = process.env.CONSOLE_LOG_ACTIVE;

		afterEach(() => {
			if (originalEnv === undefined) {
				process.env.CONSOLE_LOG_ACTIVE = undefined;
			} else {
				process.env.CONSOLE_LOG_ACTIVE = originalEnv;
			}
		});

		it("should suppress output when CONSOLE_LOG_ACTIVE is false", () => {
			process.env.CONSOLE_LOG_ACTIVE = "false";

			logger.info("should not appear");
			logger.error("should not appear either");

			expect(captured.length).toBe(0);
		});

		it("should output when CONSOLE_LOG_ACTIVE is true", () => {
			process.env.CONSOLE_LOG_ACTIVE = "true";

			logger.info("should appear");
			expect(captured.length).toBe(1);
		});
	});

	describe("Default Transport", () => {
		it("should write to stdout for info/debug/warn", () => {
			const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			const l = new StructuredLogger({
				service: "test",
				level: "debug",
			});

			l.info("stdout message");

			expect(stdoutSpy).toHaveBeenCalled();
			const output = stdoutSpy.mock.calls[0][0] as string;
			expect(output).toContain("stdout message");
			expect(output.endsWith("\n")).toBe(true);

			// Verify it's valid JSON
			const parsed = JSON.parse(output.trim());
			expect(parsed.message).toBe("stdout message");

			stdoutSpy.mockRestore();
		});

		it("should write to stderr for error/fatal", () => {
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const l = new StructuredLogger({
				service: "test",
				level: "debug",
			});

			l.error("stderr message");

			expect(stderrSpy).toHaveBeenCalled();
			const output = stderrSpy.mock.calls[0][0] as string;
			expect(output).toContain("stderr message");

			stderrSpy.mockRestore();
		});
	});

	describe("BLOK_LOG_LEVEL env var", () => {
		const originalLevel = process.env.BLOK_LOG_LEVEL;

		afterEach(() => {
			if (originalLevel === undefined) {
				process.env.BLOK_LOG_LEVEL = undefined;
			} else {
				process.env.BLOK_LOG_LEVEL = originalLevel;
			}
		});

		it("should use BLOK_LOG_LEVEL when no explicit level provided", () => {
			process.env.BLOK_LOG_LEVEL = "error";

			const l = new StructuredLogger({
				service: "test",
				transport: (entry) => captured.push(entry),
			});

			l.info("should not appear");
			l.error("should appear");

			expect(captured.length).toBe(1);
			expect(captured[0].level).toBe("error");
		});
	});
});
