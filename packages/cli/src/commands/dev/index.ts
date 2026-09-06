import { type ChildProcess, spawn } from "node:child_process";
import child_process from "node:child_process";
import path from "node:path";
import util from "node:util";
import type { OptionValues } from "commander";
import fsExtra from "fs-extra";
import { findOccupiedGrpcPorts, waitForGrpcPort } from "../../services/health-probe.js";
import { detectJava, detectRr } from "../../services/runtime-detector.js";
import {
	generateCSharpNodeRegistry,
	generateDartNodeRegistry,
	generateGoNodeRegistry,
	generateJavaNodeRegistry,
	generateRustNodeRegistry,
	readProjectConfig,
	validateProjectRuntimes,
} from "../../services/runtime-setup.js";
import { regenRuntimeStubs } from "../nodes/syncNodes.js";
import { startDevWatcher } from "./watch.js";

/**
 * Resolve the HTTP-trigger port override for `blokctl dev`.
 *
 * Precedence: `--port` > an explicit `PORT` in the environment > (caller falls
 * back to the project config).
 *
 * Why this exists: the config port used to be passed as `PORT` on every spawn,
 * which OVERWROTE the operator's own `PORT`. And because an explicitly-passed
 * env var beats bun's dotenv loading, `.env.local`'s `PORT` lost too — so the
 * config value (4000 by default) always won and `blokctl dev` died with
 * "Failed to start server. Is port 4000 in use?" whenever 4000 was taken, with
 * no flag to work around it.
 *
 * Returns `{ port: undefined }` when nothing is set (use the config), or
 * `{ error }` for a non-numeric / out-of-range value.
 */
export function resolveDevPortOverride(
	flagPort: string | undefined,
	envPort: string | undefined,
): { port?: number; error?: string } {
	const raw = flagPort ?? envPort;
	if (raw === undefined || String(raw).trim() === "") return {};
	const port = Number(raw);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		return { error: `Invalid port "${raw}" — expected an integer between 1 and 65535.` };
	}
	return { port };
}

/**
 * Apply a port override to a single trigger. ONLY the HTTP trigger honours it —
 * forcing one port onto every trigger in a multi-trigger project would make them
 * collide on bind.
 */
export function resolveTriggerPort(trigger: { kind?: string; port: number }, override: number | undefined): number {
	return trigger.kind === "http" && override !== undefined ? override : trigger.port;
}

const exec = util.promisify(child_process.exec);

const runningProcesses: ChildProcess[] = [];

/**
 * Should `blokctl dev` fall back to running every trigger under `bun --watch`?
 *
 * Default is NO — a blanket `--watch` restarts the process on any source change
 * and preempts in-process HMR entirely, which is exactly the regression that
 * made consumers report "no hot reload". Kept as an explicit escape hatch for
 * anyone whose project depends on the old restart-everything behaviour.
 */
export function shouldWatchAll(opts: { watchAll?: unknown }): boolean {
	return opts.watchAll === true || process.env.BLOK_DEV_WATCH_ALL === "1";
}

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

/** Everything needed to respawn one trigger after a restart-class change. */
interface TriggerProcess {
	child: ChildProcess;
	readonly cmd: string;
	readonly args: string[];
	readonly name: string;
	readonly env: Record<string, string>;
}

/** SIGTERM a detached child's whole process group, then SIGKILL stragglers. */
function killGroup(child: ChildProcess): void {
	if (!child.pid || child.exitCode !== null) return;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		try {
			child.kill("SIGTERM");
		} catch {
			// already gone
		}
	}
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
 * After all sidecars are SERVING and the HTTP trigger is up, regenerate the
 * cross-runtime `runtimeNode` stubs from the live catalog (`GET /__blok/nodes`).
 * Reuses the `nodes sync` flow — same generator, same output dir.
 *
 * The trigger spawns async, so poll `/__blok/nodes` until it serves (bounded),
 * then regen ONCE. Best-effort: any failure (trigger never listened, catalog
 * fetch threw) logs a warning and returns — it never crashes the dev loop.
 *
 * ponytail: single regen after the trigger is reachable, not a per-sidecar
 * watcher; add incremental per-runtime regen if dynamic-lang hot-edits need it.
 */
async function regenStubsWhenReady(baseUrl: string, outDir: string, deadlineMs = 60_000): Promise<void> {
	const endpoint = `${baseUrl}/__blok/nodes`;
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		try {
			const res = await fetch(endpoint);
			if (res.ok) {
				const count = await regenRuntimeStubs(baseUrl, outDir);
				if (count > 0)
					console.log(`Regenerated ${count} runtime stub file(s) → ${path.relative(process.cwd(), outDir)}`);
				return;
			}
		} catch {
			// Trigger not listening yet — retry until the deadline.
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	console.log(`  Warning: stub regen skipped — ${endpoint} did not respond within ${deadlineMs / 1000}s.`);
}

export async function devProject(opts: OptionValues) {
	const currentPath = process.cwd();
	console.log("Starting the development server (transport=grpc)...");
	console.log("Current path: ", currentPath);

	// Read project runtime config
	const config = readProjectConfig(currentPath);

	const override = resolveDevPortOverride(opts.port as string | undefined, process.env.PORT);
	if (override.error) {
		throw new Error(override.error);
	}
	const portFor = (trigger: { kind?: string; port: number }): number => resolveTriggerPort(trigger, override.port);

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
			throw new Error("Runtime version requirements not met. Tip: use --skip-version-check to bypass this check.");
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

			// Same for Java: the macOS `/usr/bin/java` stub dies unless a JDK is
			// system-linked, while detection accepts brew's keg-only openjdk —
			// resolve the launcher the same way detection did.
			if (rt.kind === "java" && bootCmd.startsWith("java ")) {
				const javaBin = detectJava();
				if (javaBin && javaBin !== "java") {
					bootCmd = `${javaBin}${bootCmd.slice(4)}`;
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

			// Dynamic runtimes fs-scan this dir at boot (serve.py / serve.rb /
			// serve.php). The runtime cwd is .blok/runtimes/<lang>; user nodes
			// live in the project's runtimes/<lang>/nodes.
			if (rt.kind === "python3" || rt.kind === "ruby" || rt.kind === "php" || rt.kind === "dart") {
				env.BLOK_NODES_DIR = path.resolve(currentPath, "runtimes", rt.kind, "nodes");
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

			// Rust is compiled — regenerate the shim before `cargo run` recompiles.
			if (rt.kind === "rust") {
				try {
					generateRustNodeRegistry(currentPath);
				} catch (err) {
					console.log(`  Warning: Rust user-node codegen failed: ${(err as Error).message}`);
				}
			}

			// C# is compiled — regenerate the shim before `dotnet run` rebuilds.
			if (rt.kind === "csharp") {
				try {
					generateCSharpNodeRegistry(currentPath);
				} catch (err) {
					console.log(`  Warning: C# user-node codegen failed: ${(err as Error).message}`);
				}
			}

			if (rt.kind === "dart") {
				try {
					generateDartNodeRegistry(currentPath);
				} catch (err) {
					console.log(`  Warning: Dart user-node codegen failed: ${(err as Error).message}`);
				}
			}

			// Java boots a prebuilt jar (no recompile-on-boot like `go run`), so
			// codegen the shim AND `mvn package` before spawning.
			if (rt.kind === "java") {
				try {
					generateJavaNodeRegistry(currentPath);
					await exec("mvn package -q -DskipTests", { cwd: runtimeCwd, timeout: 300000 });
				} catch (err) {
					console.log(`  Warning: Java user-node codegen/build failed: ${(err as Error).message}`);
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

	// Never mistake somebody else's listener for a runtime we just spawned.
	const occupiedRuntimePorts = await findOccupiedGrpcPorts(
		runtimeDefs.flatMap((def) => (def.port === undefined ? [] : [def.port])),
	);
	if (occupiedRuntimePorts.length > 0) {
		throw new Error(
			`Runtime gRPC port(s) already in use: ${occupiedRuntimePorts.join(", ")}\nStop the existing runtime(s), or choose unused ports in .blok/config.json and .env.local.`,
		);
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
			} else if (trigger.kind === "cron") {
				// Cron is a portless scheduler — it binds no HTTP server, so a
				// /health-check URL would point at connection-refused.
				console.log(`  ${trigger.label}: scheduled (no HTTP endpoint)`);
			} else if (trigger.kind === "grpc") {
				// gRPC binds a port but speaks HTTP/2 gRPC (no GET /health-check).
				console.log(`  ${trigger.label}: gRPC 127.0.0.1:${trigger.port}`);
			} else {
				console.log(`  ${trigger.label}: http://localhost:${portFor(trigger)}/health-check`);
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

	// 2. Probe the runtimes in the BACKGROUND. Boot used to block here for up to
	// 2 minutes waiting on gRPC handshakes before a single HTTP request could be
	// served, so a project with a slow-compiling sidecar (Rust, Java) paid that
	// on every restart even for workflows that only use module nodes. The
	// adapters connect lazily on first use anyway (GrpcClientPool), so nothing
	// needed the wait — module-node workflows now serve immediately and
	// `runtime.*` steps fail loudly on their own if their sidecar never comes up.
	// IPv4/IPv6 TCP-connect probe lifted from the in-repo orchestrator
	// (scripts/dev-full.ts).
	const runtimesReady: Promise<boolean> =
		healthChecks.length === 0
			? Promise.resolve(true)
			: (async () => {
					console.log("\nProbing runtimes in the background (triggers start without waiting)...");
					const maxWait = 120_000; // 2 minutes (Rust can take a while to compile)
					const results = await Promise.all(healthChecks.map((hc) => waitForGrpcPort(hc.port, maxWait, hc.proc)));
					const failedPorts = healthChecks.filter((_, i) => !results[i]).map((hc) => hc.port);
					if (failedPorts.length === 0) {
						console.log("All runtimes ready.\n");
						return true;
					}
					console.log(
						`\n  Warning: runtime sidecar(s) on gRPC port ${failedPorts.join(", ")} never became healthy. Module-node workflows keep serving; \`runtime.*\` steps targeting those ports will fail until the sidecar starts.\n`,
					);
					return false;
				})();

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

	// 3. Start triggers from config, or fallback to single runner.
	//
	// NO `bun --watch` unless the operator explicitly asks for it. Watching
	// every app source restarts the process on any edit, which preempts the
	// in-process hot reloader entirely — the trigger sets BLOK_HMR=true and
	// owns `workflows/**` + `nodes/**` itself. The restart watcher below covers
	// the rest (entrypoints, `.env*`, config).
	const watchAll = shouldWatchAll(opts);
	const triggerProcesses: TriggerProcess[] = [];
	if (config?.triggers && Object.keys(config.triggers).length > 0) {
		console.log("Starting triggers...");
		for (const [, trigger] of Object.entries(config.triggers)) {
			const cmdParts = trigger.startCmd.split(" ");
			const cmd = cmdParts[0];
			const args = cmdParts.slice(1);
			if (watchAll && cmd === "bun" && !args.includes("--watch")) {
				args.unshift("--watch");
			}
			const triggerPort = portFor(trigger);
			const name = `${trigger.label} (port ${triggerPort})`;
			const env = { PORT: String(triggerPort), ...triggerEnv };
			const child = spawnProcess(cmd, args, name, currentPath, undefined, env);
			triggerProcesses.push({ child, cmd, args, name, env });
		}
	} else {
		// Legacy fallback: single trigger at src/index.ts
		const args = watchAll ? ["--watch", "run", "src/index.ts"] : ["run", "src/index.ts"];
		const child = spawnProcess("bun", args, "Blok Runner", currentPath, undefined, triggerEnv);
		triggerProcesses.push({ child, cmd: "bun", args, name: "Blok Runner", env: triggerEnv });
	}

	// 4. Once the HTTP trigger is listening (it serves GET /__blok/nodes),
	// regenerate the cross-runtime stubs from the now-live catalog. The HTTP
	// trigger is the one that exposes the catalog; only meaningful when there
	// are runtime sidecars to stub for. Fire-and-forget so it doesn't block the
	// keep-alive loop — failures warn and continue (never crash dev).
	const httpTrigger = config?.triggers?.http;
	const stubOutDir = path.join(currentPath, "nodes-gen");
	const httpBaseUrl = httpTrigger ? `http://localhost:${portFor(httpTrigger)}` : null;
	if (httpBaseUrl && healthChecks.length > 0) {
		// Chain off the background probe so the first regen sees a live catalog.
		void runtimesReady.then(() => regenStubsWhenReady(httpBaseUrl, stubOutDir));
	}

	// 5. The restart watcher — the half of the dev loop HMR can't do. Watches
	// trigger entrypoints, `.env*`, `.blok/config.json` (restart) and the
	// polyglot sidecar node dirs (regenerate stubs; closes the watcher-less TODO
	// that `regenStubsWhenReady` used to carry). Every action names the file and
	// the reason, so it's always visible which half of the loop handled a change.
	const triggerWatchPaths = [path.join(currentPath, "src", "triggers"), path.join(currentPath, "src", "index.ts")];
	const runtimeWatchPaths = Object.values(config?.runtimes ?? {}).map((rt) =>
		path.resolve(currentPath, "runtimes", rt.kind),
	);

	let restarting = false;
	const watcher = startDevWatcher({
		root: currentPath,
		triggerPaths: triggerWatchPaths,
		runtimePaths: runtimeWatchPaths,
		onRestart: (file, reason) => {
			if (restarting) return;
			restarting = true;
			const rel = path.relative(currentPath, file) || file;
			console.log(`\n  [dev] restart · ${rel} — ${reason}`);
			for (const proc of triggerProcesses) {
				killGroup(proc.child);
				const index = runningProcesses.indexOf(proc.child);
				if (index !== -1) runningProcesses.splice(index, 1);
			}
			// Give the old process group a beat to release its port before the
			// replacement binds it.
			setTimeout(() => {
				for (const proc of triggerProcesses) {
					proc.child = spawnProcess(proc.cmd, proc.args, proc.name, currentPath, undefined, proc.env);
				}
				restarting = false;
			}, 300);
		},
		onRegen: (file, reason) => {
			const rel = path.relative(currentPath, file) || file;
			console.log(`\n  [dev] regen · ${rel} — ${reason}`);
			if (!httpBaseUrl) return;
			void regenRuntimeStubs(httpBaseUrl, stubOutDir)
				.then((count) => {
					if (count > 0) console.log(`  [dev] regenerated ${count} runtime stub file(s)`);
				})
				.catch((err: unknown) => {
					console.log(`  [dev] stub regen failed: ${err instanceof Error ? err.message : String(err)}`);
				});
		},
	});

	console.log(
		watchAll
			? "\n  [dev] --watch-all: every trigger runs under `bun --watch` (full restart on any source change; in-process HMR is preempted)."
			: "\n  [dev] hot reload owns workflows/** and nodes/**; entrypoints, .env* and .blok/config.json restart. Use --watch-all to restart on everything.",
	);

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
		watcher.stop();

		killAllGroups("SIGTERM");

		// Force-kill any remaining process groups after 3 seconds.
		// KEEP the process.exit here (#899 allow-list): this is the terminal step
		// of a SIGINT/SIGTERM handler for a long-running server. `keepAlive` and
		// the detached children can hold the loop open past the sweep, so the
		// signal would otherwise not actually stop `blokctl dev`.
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
