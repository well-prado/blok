import { describe, expect, it } from "vitest";
import GlobalLogger from "../../src/GlobalLogger";

class TestLogger extends GlobalLogger {
	log(message: string): void {
		this.logs.push(message);
	}

	logLevel(level: string, message: string): void {
		this.logs.push(`[${level}] ${message}`);
	}

	error(message: string, stack: string): void {
		this.logs.push(`ERROR: ${message} - ${stack}`);
	}
}

describe("GlobalLogger", () => {
	it("should initialize with empty logs array", () => {
		const logger = new TestLogger();
		expect(logger.getLogs()).toEqual([]);
	});

	describe("getLogs", () => {
		it("should return logs after logging", () => {
			const logger = new TestLogger();
			logger.log("msg1");
			logger.log("msg2");
			expect(logger.getLogs()).toEqual(["msg1", "msg2"]);
		});
	});

	describe("getLogsAsText", () => {
		it("should join logs with newline", () => {
			const logger = new TestLogger();
			logger.log("line1");
			logger.log("line2");
			expect(logger.getLogsAsText()).toBe("line1\nline2");
		});

		it("should return empty string for no logs", () => {
			const logger = new TestLogger();
			expect(logger.getLogsAsText()).toBe("");
		});
	});

	describe("getLogsAsBase64", () => {
		it("should return base64 encoded logs", () => {
			const logger = new TestLogger();
			logger.log("hello");
			const expected = Buffer.from("hello").toString("base64");
			expect(logger.getLogsAsBase64()).toBe(expected);
		});

		it("should return base64 of empty string for no logs", () => {
			const logger = new TestLogger();
			const expected = Buffer.from("").toString("base64");
			expect(logger.getLogsAsBase64()).toBe(expected);
		});
	});

	describe("logLevel", () => {
		it("should format with level prefix", () => {
			const logger = new TestLogger();
			logger.logLevel("WARN", "something happened");
			expect(logger.getLogs()).toEqual(["[WARN] something happened"]);
		});
	});

	describe("error", () => {
		it("should format error with stack", () => {
			const logger = new TestLogger();
			logger.error("fail", "stack trace");
			expect(logger.getLogs()).toEqual(["ERROR: fail - stack trace"]);
		});
	});
});
