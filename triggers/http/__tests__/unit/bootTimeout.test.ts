import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bounded } from "../../src/runner/bootTimeout.js";

describe("bounded", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("rejects a never-settling promise after the configured bound and names the operation", async () => {
		const result = bounded(new Promise<never>(() => {}), 1_000, "pre-catch-all hook");
		const rejection = expect(result).rejects.toThrow("pre-catch-all hook did not settle within 1000ms");

		await vi.advanceTimersByTimeAsync(1_000);
		await rejection;
	});

	it("returns a settled value and clears the guard timer", async () => {
		await expect(bounded(Promise.resolve("ready"), 1_000, "boot task")).resolves.toBe("ready");
		expect(vi.getTimerCount()).toBe(0);
	});
});
