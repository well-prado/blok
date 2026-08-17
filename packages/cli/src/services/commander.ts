import os from "node:os";
import { Command, type OptionValues } from "commander";
import { PosthogAnalytics } from "./posthog.js";
import { getPackageVersion } from "./utils.js";

const version = await getPackageVersion();
const program = new Command();

const HOME_DIR = `${os.homedir()}/.blok`;
const cliConfigPath = `${HOME_DIR}/blokctl.json`;

const analytics = new PosthogAnalytics({
	version: version,
	cliConfigPath: cliConfigPath,
});

type TrackCommandExecutionParams = {
	command: string;
	args: OptionValues;
	execution: () => Promise<void>;
};

const trackCommandExecution = async ({ command, args, execution }: TrackCommandExecutionParams) => {
	await analytics.trackCommandExecution({
		command: command,
		args: args,
		execution,
	});
};

/**
 * The CLI's single async error boundary (#899).
 *
 * Wrap EVERY commander `.action()` callback with it:
 *
 *   .action(withErrorBoundary(async (options: OptionValues) => { … }))
 *
 * It works for both registration styles — the commands declared inline in
 * `src/index.ts` and the ones that self-register from `commands/<name>/index.ts`
 * via a side-effect import — because it wraps the callback itself, not the
 * `program` it is registered on.
 *
 * What it guarantees, so no command has to invent its own exit strategy again
 * (the root cause behind #888, #890 and #891):
 *
 *   - the action is AWAITED, so a rejected async action can never escape as an
 *     unhandled rejection with a raw stack dump (#890);
 *   - the failure message is printed exactly ONCE, on stderr, so `--json`
 *     commands keep a clean stdout;
 *   - the exit status is set with `process.exitCode`, never `process.exit()`.
 *     That is the whole point: `process.exit()` tears the process down
 *     immediately and drops pending work — most visibly the PostHog
 *     `process.on("exit")` flush in services/posthog.ts (#891). Setting the
 *     code lets the event loop drain and the process exit on its own.
 *
 * The contract this imposes on command implementations: an exported command
 * function THROWS (or returns a typed failure) — it never exits. Only this
 * boundary decides the exit status. `scripts/check-no-process-exit.sh` is the
 * gate that keeps it that way.
 */
const withErrorBoundary = <Args extends unknown[]>(
	action: (...args: Args) => unknown,
): ((...args: Args) => Promise<void>) => {
	return async (...args: Args): Promise<void> => {
		try {
			await action(...args);
		} catch (err) {
			const message = (err instanceof Error ? err.message : String(err)).trim();
			console.error(message || "Command failed.");
			process.exitCode = 1;
		}
	};
};

export {
	program,
	trackCommandExecution,
	withErrorBoundary,
	Command,
	type OptionValues,
	type TrackCommandExecutionParams,
};
