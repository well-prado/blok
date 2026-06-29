import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DefaultLogger from "../../src/DefaultLogger";

/**
 * BLOK_LOG_LEVEL must gate the runtime stdout logger. Severity order
 * (least→most): debug < info < warn < error. At threshold `warn`, info/debug
 * are suppressed while warn/error still print.
 */
describe("DefaultLogger — BLOK_LOG_LEVEL stdout filtering", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	const prevLevel = process.env.BLOK_LOG_LEVEL;
	const prevConsole = process.env.CONSOLE_LOG_ACTIVE;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		process.env.CONSOLE_LOG_ACTIVE = "true";
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		// biome-ignore lint/performance/noDelete: restore literal absence, not the string "undefined"
		if (prevLevel === undefined) delete process.env.BLOK_LOG_LEVEL;
		else process.env.BLOK_LOG_LEVEL = prevLevel;
		// biome-ignore lint/performance/noDelete: restore literal absence, not the string "undefined"
		if (prevConsole === undefined) delete process.env.CONSOLE_LOG_ACTIVE;
		else process.env.CONSOLE_LOG_ACTIVE = prevConsole;
	});

	it("at warn: suppresses info/debug, emits warn/error", () => {
		process.env.BLOK_LOG_LEVEL = "warn";
		const logger = new DefaultLogger("wf", "/wf", "req-1");

		logger.log("info via log()");
		logger.logLevel("info", "info via logLevel");
		logger.logLevel("debug", "debug line");
		logger.logLevel("warn", "warn line");
		logger.error("error line");

		// info + debug went to console.log and must be suppressed.
		expect(logSpy).toHaveBeenCalledTimes(1); // only the warn line
		expect(logSpy.mock.calls[0][0]).toContain("warn line");
		// error always prints (and via console.error).
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy.mock.calls[0][0]).toContain("error line");
	});

	it("defaults to info when BLOK_LOG_LEVEL is unset", () => {
		// biome-ignore lint/performance/noDelete: need literal absence to exercise the default
		delete process.env.BLOK_LOG_LEVEL;
		const logger = new DefaultLogger();

		logger.logLevel("debug", "debug line");
		logger.log("info line");
		logger.logLevel("warn", "warn line");

		// debug suppressed, info + warn pass.
		expect(logSpy).toHaveBeenCalledTimes(2);
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("info line");
		expect(printed).toContain("warn line");
		expect(printed).not.toContain("debug line");
	});

	it("at error: suppresses everything below error", () => {
		process.env.BLOK_LOG_LEVEL = "error";
		const logger = new DefaultLogger();

		logger.log("info line");
		logger.logLevel("warn", "warn line");
		logger.error("boom");

		expect(logSpy).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it("CONSOLE_LOG_ACTIVE=false suppresses all levels", () => {
		process.env.CONSOLE_LOG_ACTIVE = "false";
		process.env.BLOK_LOG_LEVEL = "debug";
		const logger = new DefaultLogger();

		logger.error("boom");
		logger.log("info line");

		expect(logSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});
});
