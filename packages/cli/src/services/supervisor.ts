/**
 * Bounded restart-with-backoff supervision for the processes `blokctl dev`
 * spawns (ADR 0016 §3 — crash recovery).
 *
 * Before this, `blokctl dev` spawned every sidecar exactly once and logged its
 * exit. A runtime that crashed at 10:02 stayed dead until the operator noticed
 * and restarted the whole dev stack, and every `runtime.*` step targeting it
 * failed in the meantime. That applied to all thirteen sidecar kinds, not just
 * the JavaScript worker, so the supervision lives here rather than in
 * `js-worker.ts`.
 *
 * The policy is deliberately bounded: a process that crashes on boot (bad
 * config, port taken, missing toolchain) must NOT be restarted forever — that
 * turns a clear one-line failure into an unreadable log flood. After
 * `maxRestarts` inside `windowMs` the supervisor gives up and says so once.
 */

import type { ChildProcess } from "node:child_process";

export interface RestartPolicy {
	/** Restarts allowed inside `windowMs` before the supervisor gives up. */
	maxRestarts: number;
	/** Rolling window. Restarts older than this no longer count against the budget. */
	windowMs: number;
	/** First backoff delay. Doubles per consecutive restart. */
	baseDelayMs: number;
	/** Ceiling for the doubling. */
	maxDelayMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
	maxRestarts: 5,
	windowMs: 60_000,
	baseDelayMs: 500,
	maxDelayMs: 8_000,
};

export interface RestartDecision {
	restart: boolean;
	delayMs: number;
	/** Restart timestamps still inside the window, including `now` when restarting. */
	history: number[];
	/** Set when `restart` is false — why the supervisor stopped. */
	reason?: string;
}

/**
 * Pure restart decision. Separated from the process plumbing so the policy —
 * the part that decides whether a crash loop is bounded — is testable without
 * spawning anything.
 */
export function nextRestart(history: readonly number[], now: number, policy: RestartPolicy): RestartDecision {
	const recent = history.filter((at) => now - at < policy.windowMs);
	if (recent.length >= policy.maxRestarts) {
		return {
			restart: false,
			delayMs: 0,
			history: recent,
			reason: `restarted ${recent.length} time(s) in the last ${Math.round(policy.windowMs / 1000)}s`,
		};
	}
	// Consecutive-crash backoff: 500ms, 1s, 2s, 4s, 8s… capped. `recent.length`
	// is how many restarts already happened in this window, so the first crash
	// waits `baseDelayMs`.
	const delayMs = Math.min(policy.baseDelayMs * 2 ** recent.length, policy.maxDelayMs);
	return { restart: true, delayMs, history: [...recent, now] };
}

export interface SupervisorHandle {
	/** The process currently running. Replaced on every restart. */
	readonly child: ChildProcess;
	/** Restarts performed so far (not reset by the rolling window). */
	readonly restarts: number;
	/** True once the restart budget is spent and no further restart is coming. */
	readonly gaveUp: boolean;
	/** Notified when the supervisor gives up. Lets a readiness probe fast-fail
	 * instead of waiting out its full timeout on a process nothing will revive. */
	onGiveUp(listener: () => void): void;
	/** Stop supervising. Call before deliberately killing the child, and on shutdown. */
	release(): void;
}

export interface SuperviseOptions {
	/** Starts a fresh process. Called once up front and again per restart. */
	spawn: () => ChildProcess;
	/** Human name used in the log lines. */
	name: string;
	policy?: RestartPolicy;
	log?: (message: string) => void;
	/** Called after every spawn, including the first (`attempt` 0). Lets a caller
	 * keep its own process list and health probes pointed at the live child. */
	onSpawn?: (child: ChildProcess, attempt: number) => void;
}

/**
 * Spawn `options.spawn()` and restart it, with backoff, whenever it exits
 * without being released. Returns immediately with the first child.
 */
export function superviseProcess(options: SuperviseOptions): SupervisorHandle {
	const policy = options.policy ?? DEFAULT_RESTART_POLICY;
	const log = options.log ?? ((message: string) => console.log(message));
	let history: number[] = [];
	let restarts = 0;
	let released = false;
	let gaveUp = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let current: ChildProcess;
	const giveUpListeners: Array<() => void> = [];

	const start = (attempt: number): void => {
		current = options.spawn();
		options.onSpawn?.(current, attempt);
		current.once("exit", (code, signal) => {
			if (released) return;
			const decision = nextRestart(history, Date.now(), policy);
			const how = signal ? `signal ${signal}` : `code ${code}`;
			if (!decision.restart) {
				gaveUp = true;
				log(
					`  ${options.name} exited (${how}) and will NOT be restarted — ${decision.reason}. Fix the cause and re-run \`blokctl dev\`.`,
				);
				for (const listener of giveUpListeners.splice(0)) listener();
				return;
			}
			history = decision.history;
			restarts++;
			log(`  ${options.name} exited (${how}) — restarting in ${decision.delayMs}ms (attempt ${restarts}).`);
			timer = setTimeout(() => {
				timer = null;
				if (!released) start(restarts);
			}, decision.delayMs);
			// A pending restart must not hold the event loop open on its own.
			timer.unref?.();
		});
	};

	start(0);

	return {
		get child() {
			return current;
		},
		get restarts() {
			return restarts;
		},
		get gaveUp() {
			return gaveUp;
		},
		onGiveUp(listener: () => void): void {
			if (gaveUp) listener();
			else giveUpListeners.push(listener);
		},
		release(): void {
			released = true;
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}
