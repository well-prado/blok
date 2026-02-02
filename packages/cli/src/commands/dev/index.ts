import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import type { OptionValues } from "commander";
import fsExtra from "fs-extra";
import { readProjectConfig, validateProjectRuntimes } from "../../services/runtime-setup.js";

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
 * Kill all process groups. Uses the system `kill` command with negative PID
 * to terminate entire process trees (child + all its descendants).
 * This approach is compatible with both Node.js and Bun runtimes.
 */
function killAllGroups(signal: NodeJS.Signals) {
	const sig = signal === "SIGKILL" ? "9" : "15";
	for (const child of runningProcesses) {
		if (child.pid && child.exitCode === null) {
			try {
				spawn("kill", [`-${sig}`, "--", `-${child.pid}`], { stdio: "ignore" });
			} catch {
				// Fallback: kill individual process
				try {
					child.kill(signal);
				} catch {
					// Process may have already exited
				}
			}
		}
	}
}

/**
 * Poll a health endpoint until it responds, the process exits, or timeout.
 * If the owning process exits (e.g. Ruby crashes), resolve immediately
 * instead of waiting the full timeout.
 */
function waitForHealth(port: number, timeoutMs: number, proc?: ChildProcess): Promise<boolean> {
	return new Promise((resolve) => {
		// Process already exited — fail immediately
		if (proc && proc.exitCode !== null) {
			resolve(false);
			return;
		}

		const start = Date.now();
		let done = false;

		function finish(result: boolean) {
			if (done) return;
			done = true;
			clearInterval(interval);
			resolve(result);
		}

		// Abort early if the runtime process dies
		proc?.on("exit", () => finish(false));

		const interval = setInterval(() => {
			if (done) return;
			if (Date.now() - start > timeoutMs) {
				finish(false);
				return;
			}
			const req = http.get(`http://localhost:${port}/health`, (res) => {
				res.resume();
				if (res.statusCode === 200) finish(true);
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

	// Validate runtime versions unless --skip-version-check is set
	const skipVersionCheck = opts.skipVersionCheck === true;
	const validationResults = await validateProjectRuntimes(currentPath);

	if (validationResults.length > 0) {
		const failures = validationResults.filter((r) => !r.satisfied);
		const successes = validationResults.filter((r) => r.satisfied);

		if (failures.length > 0 && !skipVersionCheck) {
			console.error("\n  Runtime version requirements not met:\n");
			for (const f of failures) {
				console.error(f.message);
				console.error();
			}
			console.error("  Tip: Use --skip-version-check to bypass this check.\n");
			process.exit(1);
		}

		// Print version check results
		if (failures.length > 0 && skipVersionCheck) {
			console.log("\n  Runtime version warnings:");
			for (const f of failures) {
				console.log(`  ! ${f.label}  ${f.found || "not installed"} (requires ${f.required}) — SKIPPED`);
			}
		}

		if (successes.length > 0) {
			if (failures.length === 0) console.log("\n  Runtime version check:");
			for (const s of successes) {
				console.log(s.message);
			}
		}
		console.log();
	}

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
	const healthChecks: Array<{ port: number; proc: ChildProcess }> = [];
	for (const def of runtimeDefs) {
		const child = spawnProcess(def.cmd, def.args, def.name, currentPath, def.cwd, def.env);
		if (def.port) {
			healthChecks.push({ port: def.port, proc: child });
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
	if (healthChecks.length > 0) {
		console.log("\nWaiting for runtimes to be ready...");
		const maxWait = 120_000; // 2 minutes (Rust can take a while to compile)
		const results = await Promise.all(healthChecks.map((hc) => waitForHealth(hc.port, maxWait, hc.proc)));
		const allReady = results.every(Boolean);
		if (allReady) {
			console.log("All runtimes ready.\n");
		} else {
			const failedPorts = healthChecks.filter((_, i) => !results[i]).map((hc) => hc.port);
			console.log(`Warning: Some runtimes did not become healthy: ports ${failedPorts.join(", ")}`);
			console.log("Starting NodeJS runner anyway.\n");
		}
	}

	// 3. Start Blok runner last so its logs appear after all runtimes
	spawnProcess("bun", ["--watch", "run", "src/index.ts"], "Blok Runner", currentPath);

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
