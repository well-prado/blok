import { describe, expect, it } from "vitest";
import { ConcurrencyLimitError, isConcurrencyLimitError } from "../../../src/concurrency/ConcurrencyLimitError";

describe("ConcurrencyLimitError", () => {
	const baseInfo = {
		workflowName: "render-pdf",
		concurrencyKey: "tenant-abc",
		concurrencyLimit: 5,
		currentInFlight: 5,
		retryAfterMs: 1000,
		runId: "run_throttled",
	};

	it("captures all info fields and a structured message", () => {
		const err = new ConcurrencyLimitError(baseInfo);
		expect(err.info).toEqual(baseInfo);
		expect(err.message).toContain("render-pdf");
		expect(err.message).toContain("tenant-abc");
		expect(err.message).toContain("limit=5");
		expect(err.message).toContain("currentInFlight=5");
	});

	it("preserves Error semantics (instanceof Error and stack)", () => {
		const err = new ConcurrencyLimitError(baseInfo);
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(ConcurrencyLimitError);
		expect(err.name).toBe("ConcurrencyLimitError");
		expect(typeof err.stack).toBe("string");
	});

	it("isConcurrencyLimitError discriminates correctly", () => {
		expect(isConcurrencyLimitError(new ConcurrencyLimitError(baseInfo))).toBe(true);
		expect(isConcurrencyLimitError(new Error("nope"))).toBe(false);
		expect(isConcurrencyLimitError(undefined)).toBe(false);
		expect(isConcurrencyLimitError("string-like")).toBe(false);
	});
});
