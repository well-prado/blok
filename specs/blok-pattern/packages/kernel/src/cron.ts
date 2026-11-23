// Runs every workflow that has a cron trigger, on its schedule, inside this process.
//
//     const jobs = await startCron(app);
//
// One process, one clock: an app that runs as several copies starts this in one of them,
// or every copy runs every job.
import { BlokError, type CronBinding } from "./kernel.ts";
import { type App, type AppOptions, ready } from "./project.ts";
import { nextRun, parseSchedule } from "./schedule.ts";

/** The clock and the timers, so that a test can move time by hand. */
export interface Timers {
	now(): number;
	set(run: () => void, ms: number): unknown;
	clear(timer: unknown): void;
}
const REAL: Timers = {
	now: () => Date.now(),
	set: (run, ms) => setTimeout(run, ms),
	clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
// The longest a timer can wait is a little under 25 days. A job further away is looked at again then.
const LONGEST = 2 ** 31 - 1;

export interface CronRun {
	/** The workflow. */
	id: string;
	/** The moment on the schedule this run is for. */
	at: Date;
	ok: boolean;
	/** "skipped" when the run before it was still going. */
	error?: string;
}
export interface CronOptions {
	timers?: Timers;
	/** Called after every run, and for every run that was skipped. */
	onRun?: (run: CronRun) => void;
}
export interface CronJobs {
	jobs: Array<{ id: string; schedule: string; timezone: string; next(): Date }>;
	/** Stops the schedules and waits for the runs that are going. */
	stop(): Promise<void>;
}

export async function startCron(source: App | AppOptions, options: CronOptions = {}): Promise<CronJobs> {
	const { bindings, call, log } = await ready(source);
	const timers = options.timers ?? REAL;
	let stopped = false;
	const going = new Set<Promise<void>>();
	const clears: Array<() => void> = [];

	const jobs = bindings
		.filter((binding): binding is CronBinding => binding.kind === "cron")
		.map((binding) => {
			const id = binding.unit.id;
			const schedule = parseSchedule(binding.schedule);
			let next = nextRun(schedule, new Date(timers.now()), binding.timezone);
			let timer: unknown;
			let running = false;

			const run = async (at: Date) => {
				// A run that takes longer than its interval is not joined by a second one. The late one is skipped.
				if (running) {
					log.error(`${id} was not started at ${at.toISOString()}: the run before it is still going.`);
					return options.onRun?.({ id, at, ok: false, error: "skipped" });
				}
				running = true;
				try {
					await call(binding.unit, { body: binding.body });
					options.onRun?.({ id, at, ok: true });
				} catch (err) {
					// Nobody is waiting for an answer, so the log is the only place a failed run shows.
					const error = err instanceof BlokError ? err : new BlokError("unexpected", String(err), id);
					log.error(`${id}, started by its schedule, failed with "${error.code}" at ${error.node}: ${error.message}`);
					options.onRun?.({ id, at, ok: false, error: error.code });
				} finally {
					running = false;
				}
			};
			const arm = () => {
				timer = timers.set(
					() => {
						if (stopped) return;
						if (timers.now() >= next.getTime()) {
							const at = next;
							next = nextRun(schedule, new Date(timers.now()), binding.timezone);
							const one = run(at).finally(() => going.delete(one));
							going.add(one);
						}
						arm();
					},
					Math.min(Math.max(0, next.getTime() - timers.now()), LONGEST),
				);
			};
			arm();
			clears.push(() => timers.clear(timer));
			return { id, schedule: binding.schedule, timezone: binding.timezone, next: () => next };
		});

	return {
		jobs,
		async stop() {
			stopped = true;
			for (const clear of clears) clear();
			await Promise.all(going);
		},
	};
}
