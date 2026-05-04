/**
 * PR 3 D5 — backend.disconnect() Promise.race timeout in
 * `installShutdownHandlers`. Slow brokers must not hang the process
 * past the SIGTERM-to-SIGKILL window.
 *
 * Default 10s; configurable via BLOK_BACKEND_DISCONNECT_TIMEOUT_MS.
 */

import type { ConcurrencyBackend, ConcurrencySlotResult } from "@blokjs/runner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TriggerBase from "../../src/TriggerBase";
import { RunTracker } from "../../src/tracing/RunTracker";

class TestTrigger extends TriggerBase {
	async listen(): Promise<number> {
		return 0;
	}
	override async stop(): Promise<void> {
		// no-op
	}
}

class SlowBackend implements ConcurrencyBackend {
	readonly name = "slow-mock";
	public disconnectCalled = false;
	public disconnectResolved = false;
	private resolver: (() => void) | null = null;

	constructor(private behavior: "never-resolve" | "fast-resolve") {}

	async connect(): Promise<void> {
		// no-op
	}

	async disconnect(): Promise<void> {
		this.disconnectCalled = true;
		if (this.behavior === "fast-resolve") {
			this.disconnectResolved = true;
			return;
		}
		// never-resolve: return a Promise that hangs indefinitely.
		return new Promise<void>((resolve) => {
			this.resolver = () => {
				this.disconnectResolved = true;
				resolve();
			};
		});
	}

	async acquireSlot(): Promise<ConcurrencySlotResult> {
		return { acquired: false, currentInFlight: 0 };
	}

	async releaseSlot(): Promise<void> {
		// no-op
	}

	async purgeExpired(): Promise<number> {
		return 0;
	}

	resolve(): void {
		this.resolver?.();
	}
}

describe("PR 3 D5 — backend disconnect timeout", () => {
	const originalExit = process.exit;
	const originalSetTimeout = setTimeout;

	beforeEach(() => {
		RunTracker.resetInstance();
		TriggerBase.resetShutdownHandlersInstalled();
		// Stub process.exit so the test doesn't actually kill the runner.
		(process as unknown as { exit: (code?: number) => void }).exit = vi.fn() as unknown as typeof process.exit;
	});

	afterEach(() => {
		RunTracker.resetInstance();
		TriggerBase.resetShutdownHandlersInstalled();
		(process as unknown as { exit: typeof process.exit }).exit = originalExit;
		// Cleanup BLOK env var
		process.env.BLOK_BACKEND_DISCONNECT_TIMEOUT_MS = undefined;
		// Drop any lingering SIGTERM/SIGINT listeners so subsequent tests start clean.
		process.removeAllListeners("SIGTERM");
		process.removeAllListeners("SIGINT");
	});

	it("times out when backend.disconnect() never resolves", async () => {
		// Override the timeout to a tiny value so the test runs fast.
		process.env.BLOK_BACKEND_DISCONNECT_TIMEOUT_MS = "50";

		const slow = new SlowBackend("never-resolve");
		RunTracker.getInstance().setConcurrencyBackend(slow);

		const t = new TestTrigger();
		const errorLog: string[] = [];
		TriggerBase.installShutdownHandlers(t, {
			error: (msg) => errorLog.push(msg),
			log: () => {},
		});

		// Trigger SIGTERM and wait for the handler to complete.
		const exitCalled = new Promise<void>((resolve) => {
			(process as unknown as { exit: (code?: number) => void }).exit = (() => {
				resolve();
			}) as unknown as typeof process.exit;
		});

		process.emit("SIGTERM", "SIGTERM");
		await exitCalled;

		expect(slow.disconnectCalled).toBe(true);
		expect(slow.disconnectResolved).toBe(false); // never-resolve never resolved
		const timeoutLog = errorLog.find((m) => m.includes("timed out"));
		expect(timeoutLog).toBeDefined();
	}, 10_000);

	it("completes normally when backend.disconnect() resolves quickly", async () => {
		const fast = new SlowBackend("fast-resolve");
		RunTracker.getInstance().setConcurrencyBackend(fast);

		const t = new TestTrigger();
		TriggerBase.installShutdownHandlers(t);

		const exitCalled = new Promise<void>((resolve) => {
			(process as unknown as { exit: (code?: number) => void }).exit = (() => {
				resolve();
			}) as unknown as typeof process.exit;
		});

		process.emit("SIGTERM", "SIGTERM");
		await exitCalled;

		expect(fast.disconnectCalled).toBe(true);
		expect(fast.disconnectResolved).toBe(true);
	});

	it("BLOK_BACKEND_DISCONNECT_TIMEOUT_MS env var overrides default", async () => {
		process.env.BLOK_BACKEND_DISCONNECT_TIMEOUT_MS = "30";

		const slow = new SlowBackend("never-resolve");
		RunTracker.getInstance().setConcurrencyBackend(slow);

		const t = new TestTrigger();
		const errorLog: string[] = [];
		TriggerBase.installShutdownHandlers(t, { error: (m) => errorLog.push(m), log: () => {} });

		const start = Date.now();
		const exitCalled = new Promise<void>((resolve) => {
			(process as unknown as { exit: (code?: number) => void }).exit = (() => {
				resolve();
			}) as unknown as typeof process.exit;
		});

		process.emit("SIGTERM", "SIGTERM");
		await exitCalled;
		const elapsed = Date.now() - start;

		// Should time out at ~30ms, well under default 10000ms.
		expect(elapsed).toBeLessThan(1000);
		expect(errorLog.find((m) => m.includes("timed out"))).toBeDefined();
	}, 5000);
});
