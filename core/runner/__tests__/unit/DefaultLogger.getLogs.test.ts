import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DefaultLogger from "../../src/DefaultLogger";

/**
 * DefaultLogger.getLogs()/getLogsAsText()/getLogsAsBase64() previously always
 * returned [] / "" because the log methods never appended the emitted line to
 * the inherited `this.logs` buffer. They now buffer exactly what is written to
 * stdout — gated by the SAME BLOK_LOG_LEVEL / CONSOLE_LOG_ACTIVE conditions, so
 * suppressed lines are never buffered — bounded to MAX_LOG_BUFFER (1000).
 */
describe("DefaultLogger — getLogs reflects the emitted lines", () => {
	const prevLevel = process.env.BLOK_LOG_LEVEL;
	const prevConsole = process.env.CONSOLE_LOG_ACTIVE;

	beforeEach(() => {
		process.env.CONSOLE_LOG_ACTIVE = "true";
		// biome-ignore lint/performance/noDelete: literal absence to exercise the default level
		delete process.env.BLOK_LOG_LEVEL;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		// biome-ignore lint/performance/noDelete: restore literal absence, not the string "undefined"
		if (prevLevel === undefined) delete process.env.BLOK_LOG_LEVEL;
		else process.env.BLOK_LOG_LEVEL = prevLevel;
		// biome-ignore lint/performance/noDelete: restore literal absence, not the string "undefined"
		if (prevConsole === undefined) delete process.env.CONSOLE_LOG_ACTIVE;
		else process.env.CONSOLE_LOG_ACTIVE = prevConsole;
	});

	it("buffers emitted log/logLevel/error lines into getLogs() + getLogsAsText() + getLogsAsBase64()", () => {
		const logger = new DefaultLogger("wf", "/p", "req-1");
		logger.log("hello");
		logger.logLevel("warn", "careful");
		logger.error("boom", "the-stack");

		const logs = logger.getLogs();
		expect(logs).toHaveLength(3);
		expect(logs[0]).toContain('"message":"hello"');
		expect(logs[1]).toContain('"level":"warn"');
		expect(logs[1]).toContain('"message":"careful"');
		expect(logs[2]).toContain('"level":"error"');
		expect(logs[2]).toContain('"stack":"the-stack"');
		// text/base64 derive from the same buffer
		expect(logger.getLogsAsText()).toBe(logs.join("\n"));
		expect(logger.getLogsAsBase64()).toBe(Buffer.from(logs.join("\n")).toString("base64"));
		// and what was buffered is exactly what was emitted to stdout/stderr
		expect(console.log).toHaveBeenCalledTimes(2); // log + logLevel(warn)
		expect(console.error).toHaveBeenCalledTimes(1); // error
	});

	it("does NOT buffer suppressed lines (BLOK_LOG_LEVEL=warn drops info/debug)", () => {
		process.env.BLOK_LOG_LEVEL = "warn";
		const logger = new DefaultLogger();
		logger.log("info-line-suppressed"); // info < warn → suppressed
		logger.logLevel("debug", "debug-suppressed"); // debug < warn → suppressed
		logger.logLevel("warn", "kept");
		logger.error("kept-error");

		const logs = logger.getLogs();
		expect(logs).toHaveLength(2);
		expect(logs.join("\n")).toContain("kept");
		expect(logs.join("\n")).not.toContain("suppressed");
	});

	it("CONSOLE_LOG_ACTIVE=false buffers nothing (consistent with stdout)", () => {
		process.env.CONSOLE_LOG_ACTIVE = "false";
		const logger = new DefaultLogger();
		logger.log("x");
		logger.error("y");
		expect(logger.getLogs()).toEqual([]);
		expect(logger.getLogsAsText()).toBe("");
	});

	it("caps the buffer at the most-recent MAX_LOG_BUFFER lines", () => {
		const logger = new DefaultLogger();
		for (let i = 0; i < 1100; i++) logger.log(`m${i}`);
		const logs = logger.getLogs();
		expect(logs).toHaveLength(1000);
		expect(logs[logs.length - 1]).toContain('"message":"m1099"'); // newest kept
		expect(logs[0]).toContain('"message":"m100"'); // oldest 100 dropped
	});
});
