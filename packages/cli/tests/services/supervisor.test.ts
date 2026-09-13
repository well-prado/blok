import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_RESTART_POLICY,
	type SupervisorHandle,
	nextRestart,
	superviseProcess,
} from "../../src/services/supervisor.js";

describe("restart policy", () => {
	it("backs off exponentially, capped", () => {
		const policy = { maxRestarts: 10, windowMs: 60_000, baseDelayMs: 500, maxDelayMs: 4_000 };
		const now = 1_000_000;
		expect(nextRestart([], now, policy).delayMs).toBe(500);
		expect(nextRestart([now], now, policy).delayMs).toBe(1_000);
		expect(nextRestart([now, now], now, policy).delayMs).toBe(2_000);
		expect(nextRestart([now, now, now], now, policy).delayMs).toBe(4_000);
		// Capped, not doubling forever.
		expect(nextRestart([now, now, now, now, now], now, policy).delayMs).toBe(4_000);
	});

	it("stops after the budget is spent inside the window", () => {
		const now = 1_000_000;
		const history = Array.from({ length: DEFAULT_RESTART_POLICY.maxRestarts }, () => now - 1_000);
		const decision = nextRestart(history, now, DEFAULT_RESTART_POLICY);
		expect(decision.restart).toBe(false);
		expect(decision.reason).toContain(`restarted ${DEFAULT_RESTART_POLICY.maxRestarts} time(s)`);
	});

	it("forgets restarts older than the window, so a long-lived process keeps its budget", () => {
		const now = 1_000_000;
		const old = Array.from({ length: DEFAULT_RESTART_POLICY.maxRestarts }, () => now - 120_000);
		const decision = nextRestart(old, now, DEFAULT_RESTART_POLICY);
		expect(decision.restart).toBe(true);
		expect(decision.history).toEqual([now]);
	});
});

describe("process supervision", () => {
	const handles: SupervisorHandle[] = [];
	const spawned: ChildProcess[] = [];

	afterEach(async () => {
		for (const handle of handles.splice(0)) handle.release();
		await Promise.all(
			spawned.splice(0).map(
				(child) =>
					new Promise<void>((resolve) => {
						if (child.exitCode !== null || child.signalCode !== null) return resolve();
						child.once("exit", () => resolve());
						try {
							child.kill("SIGKILL");
						} catch {
							resolve();
						}
					}),
			),
		);
	});

	/** A child that stays up until it is killed. */
	function spawnIdle(): ChildProcess {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		spawned.push(child);
		return child;
	}

	function supervise(options: Parameters<typeof superviseProcess>[0]): SupervisorHandle {
		const handle = superviseProcess(options);
		handles.push(handle);
		return handle;
	}

	it("restarts a crashed child with a NEW pid", async () => {
		const pids: Array<number | undefined> = [];
		const handle = supervise({
			name: "test-child",
			spawn: spawnIdle,
			policy: { maxRestarts: 3, windowMs: 60_000, baseDelayMs: 10, maxDelayMs: 20 },
			log: () => undefined,
			onSpawn: (child) => pids.push(child.pid),
		});

		const first = handle.child.pid;
		handle.child.kill("SIGKILL");
		await waitUntil(() => handle.restarts === 1 && handle.child.pid !== first);

		expect(handle.restarts).toBe(1);
		expect(handle.child.pid).not.toBe(first);
		expect(handle.child.exitCode).toBeNull();
		expect(pids).toHaveLength(2);
	});

	it("gives up after the bounded budget instead of looping forever", async () => {
		const messages: string[] = [];
		let gaveUp = false;
		// Exits immediately: a crash-on-boot process, the case a naive
		// always-restart supervisor turns into an infinite log flood.
		const handle = supervise({
			name: "crash-loop",
			spawn: () => {
				const child = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
				spawned.push(child);
				return child;
			},
			policy: { maxRestarts: 2, windowMs: 60_000, baseDelayMs: 5, maxDelayMs: 5 },
			log: (message) => messages.push(message),
		});
		handle.onGiveUp(() => {
			gaveUp = true;
		});

		await waitUntil(() => handle.gaveUp);

		expect(handle.restarts).toBe(2);
		expect(gaveUp).toBe(true);
		expect(messages.at(-1)).toContain("will NOT be restarted");
	});

	it("does not restart after release()", async () => {
		const handle = supervise({
			name: "released",
			spawn: spawnIdle,
			policy: { maxRestarts: 3, windowMs: 60_000, baseDelayMs: 5, maxDelayMs: 5 },
			log: () => undefined,
		});
		const child = handle.child;
		handle.release();
		child.kill("SIGKILL");
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(handle.restarts).toBe(0);
		expect(handle.child).toBe(child);
	});
});

/** Poll `condition` until true or the deadline — no fake timers, so this proves
 * the real listener/timer wiring rather than a mocked version of it. */
async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("condition never became true");
}
