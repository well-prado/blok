/**
 * One-command dev orchestrator — spawns every runtime SDK over gRPC plus
 * the HTTP trigger and waits. Designed for the "I want to run the
 * project the way a real user would" path that `blokctl dev` covers
 * for generated projects, except this one targets the in-repo
 * `triggers/http` workspace directly so workflow authors can iterate
 * without bootstrapping a new project.
 *
 * Usage (this repo runs on bun, not pnpm):
 *   bun run dev                  # spawn everything, logs multiplexed
 *   bun run dev -- --no-php      # skip PHP (RoadRunner not installed)
 *   bun run dev -- --only=python3,go,rust   # subset
 *
 * What gets spawned:
 *
 *   - Every SDK in `sdks/<lang>` whose toolchain is detected,
 *     listening on the master plan §12 port pair (HTTP <BASE>, gRPC
 *     <BASE>+1000):
 *       go      → 9001 / 10001
 *       rust    → 9002 / 10002
 *       java    → 9003 / 10003
 *       csharp  → 9004 / 10004
 *       php     → 9005 / 10005   (via RoadRunner, opt-out)
 *       ruby    → 9006 / 10006
 *       python3 → 9007 / 10007
 *
 *   - The trigger HTTP server in `triggers/http` on port 4000 (default
 *     `.env` value). With the Phase 6 default flip, runtime nodes
 *     dispatch to gRPC automatically — no env override needed.
 *
 * Once everything is healthy the script prints a ready banner with the
 * curl command for `cross-runtime-chain.json` and stays in foreground
 * until Ctrl-C, killing every child cleanly.
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Socket } from "node:net";
import path from "node:path";

// =============================================================================
// CLI flags
// =============================================================================

const argv = process.argv.slice(2);
const FLAG_NO_PHP = argv.includes("--no-php");
const FLAG_QUIET = argv.includes("--quiet");
const ONLY_FLAG = argv.find((a) => a.startsWith("--only="));
const ONLY_KINDS: Set<string> | null = ONLY_FLAG
	? new Set(
			ONLY_FLAG.replace("--only=", "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		)
	: null;

const REPO_ROOT = path.resolve(__dirname, "..");

// =============================================================================
// Per-SDK profiles — what to spawn, where, with what env
// =============================================================================
//
// Each profile carries:
//   - id        : the kind matched by `--only=<id>` and printed in the prefix
//   - label     : pretty colored prefix used in multiplexed log lines
//   - httpPort  : SDK's HTTP listener (the trigger reads
//                 RUNTIME_<KIND>_PORT from this; matters for the legacy
//                 HTTP fallback only — Phase 6 routes through gRPC)
//   - grpcPort  : SDK's gRPC listener (the trigger reads
//                 RUNTIME_<KIND>_GRPC_PORT from this)
//   - detect    : sync toolchain check; missing toolchains are skipped
//                 with a yellow note (not a hard fail)
//   - cmd       : the executable to spawn
//   - args      : args passed to the executable
//   - cwd       : working directory for the spawn
//   - env       : env passed to the child (each SDK has its own env
//                 contract — Python wants PORT/GRPC_PORT/BLOK_TRANSPORT,
//                 Rust wants ENABLE_GRPC=true, Java wants
//                 BLOK_TRANSPORT=grpc, …)
//
// The trigger env is computed AFTER profiles are filtered (so we set
// `RUNTIME_<KIND>_*` only for kinds we actually started).

interface RuntimeProfile {
	readonly id: string;
	readonly envKey: string; // e.g. "GO", "PYTHON3", "CSHARP" — matches RUNTIME_<KEY>_GRPC_PORT
	readonly label: string;
	readonly color: string;
	readonly httpPort: number;
	readonly grpcPort: number;
	readonly detect: () => boolean;
	readonly buildHint?: string; // surfaced when detect returns false
	readonly spawn: () => ChildProcess;
}

function detectFile(p: string): boolean {
	return existsSync(p);
}

function detectCmd(cmd: string, args: string[] = ["--version"]): boolean {
	try {
		execSync([cmd, ...args].join(" "), { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function detectPython3(): boolean {
	try {
		execSync(`python3 -c "import grpc; from blok.runtime.v1 import runtime_pb2"`, {
			cwd: path.join(REPO_ROOT, "sdks/python3"),
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

function detectRuby(): string | null {
	for (const bin of ["/opt/homebrew/opt/ruby@3.3/bin/ruby", "/opt/homebrew/opt/ruby/bin/ruby", "ruby"]) {
		try {
			execSync(`${bin} -e "exit 1 unless RUBY_VERSION.split('.').first.to_i >= 3"`, { stdio: "ignore" });
			execSync(`${bin} -e "require 'grpc'"`, { stdio: "ignore" });
			return bin;
		} catch {
			// keep trying
		}
	}
	return null;
}

function detectJava(): string | null {
	for (const bin of ["/opt/homebrew/opt/openjdk@21/bin/java", "/usr/lib/jvm/openjdk-21/bin/java", "java"]) {
		try {
			execSync(`${bin} -version`, { stdio: "ignore" });
			return bin;
		} catch {
			// keep trying
		}
	}
	return null;
}

function detectRr(): string | null {
	for (const bin of ["/opt/homebrew/bin/rr", "rr"]) {
		try {
			execSync(`${bin} --version`, { stdio: "ignore" });
			return bin;
		} catch {
			// keep trying
		}
	}
	return null;
}

const ALL_PROFILES: RuntimeProfile[] = [
	{
		id: "go",
		envKey: "GO",
		label: "go",
		color: "\x1b[36m",
		httpPort: 9001,
		grpcPort: 10001,
		buildHint: "cd sdks/go && go build -o bin/blok ./cmd/server",
		detect: () => detectFile(path.join(REPO_ROOT, "sdks/go/bin/blok")),
		spawn: () =>
			spawn(path.join(REPO_ROOT, "sdks/go/bin/blok"), [], {
				env: {
					...process.env,
					PORT: "9001",
					GRPC_PORT: "10001",
					BLOK_TRANSPORT: "grpc",
					HOST: "127.0.0.1",
					LOG_LEVEL: "INFO",
				},
			}),
	},
	{
		id: "rust",
		envKey: "RUST",
		label: "rust",
		color: "\x1b[35m",
		httpPort: 9002,
		grpcPort: 10002,
		buildHint: "cd sdks/rust && cargo build --features grpc",
		detect: () => detectFile(path.join(REPO_ROOT, "sdks/rust/target/debug/blok")),
		spawn: () =>
			spawn(path.join(REPO_ROOT, "sdks/rust/target/debug/blok"), [], {
				env: {
					...process.env,
					PORT: "9002",
					GRPC_PORT: "10002",
					ENABLE_GRPC: "true",
					HOST: "127.0.0.1",
					LOG_LEVEL: "INFO",
					RUST_LOG: "info",
				},
			}),
	},
	{
		id: "java",
		envKey: "JAVA",
		label: "java",
		color: "\x1b[33m",
		httpPort: 9003,
		grpcPort: 10003,
		buildHint:
			'cd sdks/java && JAVA_HOME=/opt/homebrew/opt/openjdk@21 PATH="$JAVA_HOME/bin:$PATH" mvn package -DskipTests',
		detect: () => detectJava() !== null && existsSync(path.join(REPO_ROOT, "sdks/java/target/blok-java-1.0.0.jar")),
		spawn: () => {
			const javaBin = detectJava();
			if (!javaBin) throw new Error("java disappeared between detect and spawn");
			return spawn(javaBin, ["-jar", path.join(REPO_ROOT, "sdks/java/target/blok-java-1.0.0.jar")], {
				env: {
					...process.env,
					PORT: "9003",
					GRPC_PORT: "10003",
					BLOK_TRANSPORT: "grpc",
					HOST: "127.0.0.1",
					LOG_LEVEL: "INFO",
				},
			});
		},
	},
	{
		id: "csharp",
		envKey: "CSHARP",
		label: "csharp",
		color: "\x1b[34m",
		httpPort: 9004,
		grpcPort: 10004,
		buildHint:
			"cd sdks/csharp && dotnet publish src/Blok.Core/Blok.Core.csproj -c Release -o bin/release --self-contained false",
		detect: () => detectFile(path.join(REPO_ROOT, "sdks/csharp/bin/release/Blok.Core.dll")),
		spawn: () =>
			spawn("dotnet", [path.join(REPO_ROOT, "sdks/csharp/bin/release/Blok.Core.dll")], {
				env: {
					...process.env,
					PORT: "9004",
					GRPC_PORT: "10004",
					BLOK_TRANSPORT: "grpc",
					HOST: "127.0.0.1",
					LOG_LEVEL: "INFO",
					// Silence ASP.NET's per-request trace lines
					// ("Executing endpoint…", "Request finished…").
					// ASP.NET env-var convention: `__` replaces the
					// `:` config delimiter, but dots inside category
					// names are preserved literally — so the env key is
					// `Logging__LogLevel__Microsoft.AspNetCore`, NOT
					// `Logging__LogLevel__Microsoft_AspNetCore`.
					// Without these overrides every gRPC call prints
					// 4 INFO lines that drown the trigger logs in dev.
					// We keep `Default = Warning` so the C# SDK's own
					// startup banner (logged at Information by user
					// code) still surfaces.
					Logging__LogLevel__Default: "Warning",
					"Logging__LogLevel__Microsoft.AspNetCore": "Warning",
					"Logging__LogLevel__Microsoft.AspNetCore.Hosting": "Warning",
					"Logging__LogLevel__Microsoft.AspNetCore.Routing": "Warning",
				},
			}),
	},
	{
		id: "php",
		envKey: "PHP",
		label: "php",
		color: "\x1b[95m",
		httpPort: 9005,
		grpcPort: 10005,
		buildHint: "brew install protobuf grpc roadrunner && cd sdks/php && composer install",
		detect: () => {
			if (FLAG_NO_PHP) return false;
			return (
				detectRr() !== null &&
				detectCmd("php") &&
				existsSync(path.join(REPO_ROOT, "sdks/php/.rr.yaml")) &&
				existsSync(path.join(REPO_ROOT, "sdks/php/vendor/autoload.php"))
			);
		},
		spawn: () => {
			const rr = detectRr();
			if (!rr) throw new Error("rr disappeared between detect and spawn");
			return spawn(rr, ["serve", "-c", ".rr.yaml", "--override", "grpc.listen=tcp://127.0.0.1:10005"], {
				cwd: path.join(REPO_ROOT, "sdks/php"),
				env: {
					...process.env,
					GRPC_PORT: "10005",
					HOST: "127.0.0.1",
				},
			});
		},
	},
	{
		id: "ruby",
		envKey: "RUBY",
		label: "ruby",
		color: "\x1b[31m",
		httpPort: 9006,
		grpcPort: 10006,
		buildHint:
			"brew install ruby@3.3 && /opt/homebrew/opt/ruby@3.3/bin/gem install grpc grpc-tools sinatra puma rackup --user-install",
		detect: () => detectRuby() !== null && existsSync(path.join(REPO_ROOT, "sdks/ruby/bin/serve.rb")),
		spawn: () => {
			const rubyBin = detectRuby();
			if (!rubyBin) throw new Error("ruby disappeared between detect and spawn");
			return spawn(rubyBin, [path.join(REPO_ROOT, "sdks/ruby/bin/serve.rb")], {
				env: {
					...process.env,
					PORT: "9006",
					GRPC_PORT: "10006",
					BLOK_TRANSPORT: "grpc",
					HOST: "127.0.0.1",
					LOG_LEVEL: "INFO",
				},
			});
		},
	},
	{
		id: "python3",
		envKey: "PYTHON3",
		label: "python",
		color: "\x1b[32m",
		httpPort: 9007,
		grpcPort: 10007,
		buildHint:
			"cd sdks/python3 && pip install -e '.[grpc]' && python -m grpc_tools.protoc -I=../../proto --python_out=blok/runtime/v1 --grpc_python_out=blok/runtime/v1 ../../proto/blok/runtime/v1/runtime.proto",
		detect: () => detectPython3() && existsSync(path.join(REPO_ROOT, "sdks/python3/bin/serve.py")),
		spawn: () =>
			spawn("python3", [path.join(REPO_ROOT, "sdks/python3/bin/serve.py")], {
				cwd: path.join(REPO_ROOT, "sdks/python3"),
				env: {
					...process.env,
					PORT: "9007",
					GRPC_PORT: "10007",
					BLOK_TRANSPORT: "grpc",
					HOST: "127.0.0.1",
					LOG_LEVEL: "INFO",
					PYTHONUNBUFFERED: "1",
				},
			}),
	},
];

// =============================================================================
// Trigger HTTP server profile — a "fake" runtime that runs `bun run http:dev`
// =============================================================================

const TRIGGER_PORT = 4000;
const TRIGGER_LABEL = "trigger";
const TRIGGER_COLOR = "\x1b[97m"; // bright white

// =============================================================================
// Studio dev server — Vite SPA on port 5555 with /__blok proxy to the runner
// =============================================================================
//
// Studio is a separate React SPA at `apps/studio` whose Vite config
// (apps/studio/vite.config.ts) sets `server.port = 5555` and proxies
// `/__blok` to `http://localhost:4000`. So once the trigger is up,
// `bun run --filter @blokjs/studio dev` brings up the Vite server
// and the browser's `/__blok/runs` calls land on the trigger via
// the proxy.
//
// Detection: bun workspaces hoist `vite` to the root
// `node_modules/.bin/vite`. We spawn Studio via `bun run --filter
// @blokjs/studio dev`, which delegates to vite from wherever bun
// resolves it. If `apps/studio` isn't installed (e.g. fresh clone
// without `bun install`) the spawn will fail and we surface a
// hint; the trigger + SDKs still run, just no pretty UI.

const STUDIO_PORT = 5555;
const STUDIO_LABEL = "studio";
const STUDIO_COLOR = "\x1b[96m"; // bright cyan
const STUDIO_PACKAGE_JSON = path.join(REPO_ROOT, "apps/studio/package.json");

// =============================================================================
// Multiplexed log piping
// =============================================================================

const COLOR_RESET = "\x1b[0m";

function pipe(child: ChildProcess, label: string, color: string): void {
	const prefix = `${color}[${label.padEnd(8)}]${COLOR_RESET} `;
	const onChunk = (stream: NodeJS.WriteStream) => (data: Buffer) => {
		const text = data.toString("utf8");
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			// Don't prepend prefix to the trailing empty line that
			// follows a final newline.
			if (line === "" && i === lines.length - 1) continue;
			stream.write(`${prefix}${line}\n`);
		}
	};
	child.stdout?.on("data", onChunk(process.stdout));
	child.stderr?.on("data", onChunk(process.stderr));
}

// =============================================================================
// Health probe
// =============================================================================

/**
 * TCP-connect health probe — works for both gRPC and HTTP listeners.
 *
 * Tries IPv4 (`127.0.0.1`), then IPv6 loopback (`::1`) on each tick.
 * Vite's "Local: http://localhost:5555/" log line resolves to whichever
 * `localhost` your OS prefers — on macOS that can be IPv6 only, which
 * fails an IPv4-only probe and surfaces as a spurious "did not bind
 * within 30s" warning even though the server is happily listening.
 * Probing both address families closes that gap.
 */
function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = new Socket();
		const done = (ok: boolean) => {
			sock.destroy();
			resolve(ok);
		};
		sock.setTimeout(timeoutMs);
		sock
			.once("connect", () => done(true))
			.once("timeout", () => done(false))
			.once("error", () => done(false));
		sock.connect(port, host);
	});
}

async function waitForPort(port: number, timeoutMs = 30_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await tryConnect("127.0.0.1", port, 500)) return true;
		if (await tryConnect("::1", port, 500)) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

// =============================================================================
// Runner
// =============================================================================

async function main() {
	console.log(`${TRIGGER_COLOR}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLOR_RESET}`);
	console.log(`${TRIGGER_COLOR} Blok dev orchestrator — gRPC by default (Phase 6)${COLOR_RESET}`);
	console.log(`${TRIGGER_COLOR}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLOR_RESET}`);

	// Pick which profiles to run.
	const selected = ALL_PROFILES.filter((p) => {
		if (ONLY_KINDS && !ONLY_KINDS.has(p.id)) return false;
		return true;
	});

	const runnable: RuntimeProfile[] = [];
	const skipped: { profile: RuntimeProfile; reason: string }[] = [];

	for (const p of selected) {
		if (p.detect()) {
			runnable.push(p);
		} else {
			skipped.push({ profile: p, reason: "toolchain not detected" });
		}
	}

	if (runnable.length === 0) {
		console.error("\nNo runnable SDKs detected. Build at least one before running dev.");
		console.error("Build hints:");
		for (const p of selected) {
			if (p.buildHint) console.error(`  ${p.id.padEnd(8)} → ${p.buildHint}`);
		}
		process.exit(1);
	}

	console.log("\nRunnable SDKs:");
	for (const p of runnable) {
		console.log(`  ${p.color}${p.label.padEnd(8)}${COLOR_RESET}  http=${p.httpPort}  grpc=${p.grpcPort}`);
	}
	if (skipped.length > 0) {
		console.log("\nSkipped (build first if you want them):");
		for (const { profile, reason } of skipped) {
			console.log(`  ${profile.label.padEnd(8)}  ${reason}`);
			if (profile.buildHint) console.log(`            ${profile.buildHint}`);
		}
	}

	// =========================================================================
	// Pre-build core packages so trigger-http boots against current `dist/`
	// =========================================================================
	//
	// The trigger imports `@blokjs/runner`, `@blokjs/helper`, `@blokjs/shared`
	// from their `dist/` folders (the workspace symlinks resolve to the
	// package roots, but `package.json#main` points at `dist/index.js`).
	// If `dist/` is stale or being rebuilt mid-flight when trigger-http
	// boots, the import fails with "Cannot find module '@blokjs/...'" and
	// `bun --watch` silently sits in a broken state — Studio's `/__blok`
	// proxy then logs ECONNREFUSED forever until the user restarts.
	//
	// Prevent that whole class of bug by ensuring every core dist is fresh
	// BEFORE we spawn the trigger. Order matters: shared + helper first
	// (no internal deps), then runner (imports shared + helper).
	console.log("\nBuilding core workspace packages (shared, helper, runner)…");
	try {
		execSync("bun run --filter @blokjs/shared --filter @blokjs/helper build", {
			cwd: REPO_ROOT,
			stdio: "inherit",
		});
		execSync("bun run --filter @blokjs/runner build", {
			cwd: REPO_ROOT,
			stdio: "inherit",
		});
	} catch (e) {
		console.error("\nCore workspace build failed — the trigger would crash on boot. Aborting.");
		console.error((e as Error).message);
		process.exit(1);
	}

	// Spawn each SDK + pipe its output.
	const children: { proc: ChildProcess; label: string; grpcPort: number }[] = [];
	const cleanupHandlers: Array<() => void> = [];

	const cleanup = () => {
		for (const h of cleanupHandlers) {
			try {
				h();
			} catch {
				// best-effort
			}
		}
	};

	process.on("SIGINT", () => {
		console.log("\n\nShutting down…");
		cleanup();
		setTimeout(() => process.exit(0), 1500);
	});
	process.on("SIGTERM", () => {
		cleanup();
		setTimeout(() => process.exit(0), 1500);
	});

	console.log("\nStarting SDKs…");
	for (const p of runnable) {
		try {
			const proc = p.spawn();
			children.push({ proc, label: p.label, grpcPort: p.grpcPort });
			pipe(proc, p.label, p.color);
			cleanupHandlers.push(() => {
				if (proc.pid && proc.exitCode === null) proc.kill("SIGTERM");
			});
			proc.on("exit", (code) => {
				if (code !== null && code !== 0) {
					console.error(`${p.color}[${p.label}]${COLOR_RESET} exited with code ${code}`);
				}
			});
		} catch (e) {
			console.error(`${p.color}[${p.label}]${COLOR_RESET} spawn failed: ${(e as Error).message}`);
		}
	}

	// Wait for each SDK's gRPC port. Java/C# can take ~5s cold; we
	// give 30s before warning.
	console.log("\nWaiting for runtimes to listen on gRPC…");
	const healthResults = await Promise.all(
		children.map(async (c) => ({ label: c.label, ok: await waitForPort(c.grpcPort, 30_000) })),
	);

	const unhealthy = healthResults.filter((r) => !r.ok);
	if (unhealthy.length > 0) {
		console.warn(
			`\nWarning: ${unhealthy.length} SDK(s) didn't bind gRPC within 30s: ${unhealthy.map((u) => u.label).join(", ")}`,
		);
		console.warn("Trigger will start anyway; the unhealthy ones will surface as DEPENDENCY errors when invoked.");
	}

	// Build the trigger env so it discovers gRPC ports for the SDKs we
	// actually launched. The trigger reads RUNTIME_<KEY>_GRPC_PORT
	// (defaults to the table in DEFAULT_GRPC_PORTS, but we set them
	// explicitly here for visibility).
	//
	// Persistence — default to SQLite at `.blok/trace.db` so the in-repo
	// dev orchestrator behaves the same as a real `blokctl dev` project:
	// runs survive restarts, Studio's "Clear all data" button has
	// something to clear, and the standalone `blokctl studio` mode can
	// be invoked against the same file. Users who export a different
	// BLOK_TRACE_STORE / BLOK_TRACE_SQLITE_PATH win.
	const triggerEnv: Record<string, string> = {
		...process.env,
		PORT: String(TRIGGER_PORT),
		BLOK_TRACE_STORE: process.env.BLOK_TRACE_STORE || "sqlite",
		BLOK_TRACE_SQLITE_PATH: process.env.BLOK_TRACE_SQLITE_PATH || ".blok/trace.db",
		// File-based routing is the framework default since v0.6, so
		// we no longer need an explicit env var here. Operators who
		// want the legacy catch-all can export
		// `BLOK_FILE_BASED_ROUTING=false` or `BLOK_ROUTING_LEGACY=1`
		// before running `bun dev`.
	};
	for (const p of runnable) {
		triggerEnv[`RUNTIME_${p.envKey}_HOST`] = "127.0.0.1";
		triggerEnv[`RUNTIME_${p.envKey}_PORT`] = String(p.httpPort);
		triggerEnv[`RUNTIME_${p.envKey}_GRPC_PORT`] = String(p.grpcPort);
	}

	console.log("\nStarting HTTP trigger…");
	const trigger = spawn("bun", ["run", "--filter", "@blokjs/trigger-http", "dev"], {
		cwd: REPO_ROOT,
		env: triggerEnv,
	});
	pipe(trigger, TRIGGER_LABEL, TRIGGER_COLOR);
	cleanupHandlers.push(() => {
		if (trigger.pid && trigger.exitCode === null) trigger.kill("SIGTERM");
	});
	trigger.on("exit", (code) => {
		console.error(`${TRIGGER_COLOR}[${TRIGGER_LABEL}]${COLOR_RESET} exited with code ${code}`);
		cleanup();
		process.exit(code ?? 1);
	});

	// Wait for the trigger to start listening.
	const triggerReady = await waitForPort(TRIGGER_PORT, 30_000);
	if (!triggerReady) {
		console.error("\nTrigger HTTP server did not bind within 30s. Aborting.");
		cleanup();
		process.exit(1);
	}

	// Spawn Studio (Vite SPA) if its workspace is present. Studio's
	// `/__blok` proxy points at the trigger (port 4000), so it has
	// to start AFTER the trigger is healthy or the first call from
	// the browser will 502 until the trigger comes up.
	let studioReady = false;
	if (existsSync(STUDIO_PACKAGE_JSON)) {
		console.log("\nStarting Studio (Vite dev server)…");
		const studio = spawn("bun", ["run", "--filter", "@blokjs/studio", "dev"], {
			cwd: REPO_ROOT,
			env: { ...process.env },
		});
		pipe(studio, STUDIO_LABEL, STUDIO_COLOR);
		cleanupHandlers.push(() => {
			if (studio.pid && studio.exitCode === null) studio.kill("SIGTERM");
		});
		studio.on("exit", (code) => {
			if (code !== null && code !== 0) {
				console.error(`${STUDIO_COLOR}[${STUDIO_LABEL}]${COLOR_RESET} exited with code ${code}`);
			}
		});
		studioReady = await waitForPort(STUDIO_PORT, 30_000);
		if (!studioReady) {
			console.warn("Warning: Studio Vite server did not bind within 30s. The trigger + SDKs are still healthy.");
		}
	} else {
		console.log(`\n${STUDIO_COLOR}[${STUDIO_LABEL}]${COLOR_RESET} skipped — apps/studio package.json not found.`);
	}

	// Ready banner with concrete curl commands.
	const banner = [
		"",
		`${TRIGGER_COLOR}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLOR_RESET}`,
		`${TRIGGER_COLOR} ✓ Blok dev stack ready (gRPC default, Phase 6)${COLOR_RESET}`,
		`${TRIGGER_COLOR}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLOR_RESET}`,
		"",
		"Try the cross-runtime chain:",
		"",
		`  curl -s -X POST -H 'content-type: application/json' \\`,
		`    http://localhost:${TRIGGER_PORT}/cross-runtime-chain \\`,
		`    -d '{}' | jq .`,
		"",
		studioReady
			? "Studio (UI for runs / metrics / workflow graph):"
			: "Studio API (raw JSON — Studio UI not available):",
		"",
		studioReady ? `  http://localhost:${STUDIO_PORT}` : `  http://localhost:${TRIGGER_PORT}/__blok/runs`,
		"",
		`Trigger root: http://localhost:${TRIGGER_PORT}/`,
		"",
		"Ctrl-C to shut down everything.",
		"",
	].join("\n");
	console.log(banner);
}

main().catch((err) => {
	console.error("dev orchestrator failed:", err);
	process.exit(1);
});
