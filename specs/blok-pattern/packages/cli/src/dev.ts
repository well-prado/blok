// dev: rebuild on every change, and restart the app when the rebuild is good.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Paths } from "./analyze.ts";

const SELF = fileURLToPath(new URL("./cli.js", import.meta.url));

/**
 * Each rebuild runs in a fresh process. A long-lived one would keep the first version of every
 * node file it imported, and would go on checking workflows against contracts that have changed.
 */
function rebuild(paths: Paths): boolean {
	const run = spawnSync(process.execPath, [SELF, "build", "--allow-empty", "--dir", paths.dir], { stdio: "inherit" });
	return run.status === 0;
}

export async function dev(paths: Paths, command: string[]): Promise<never> {
	let app: ChildProcess | undefined;
	const start = () => {
		if (command.length === 0) return;
		app = spawn(command[0], command.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
		app.on("error", (err) => console.error(`Could not start "${command.join(" ")}": ${err.message}`));
	};
	const stop = () =>
		new Promise<void>((done) => {
			const running = app;
			app = undefined;
			if (!running || running.exitCode !== null || running.signalCode !== null) return done();
			running.once("exit", () => done());
			running.kill("SIGTERM");
		});

	if (rebuild(paths)) start();
	else console.error("Fix the problems above. The app starts once they are gone.");
	if (command.length === 0)
		console.log('No start command was given, so only the build is kept fresh. Pass one after "--".');

	let timer: NodeJS.Timeout | undefined;
	let busy = false;
	let again = false;
	const changed = async () => {
		if (busy) {
			again = true;
			return;
		}
		busy = true;
		do {
			again = false;
			if (rebuild(paths)) {
				await stop();
				start();
			} else {
				console.error(
					app ? "Fix the problems above. The app keeps running on the last good build." : "Fix the problems above.",
				);
			}
		} while (again);
		busy = false;
	};
	// The files this tool writes are in workflows/blok/. Reacting to them would rebuild forever.
	const generated = `blok${sep}`;
	for (const folder of [paths.nodes, paths.workflows]) {
		if (!existsSync(folder)) continue;
		watch(folder, { recursive: true }, (_event, file) => {
			if (!file || (folder === paths.workflows && file.startsWith(generated))) return;
			clearTimeout(timer);
			timer = setTimeout(changed, 120);
		});
	}

	const quit = async () => {
		await stop();
		process.exit(0);
	};
	process.on("SIGINT", quit);
	process.on("SIGTERM", quit);
	return new Promise<never>(() => {});
}
