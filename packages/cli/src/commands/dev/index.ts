import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import type { OptionValues } from "commander";
import fsExtra from "fs-extra";
import { readProjectConfig } from "../../services/runtime-setup.js";

const runningProcesses: ChildProcess[] = [];

function spawnProcess(
	cmd: string,
	args: string[],
	name: string,
	currentPath: string,
	cwd?: string,
	env?: Record<string, string>,
): ChildProcess {
	const child = spawn(cmd, args, {
		stdio: "inherit",
		cwd: cwd || currentPath,
		env: { ...process.env, BLOK_HMR: "true", NODE_ENV: "development", ...env },
		detached: true,
	});

	console.log(`  ${name} started (PID: ${child.pid})`);
	runningProcesses.push(child);

	child.on("exit", (code) => {
		console.log(`  ${name} exited with code ${code}`);
	});

	child.on("error", (err) => {
		console.error(`  ${name} error: ${err}`);
	});

	return child;
}

/**
 * Kill all process groups. Uses POSIX kill(-pgid) to terminate entire
 * process trees (child + all its descendants).
 */
function killAllGroups(signal: NodeJS.Signals) {
	for (const child of runningProcesses) {
		if (child.pid && child.exitCode === null) {
			try {
				process.kill(-child.pid, signal);
			} catch {
				// Process group may have already exited
			}
		}
	}
}

/**
 * Poll a health endpoint until it responds or timeout is reached.
 */
function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const start = Date.now();
		const interval = setInterval(() => {
			if (Date.now() - start > timeoutMs) {
				clearInterval(interval);
				resolve(false);
				return;
			}
			const req = http.get(`http://localhost:${port}/health`, (res) => {
				res.resume();
				if (res.statusCode === 200) {
					clearInterval(interval);
					resolve(true);
				}
			});
			req.on("error", () => {
				// Not ready yet, keep polling
			});
			req.setTimeout(1000, () => req.destroy());
		}, 500);
	});
}

export async function devProject(opts: OptionValues) {
	const currentPath = process.cwd();
	console.log("Starting the development server...");
	console.log("Current path: ", currentPath);

	// Read project runtime config
	const config = readProjectConfig(currentPath);

	// Collect runtime process definitions
	const runtimeDefs: Array<{
		cmd: string;
		args: string[];
		name: string;
		cwd?: string;
		env?: Record<string, string>;
		port?: number;
	}> = [];

	if (config?.runtimes) {
		for (const [, rt] of Object.entries(config.runtimes)) {
			const cmdParts = rt.startCmd.split(" ");
			const cmd = cmdParts[0];
			const args = cmdParts.slice(1);
			const runtimeCwd = path.resolve(currentPath, rt.cwd);

			if (!fsExtra.existsSync(runtimeCwd)) {
				console.log(`  Warning: ${rt.label} runtime directory not found at ${rt.cwd}. Skipping.`);
				continue;
			}

			runtimeDefs.push({
				cmd,
				args,
				name: `${rt.label} Runtime (port ${rt.port})`,
				cwd: runtimeCwd,
				env: {
					PORT: String(rt.port),
					HOST: "0.0.0.0",
				},
				port: rt.port,
			});
		}
	} else {
		// Legacy fallback: check for old-style Python3 setup
		const legacyPythonConfig = path.join(currentPath, ".blok", "runtimes", "python3", "nodemon.json");
		if (fsExtra.existsSync(legacyPythonConfig)) {
			runtimeDefs.push({
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

	// 1. Start all runtime processes
	const healthPorts: number[] = [];
	for (const def of runtimeDefs) {
		spawnProcess(def.cmd, def.args, def.name, currentPath, def.cwd, def.env);
		if (def.port) {
			healthPorts.push(def.port);
		}
	}

	// Show runtime health endpoints
	if (config?.runtimes && Object.keys(config.runtimes).length > 0) {
		console.log("\nRuntime health endpoints:");
		for (const [, rt] of Object.entries(config.runtimes)) {
			console.log(`  ${rt.label}: http://localhost:${rt.port}/health`);
		}
	}

	// 2. Wait for all runtimes to be healthy before starting NodeJS runner
	if (healthPorts.length > 0) {
		console.log("\nWaiting for runtimes to be ready...");
		const maxWait = 120_000; // 2 minutes (Rust can take a while to compile)
		const results = await Promise.all(healthPorts.map((port) => waitForHealth(port, maxWait)));
		const allReady = results.every(Boolean);
		if (allReady) {
			console.log("All runtimes ready.\n");
		} else {
			const failedPorts = healthPorts.filter((_, i) => !results[i]);
			console.log(`Warning: Some runtimes did not become healthy: ports ${failedPorts.join(", ")}`);
			console.log("Starting NodeJS runner anyway.\n");
		}
	}

	// 3. Start NodeJS runner last so its logs appear after all runtimes
	spawnProcess("npx", ["nodemon@3.1.9"], "NodeJS Runner", currentPath);

	// Keep the event loop alive — detached children don't prevent Node
	// from exiting, so without this the process would exit immediately
	// after devProject() returns, triggering the 'exit' handler which
	// would SIGKILL everything.
	const keepAlive = setInterval(() => {}, 60_000);

	let stopping = false;
	function shutdown() {
		if (stopping) return;
		stopping = true;
		console.log("\nStopping processes...");
		clearInterval(keepAlive);

		killAllGroups("SIGTERM");

		// Force-kill any remaining process groups after 3 seconds
		setTimeout(() => {
			killAllGroups("SIGKILL");
			process.exit(0);
		}, 3000);
	}

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// Safety net: SIGKILL all process groups synchronously on exit.
	// process.kill() is synchronous and works inside 'exit' handlers.
	process.on("exit", () => {
		killAllGroups("SIGKILL");
	});
}
