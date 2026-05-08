import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import type { OptionValues } from "commander";
import fsExtra from "fs-extra";
import { waitForGrpcPort } from "../../services/health-probe.js";
import { detectRr } from "../../services/runtime-detector.js";
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
 * Poll an HTTP `/health` endpoint until it responds, the process exits, or
 * timeout. Used only on the `--with-http-fallback` path.
 *
 * Resolves false fast when the owning process exits — prevents hanging the
 * full timeout when an SDK crashes during boot.
 */
function waitForHttpHealth(port: number, timeoutMs: number, proc?: ChildProcess): Promise<boolean> {
	return new Promise((resolve) => {
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
	const useHttpFallback = opts.withHttpFallback === true;
	const transport = useHttpFallback ? "http" : "grpc";
	console.log(`Starting the development server (transport=${transport})...`);
	console.log("Current path: ", currentPath);
	if (useHttpFallback) {
		console.log("  ⚠ --with-http-fallback is deprecated and will be removed in v0.4.0.");
	}

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

	// Collect runtime process definitions. `port` here is the port the CLI
	// health-probes after spawn — gRPC port when transport=grpc, HTTP port
	// otherwise.
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
			// Pick the boot command. PHP has a separate `grpcStartCmd`
			// because RoadRunner is its gRPC server (not the same binary
			// as `php bin/serve.php`). For all other SDKs the regular
			// `startCmd` boots both transports — `BLOK_TRANSPORT=grpc` in
			// the env tells the SDK to advertise gRPC as primary.
			let bootCmd = useHttpFallback ? rt.startCmd : (rt.grpcStartCmd ?? rt.startCmd);

			// Resolve the literal `rr` token in PHP's grpcStartCmd to a
			// real path if RoadRunner isn't on $PATH. Mirrors the
			// detectRr() resolve in scripts/dev-full.ts so PHP detection
			// stays in lock-step between `bun dev` and `blokctl dev`.
			if (rt.kind === "php" && !useHttpFallback && bootCmd.startsWith("rr ")) {
				const rrBin = detectRr();
				if (rrBin && rrBin !== "rr") {
					bootCmd = `${rrBin}${bootCmd.slice(2)}`;
				}
			}

			const cmdParts = bootCmd.split(" ");
			const cmd = cmdParts[0];
			const args = cmdParts.slice(1);
			const runtimeCwd = path.resolve(currentPath, rt.cwd);

			if (!fsExtra.existsSync(runtimeCwd)) {
				console.log(`  Warning: ${rt.label} runtime directory not found at ${rt.cwd}. Skipping.`);
				continue;
			}

			// gRPC port falls back to (httpPort + 1000) for old config.json
			// shapes that predate the Phase 7 grpcPort field. Matches the
			// HTTP+1000 convention everywhere else in the repo.
			const grpcPort = rt.grpcPort ?? rt.port + 1000;
			const probePort = useHttpFallback ? rt.port : grpcPort;

			const env: Record<string, string> = {
				PORT: String(rt.port),
				GRPC_PORT: String(grpcPort),
				HOST: "0.0.0.0",
				BLOK_TRANSPORT: transport,
			};

			runtimeDefs.push({
				cmd,
				args,
				name: `${rt.label} Runtime (${transport} port ${probePort})`,
				cwd: runtimeCwd,
				env,
				port: probePort,
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

	// Show trigger endpoints
	if (config?.triggers && Object.keys(config.triggers).length > 0) {
		console.log("\nTrigger endpoints:");
		for (const [, trigger] of Object.entries(config.triggers)) {
			console.log(`  ${trigger.label}: http://localhost:${trigger.port}/health-check`);
		}
	}

	// Show runtime listeners. gRPC is not browser-pingable (binary protocol);
	// HTTP path keeps the curl-able URL for debugging.
	if (config?.runtimes && Object.keys(config.runtimes).length > 0) {
		console.log("\nRuntime listeners:");
		for (const [, rt] of Object.entries(config.runtimes)) {
			if (useHttpFallback) {
				console.log(`  ${rt.label}: http://localhost:${rt.port}/health`);
			} else {
				const grpcPort = rt.grpcPort ?? rt.port + 1000;
				console.log(`  ${rt.label}: gRPC 127.0.0.1:${grpcPort}`);
			}
		}
	}

	// 2. Wait for all runtimes to be healthy before starting NodeJS runner.
	// gRPC path uses the IPv4/IPv6 TCP-connect probe lifted from the
	// in-repo orchestrator (scripts/dev-full.ts). HTTP fallback keeps the
	// `/health` endpoint poll.
	if (healthChecks.length > 0) {
		console.log("\nWaiting for runtimes to be ready...");
		const maxWait = 120_000; // 2 minutes (Rust can take a while to compile)
		const results = await Promise.all(
			healthChecks.map((hc) =>
				useHttpFallback ? waitForHttpHealth(hc.port, maxWait, hc.proc) : waitForGrpcPort(hc.port, maxWait, hc.proc),
			),
		);
		const allReady = results.every(Boolean);
		if (allReady) {
			console.log("All runtimes ready.\n");
		} else {
			const failedPorts = healthChecks.filter((_, i) => !results[i]).map((hc) => hc.port);
			console.log(`Warning: Some runtimes did not become healthy: ports ${failedPorts.join(", ")}`);
			console.log("Starting NodeJS runner anyway.\n");
		}
	}

	// Phase: ship-with-CLI persistence. Default to SQLite at
	// `.blok/trace.db` so users get Prisma-Studio-style "open the
	// project, see all your runs" durability without configuration.
	// Users who explicitly set BLOK_TRACE_STORE=memory or set their
	// own SQLITE_PATH win — we only fill in the defaults if absent.
	// The directory is auto-created by `createStore` when the file is
	// first opened.
	const traceEnv: Record<string, string> = {};
	if (!process.env.BLOK_TRACE_STORE) {
		traceEnv.BLOK_TRACE_STORE = "sqlite";
	}
	if (!process.env.BLOK_TRACE_SQLITE_PATH) {
		traceEnv.BLOK_TRACE_SQLITE_PATH = path.join(".blok", "trace.db");
	}

	// Trigger env: thread BLOK_TRANSPORT so the trigger's embedded runner
	// picks the same transport the SDKs are listening on. Without this the
	// trigger would resolve transport from process.env (which the user may
	// have set to something else); explicit threading keeps `blokctl dev`
	// authoritative over the spawn graph.
	const triggerEnv: Record<string, string> = {
		...traceEnv,
		BLOK_TRANSPORT: transport,
	};

	// 3. Start triggers from config, or fallback to single runner
	if (config?.triggers && Object.keys(config.triggers).length > 0) {
		console.log("Starting triggers...");
		for (const [, trigger] of Object.entries(config.triggers)) {
			const cmdParts = trigger.startCmd.split(" ");
			const cmd = cmdParts[0];
			const args = cmdParts.slice(1);
			// Add --watch for development
			if (cmd === "bun" && !args.includes("--watch")) {
				args.unshift("--watch");
			}
			spawnProcess(cmd, args, `${trigger.label} (port ${trigger.port})`, currentPath, undefined, {
				PORT: String(trigger.port),
				...triggerEnv,
			});
		}
	} else {
		// Legacy fallback: single trigger at src/index.ts
		spawnProcess("bun", ["--watch", "run", "src/index.ts"], "Blok Runner", currentPath, undefined, triggerEnv);
	}

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
