import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withErrorBoundary } from "../../src/services/commander.js";

/**
 * #899 — unit contract for the CLI's single async error boundary.
 *
 * The process-level behaviour (real commands, real exit codes) is covered by
 * tests/commands/cli-error-boundary.test.ts. This file pins the three
 * properties that file cannot observe from outside:
 *
 *   1. the boundary never calls `process.exit` — that is what used to kill any
 *      host importing a command function, and what drops pending work;
 *   2. it prints the failure exactly ONCE, on stderr;
 *   3. work already scheduled when the action rejects still runs afterwards.
 *      That is the property the PostHog `process.on("exit")` flush depends on:
 *      a forced exit would tear the loop down instead.
 */
const originalExitCode = process.exitCode;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	process.exitCode = undefined;
	errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
		throw new Error("process.exit must never be called by the error boundary");
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = originalExitCode;
});

describe("withErrorBoundary", () => {
	it("reports a rejected action once on stderr and sets process.exitCode without exiting", async () => {
		const wrapped = withErrorBoundary(async () => {
			throw new Error("scaffold blew up");
		});

		await expect(wrapped()).resolves.toBeUndefined();

		expect(exitSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(errSpy).toHaveBeenCalledTimes(1);
		expect(errSpy).toHaveBeenCalledWith("scaffold blew up");
	});

	it("awaits the action — a rejection settled on a later tick is still caught", async () => {
		const wrapped = withErrorBoundary(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			throw new Error("late failure");
		});

		await wrapped();

		expect(process.exitCode).toBe(1);
		expect(errSpy).toHaveBeenCalledWith("late failure");
	});

	it("reports a synchronous throw and a non-Error throw", async () => {
		await withErrorBoundary(() => {
			throw new Error("sync failure");
		})();
		expect(errSpy).toHaveBeenCalledWith("sync failure");

		errSpy.mockClear();
		await withErrorBoundary(() => {
			// Not an Error — the boundary must still print something readable.
			throw "just a string";
		})();
		expect(errSpy).toHaveBeenCalledWith("just a string");

		errSpy.mockClear();
		await withErrorBoundary(() => {
			throw new Error("");
		})();
		expect(errSpy).toHaveBeenCalledWith("Command failed.");
	});

	it("leaves the exit code alone when the action succeeds", async () => {
		const wrapped = withErrorBoundary(async (a: number, b: number) => a + b);

		await wrapped(1, 2);

		expect(process.exitCode).toBeUndefined();
		expect(errSpy).not.toHaveBeenCalled();
	});

	it("lets pending work finish after a failure — the telemetry-flush property", async () => {
		let flushed = false;
		const wrapped = withErrorBoundary(async () => {
			// Stands in for posthog's async flush: scheduled before the failure,
			// completes only if the process is still running afterwards.
			setTimeout(() => {
				flushed = true;
			}, 5);
			throw new Error("command failed while a flush was in flight");
		});

		await wrapped();
		expect(flushed).toBe(false);

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(flushed).toBe(true);
		expect(exitSpy).not.toHaveBeenCalled();
	});
});
