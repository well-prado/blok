import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import type { OptionValues } from "commander";
import fsExtra from "fs-extra";
import { waitForGrpcPort } from "../../services/health-probe.js";
import { detectRr } from "../../services/runtime-detector.js";
import { generateGoNodeRegistry, readProjectConfig, validateProjectRuntimes } from "../../services/runtime-setup.js";

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

export async function devProject(opts: OptionValues) {
	const currentPath = process.cwd();
	console.log("Starting the development server (transport=grpc)...");
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

	// Collect runtime process definitions. `port` here is the gRPC port the
	// CLI health-probes after spawn (TCP connect check).
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
			// Pick the gRPC boot command. PHP uses a separate `grpcStartCmd`
			// (RoadRunner) — every other SDK's `startCmd` boots gRPC directly.
			let bootCmd = rt.grpcStartCmd ?? rt.startCmd;

			// Resolve the literal `rr` token in PHP's grpcStartCmd to a
			// real path if RoadRunner isn't on $PATH. Mirrors the
			// detectRr() resolve in scripts/dev-full.ts so PHP detection
			// stays in lock-step between `bun dev` and `blokctl dev`.
			if (rt.kind === "php" && bootCmd.startsWith("rr ")) {
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
			// shapes that predate the Phase 7 grpcPort field.
			const grpcPort = rt.grpcPort ?? rt.port + 1000;

			const env: Record<string, string> = {
				PORT: String(rt.port),
				GRPC_PORT: String(grpcPort),
				HOST: "0.0.0.0",
				BLOK_TRANSPORT: "grpc",
			};

			// Python discovers user nodes from this dir at boot (serve.py). The
			// runtime cwd is .blok/runtimes/python3; user nodes live in the
			// project's runtimes/python3/nodes.
			if (rt.kind === "python3") {
				env.BLOK_NODES_DIR = path.resolve(currentPath, "runtimes", "python3", "nodes");
			}

			// Go is compiled — regenerate the user-node registration shim before
			// `go run ./cmd/server` recompiles and picks it up. Best-effort: a
			// codegen failure shouldn't block the rest of the dev stack.
			if (rt.kind === "go") {
				try {
					generateGoNodeRegistry(currentPath);
				} catch (err) {
					console.log(`  Warning: Go user-node codegen failed: ${(err as Error).message}`);
				}
			}

			runtimeDefs.push({
				cmd,
				args,
				name: `${rt.label} Runtime (grpc port ${grpcPort})`,
				cwd: runtimeCwd,
				env,
				port: grpcPort,
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

	// Show trigger endpoints. Broker-consumer triggers (worker/queue/pubsub)
	// never bind an HTTP port — they consume from a broker — so printing a
	// /health-check URL for them points at nothing (connection-refused).
	if (config?.triggers && Object.keys(config.triggers).length > 0) {
		const brokerConsumerKinds = new Set(["worker", "queue", "pubsub"]);
		console.log("\nTrigger endpoints:");
		for (const [, trigger] of Object.entries(config.triggers)) {
			if (brokerConsumerKinds.has(trigger.kind)) {
				console.log(`  ${trigger.label}: consumes from broker (no HTTP endpoint)`);
			} else {
				console.log(`  ${trigger.label}: http://localhost:${trigger.port}/health-check`);
			}
		}
	}

	// Show runtime listeners. gRPC is binary, so the host:port is what
	// operators wire into client tools.
	if (config?.runtimes && Object.keys(config.runtimes).length > 0) {
		console.log("\nRuntime listeners:");
		for (const [, rt] of Object.entries(config.runtimes)) {
			const grpcPort = rt.grpcPort ?? rt.port + 1000;
			console.log(`  ${rt.label}: gRPC 127.0.0.1:${grpcPort}`);
		}
	}

	// 2. Wait for all runtimes to be healthy before starting NodeJS runner.
	// IPv4/IPv6 TCP-connect probe lifted from the in-repo orchestrator
	// (scripts/dev-full.ts).
	if (healthChecks.length > 0) {
		console.log("\nWaiting for runtimes to be ready...");
		const maxWait = 120_000; // 2 minutes (Rust can take a while to compile)
		const results = await Promise.all(healthChecks.map((hc) => waitForGrpcPort(hc.port, maxWait, hc.proc)));
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

	// Trigger env: thread BLOK_TRANSPORT=grpc so the trigger's embedded
	// runner advertises the same transport the SDKs listen on. Explicit
	// threading keeps `blokctl dev` authoritative over the spawn graph
	// even when the operator's shell env has stale values.
	const triggerEnv: Record<string, string> = {
		...traceEnv,
		BLOK_TRANSPORT: "grpc",
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
