import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import type { OptionValues } from "commander";
import fsExtra from "fs-extra";
import { readProjectConfig } from "../../services/runtime-setup.js";

const runningProcesses: ChildProcess[] = [];

export async function devProject(opts: OptionValues) {
	const currentPath = process.cwd();
	console.log("Starting the development server...");
	console.log("Current path: ", currentPath);

	// Always start the NodeJS runner
	const processes: Array<{
		cmd: string;
		args: string[];
		name: string;
		cwd?: string;
		env?: Record<string, string>;
	}> = [{ cmd: "npx", args: ["nodemon@3.1.9"], name: "NodeJS Runner" }];

	// Read project runtime config and add configured runtimes
	const config = readProjectConfig(currentPath);

	if (config?.runtimes) {
		for (const [, rt] of Object.entries(config.runtimes)) {
			const cmdParts = rt.startCmd.split(" ");
			const cmd = cmdParts[0];
			const args = cmdParts.slice(1);
			const runtimeCwd = path.resolve(currentPath, rt.cwd);

			// Verify runtime directory exists
			if (!fsExtra.existsSync(runtimeCwd)) {
				console.log(`  Warning: ${rt.label} runtime directory not found at ${rt.cwd}. Skipping.`);
				continue;
			}

			processes.push({
				cmd,
				args,
				name: `${rt.label} Runtime (port ${rt.port})`,
				cwd: runtimeCwd,
				env: {
					PORT: String(rt.port),
					HOST: "0.0.0.0",
				},
			});
		}
	} else {
		// Legacy fallback: check for old-style Python3 setup
		const legacyPythonConfig = path.join(currentPath, ".blok", "runtimes", "python3", "nodemon.json");
		if (fsExtra.existsSync(legacyPythonConfig)) {
			processes.push({
				cmd: "npx",
				args: [
					"nodemon@3.1.9",
					"--config",
					"./.blok/runtimes/python3/nodemon.json",
					"--exec",
					"./.blok/runtimes/python3/python3_runtime/bin/python3",
					"./.blok/runtimes/python3/server.py",
				],
				name: "Python3 Runner (legacy)",
			});
		}
	}

	for (const { cmd, args, name, cwd, env } of processes) {
		const child = spawn(cmd, args, {
			stdio: "inherit",
			cwd: cwd || currentPath,
			env: { ...process.env, BLOK_HMR: "true", NODE_ENV: "development", ...env },
		});

		console.log(`  ${name} started (PID: ${child.pid})`);

		runningProcesses.push(child);

		child.on("exit", (code) => {
			console.log(`  ${name} exited with code ${code}`);
		});

		child.on("error", (err) => {
			console.error(`  ${name} error: ${err}`);
		});
	}

	// Show summary
	if (config?.runtimes && Object.keys(config.runtimes).length > 0) {
		console.log("\nRuntime health endpoints:");
		for (const [, rt] of Object.entries(config.runtimes)) {
			console.log(`  ${rt.label}: http://localhost:${rt.port}/health`);
		}
	}

	// Capture CTRL+C to stop the processes
	process.on("SIGINT", () => {
		console.log("\nStopping processes...");
		for (const child of runningProcesses) {
			try {
				process.kill(child.pid as number, "SIGTERM");
				console.log(`  Process ${child.pid} stopped.`);
			} catch (err: unknown) {
				console.error(`  Error stopping process ${child.pid}: ${(err as Error).message}`);
			}
		}
		process.exit(0);
	});
}
