import child_process from "node:child_process";
import path from "node:path";
import util from "node:util";
import fsExtra from "fs-extra";
import type { RuntimeInfo } from "./runtime-detector.js";

const exec = util.promisify(child_process.exec);

type SpinnerHandler = {
	start: (msg?: string) => void;
	stop: (msg?: string, code?: number) => void;
	message: (msg?: string) => void;
};

export interface RuntimeConfig {
	/**
	 * HTTP listener port. Kept for back-compat — the SDK still binds it for
	 * users who flip `--with-http-fallback` or `RUNTIME_TRANSPORT=http`. The
	 * CLI's gRPC-only spawn does not health-probe this port.
	 */
	port: number;
	/**
	 * gRPC listener port. The CLI spawns the SDK with `BLOK_TRANSPORT=grpc`
	 * and `GRPC_PORT=<grpcPort>`, then waits on a TCP-connect probe to this
	 * port before starting triggers.
	 *
	 * Optional in the type for back-compat reading of pre-Phase-7
	 * `.blok/config.json`. New writes always populate it.
	 */
	grpcPort?: number;
	startCmd: string;
	/**
	 * Optional gRPC-only boot command — used when the SDK's gRPC server is
	 * a different binary entirely (PHP uses RoadRunner). When unset, the
	 * CLI uses `startCmd` with `BLOK_TRANSPORT=grpc` env override.
	 */
	grpcStartCmd?: string;
	cwd: string;
	kind: string;
	label: string;
	/**
	 * Transport the CLI uses when spawning this runtime. Defaults to
	 * `"grpc"` for new projects (Phase 7); `"http"` is honored on existing
	 * projects but emits a deprecation warning at boot.
	 */
	transport?: "grpc" | "http";
}

export interface TriggerConfig {
	kind: string;
	label: string;
	port: number;
	entryPoint: string;
	startCmd: string;
}

export interface ProjectConfig {
	triggers?: Record<string, TriggerConfig>;
	runtimes?: Record<string, RuntimeConfig>;
}

// Backwards compatibility alias
export type ProjectRuntimeConfig = ProjectConfig;

/**
 * Setup a single runtime SDK in the project directory.
 *
 * This follows the existing Python3 pattern from project.ts:
 * 1. Copy SDK source to .blok/runtimes/{language}/
 * 2. Create runtimes/{language}/nodes/ for user nodes
 * 3. Symlink shared code between SDK and project
 * 4. Install dependencies
 */
export async function setupRuntime(
	runtime: RuntimeInfo,
	githubRepoLocal: string,
	projectDir: string,
	spinner: SpinnerHandler,
): Promise<RuntimeConfig> {
	const sdkSourcePath = path.join(githubRepoLocal, "sdks", runtime.sdkDir);
	const blokctlRuntimeDir = path.join(projectDir, ".blok", "runtimes", runtime.kind);
	const projectRuntimeDir = path.join(projectDir, "runtimes", runtime.kind);

	// Verify SDK source exists in cloned repo
	if (!fsExtra.existsSync(sdkSourcePath)) {
		throw new Error(
			`SDK source for ${runtime.label} not found at ${sdkSourcePath}. Make sure the Blok repository is up to date.`,
		);
	}

	spinner.message(`Setting up ${runtime.label} runtime...`);

	// 1. Copy SDK source to .blok/runtimes/{language}/
	fsExtra.ensureDirSync(path.dirname(blokctlRuntimeDir));
	fsExtra.copySync(sdkSourcePath, blokctlRuntimeDir);

	// 2. Create project-level runtimes directory for user nodes
	fsExtra.ensureDirSync(projectRuntimeDir);
	const nodesDir = path.join(projectRuntimeDir, "nodes");
	fsExtra.ensureDirSync(nodesDir);

	// 3. Language-specific setup (may return an override startCmd)
	let startCmdOverride: string | undefined;
	switch (runtime.kind) {
		case "python3":
			await setupPython3(blokctlRuntimeDir, projectRuntimeDir, spinner);
			break;
		case "go":
			await setupGo(blokctlRuntimeDir, spinner);
			break;
		case "rust":
			await setupRust(blokctlRuntimeDir, spinner);
			break;
		case "java":
			startCmdOverride = await setupJava(blokctlRuntimeDir, spinner);
			break;
		case "csharp":
			await setupCSharp(blokctlRuntimeDir, spinner);
			break;
		case "php":
			await setupPhp(blokctlRuntimeDir, spinner);
			break;
		case "ruby":
			startCmdOverride = await setupRuby(blokctlRuntimeDir, spinner, runtime.defaultPort);
			break;
	}

	spinner.message(`${runtime.label} runtime setup complete.`);

	return {
		port: runtime.defaultPort,
		grpcPort: runtime.defaultGrpcPort,
		startCmd: startCmdOverride || runtime.startCmd,
		grpcStartCmd: runtime.grpcStartCmd,
		cwd: path.relative(projectDir, blokctlRuntimeDir),
		kind: runtime.kind,
		label: runtime.label,
		transport: "grpc",
	};
}

/**
 * Python3: create venv, install requirements, symlink nodes/core.
 * Mirrors the existing logic in project.ts:262-308.
 */
async function setupPython3(sdkDir: string, projectRuntimeDir: string, spinner: SpinnerHandler): Promise<void> {
	// Create virtual environment
	spinner.message("Creating Python3 virtual environment...");
	await createPythonVenv(sdkDir);
	spinner.message("Python3 virtual environment created.");

	// Install Python packages
	spinner.message("Installing Python3 packages...");
	const venvPip = path.join(sdkDir, "python3_runtime", "bin", "pip3");
	const requirementsFile = path.join(sdkDir, "requirements.txt");
	if (fsExtra.existsSync(requirementsFile)) {
		await exec(`"${venvPip}" install -r "${requirementsFile}"`, { cwd: sdkDir });
	}
	spinner.message("Python3 packages installed.");

	// Symlink nodes and core to project runtime directory
	const nodesLink = path.join(projectRuntimeDir, "nodes");
	const sdkNodesDir = path.join(sdkDir, "nodes");
	if (fsExtra.existsSync(sdkNodesDir) && !fsExtra.existsSync(nodesLink)) {
		fsExtra.symlinkSync(sdkNodesDir, nodesLink, "junction");
	}

	const coreLink = path.join(projectRuntimeDir, "core");
	const sdkCoreDir = path.join(sdkDir, "core");
	if (fsExtra.existsSync(sdkCoreDir) && !fsExtra.existsSync(coreLink)) {
		fsExtra.symlinkSync(sdkCoreDir, coreLink, "junction");
	}
}

async function createPythonVenv(sdkDir: string): Promise<void> {
	await exec("python3 -m venv python3_runtime", { cwd: sdkDir, timeout: 60000 });
}

/**
 * Go: download module dependencies.
 */
async function setupGo(sdkDir: string, spinner: SpinnerHandler): Promise<void> {
	spinner.message("Downloading Go dependencies...");
	await exec("go mod download", { cwd: sdkDir, timeout: 120000 });
	spinner.message("Go dependencies installed.");
}

/**
 * Rust: build the project (this also downloads dependencies).
 */
async function setupRust(sdkDir: string, spinner: SpinnerHandler): Promise<void> {
	spinner.message("Building Rust project (this may take a few minutes on first build)...");
	await exec("cargo build --release", { cwd: sdkDir, timeout: 600000 });
	spinner.message("Rust project built.");
}

/**
 * Java: download dependencies and package with Maven.
 * Returns an override startCmd if the default `java` isn't in PATH (e.g., macOS Homebrew).
 */
async function setupJava(sdkDir: string, spinner: SpinnerHandler): Promise<string | undefined> {
	spinner.message("Building Java project with Maven...");
	await exec("mvn package -q -DskipTests", { cwd: sdkDir, timeout: 300000 });
	spinner.message("Java project built.");

	// Resolve the correct java binary (macOS ships a stub at /usr/bin/java that fails)
	const javaCandidates = ["java", "/opt/homebrew/opt/openjdk/bin/java"];
	for (const javaBin of javaCandidates) {
		try {
			await exec(`${javaBin} --version`, { timeout: 5000 });
			if (javaBin !== "java") {
				return `${javaBin} -jar target/blok-java-1.0.0.jar`;
			}
			return undefined; // default startCmd works
		} catch {
			// try next candidate
		}
	}
	return undefined;
}

/**
 * C# / .NET: restore NuGet packages.
 */
async function setupCSharp(sdkDir: string, spinner: SpinnerHandler): Promise<void> {
	spinner.message("Restoring .NET packages...");
	await exec("dotnet restore", { cwd: sdkDir, timeout: 120000 });
	spinner.message(".NET packages restored.");
}

/**
 * PHP: install Composer dependencies.
 */
async function setupPhp(sdkDir: string, spinner: SpinnerHandler): Promise<void> {
	spinner.message("Installing PHP dependencies...");
	await exec("composer install --no-dev --optimize-autoloader", { cwd: sdkDir, timeout: 120000 });
	spinner.message("PHP dependencies installed.");
}

/**
 * Ruby: install Bundler dependencies.
 * Returns an override startCmd if the system `bundle` is too old (e.g., macOS ships Ruby 2.6).
 */
async function setupRuby(sdkDir: string, spinner: SpinnerHandler, port: number): Promise<string> {
	// Resolve the correct bundle binary (macOS ships Ruby 2.6 + Bundler 1.x)
	const bundleCandidates = ["bundle", "/opt/homebrew/opt/ruby/bin/bundle"];
	let resolvedBundle = "bundle";

	for (const bin of bundleCandidates) {
		try {
			const { stdout } = await exec(`${bin} --version`, { timeout: 5000 });
			const match = stdout.match(/(\d+)\./);
			const major = match ? Number.parseInt(match[1], 10) : 0;
			// Need Bundler 2+ for modern gemspecs
			if (major >= 2) {
				resolvedBundle = bin;
				break;
			}
		} catch {
			// try next candidate
		}
	}

	spinner.message("Installing Ruby dependencies...");
	await exec(`"${resolvedBundle}" install`, { cwd: sdkDir, timeout: 120000 });
	spinner.message("Ruby dependencies installed.");

	// Always return the startCmd with explicit -p flag because rackup
	// does not reliably read the PORT env var across versions.
	return `${resolvedBundle} exec rackup --host 0.0.0.0 -p ${port} config.ru`;
}

/**
 * Write the .blok/config.json file with runtime and trigger configuration.
 */
export function writeProjectConfig(
	projectDir: string,
	runtimeConfigs: RuntimeConfig[],
	triggerConfigs?: TriggerConfig[],
): void {
	const config: ProjectConfig = {};

	if (runtimeConfigs.length > 0) {
		config.runtimes = {};
		for (const rc of runtimeConfigs) {
			config.runtimes[rc.kind] = rc;
		}
	}

	if (triggerConfigs && triggerConfigs.length > 0) {
		config.triggers = {};
		for (const tc of triggerConfigs) {
			config.triggers[tc.kind] = tc;
		}
	}

	const configPath = path.join(projectDir, ".blok", "config.json");
	fsExtra.ensureDirSync(path.dirname(configPath));
	fsExtra.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Read the .blok/config.json file.
 * Returns null if file doesn't exist.
 */
export function readProjectConfig(projectDir: string): ProjectConfig | null {
	const configPath = path.join(projectDir, ".blok", "config.json");
	if (!fsExtra.existsSync(configPath)) {
		return null;
	}
	return JSON.parse(fsExtra.readFileSync(configPath, "utf8"));
}

/**
 * Generate environment variable entries for selected runtimes.
 *
 * Emits BOTH `RUNTIME_<K>_PORT` (HTTP, kept for back-compat) and
 * `RUNTIME_<K>_GRPC_PORT` (gRPC, what the runner actually probes when
 * `BLOK_TRANSPORT=grpc`). The trigger-http reads both at boot.
 */
export function generateRuntimeEnvVars(runtimeConfigs: RuntimeConfig[]): string {
	if (runtimeConfigs.length === 0) return "";

	const lines = ["\n# Runtimes (auto-configured by blokctl)"];

	for (const rc of runtimeConfigs) {
		const envKey = rc.kind === "csharp" ? "CSHARP" : rc.kind.toUpperCase();
		lines.push(`RUNTIME_${envKey}_HOST=localhost`);
		lines.push(`RUNTIME_${envKey}_PORT=${rc.port}`);
		if (rc.grpcPort !== undefined) {
			lines.push(`RUNTIME_${envKey}_GRPC_PORT=${rc.grpcPort}`);
		}
	}

	// Default transport — picked up by core/runner/src/adapters/transport.ts
	// via `RUNTIME_TRANSPORT`. Leaving this unset would still default to
	// grpc (Phase 6), but writing it explicitly makes the intent visible
	// in the generated `.env` so users grepping `BLOK_TRANSPORT` find it.
	lines.push("BLOK_TRANSPORT=grpc");

	return lines.join("\n");
}

/**
 * Generate supervisord config entries for selected runtimes. Each program
 * boots with `BLOK_TRANSPORT=grpc` and a `GRPC_PORT` matching the
 * runtime's gRPC listener so the trigger and CLI can reach it.
 */
export function generateSupervisordConfig(runtimeConfigs: RuntimeConfig[]): string {
	let config = "";

	for (const rc of runtimeConfigs) {
		const cmd = rc.grpcStartCmd ?? rc.startCmd;
		const grpcPortLine = rc.grpcPort !== undefined ? `,GRPC_PORT="${rc.grpcPort}"` : "";
		config += `
[program:${rc.kind}_runtime]
command=${cmd}
directory=/app/${rc.cwd}
environment=PORT="${rc.port}"${grpcPortLine},HOST="0.0.0.0",BLOK_TRANSPORT="grpc"
autostart=true
autorestart=true
stderr_logfile=/var/log/${rc.kind}.err.log
stdout_logfile=/var/log/${rc.kind}.out.log
`;
	}

	return config;
}

// ============================================================================
// Trigger Configuration Helpers
// ============================================================================

/** Default port mapping for each trigger type */
const TRIGGER_PORTS: Record<string, number> = {
	http: 4000,
	sse: 4001,
	websocket: 4002,
	grpc: 4003,
	cron: 4004,
	queue: 4005,
	pubsub: 4006,
	webhook: 4007,
	worker: 4008,
};

/** Human-readable labels for each trigger type */
const TRIGGER_LABELS: Record<string, string> = {
	http: "HTTP Trigger",
	sse: "SSE Trigger",
	websocket: "WebSocket Trigger",
	grpc: "gRPC Trigger",
	cron: "Cron Trigger",
	queue: "Queue Trigger",
	pubsub: "PubSub Trigger",
	webhook: "Webhook Trigger",
	worker: "Worker Trigger",
};

/**
 * Get the default port for a trigger type.
 */
export function getTriggerPort(triggerKind: string): number {
	return TRIGGER_PORTS[triggerKind] ?? 4000;
}

/**
 * Get the human-readable label for a trigger type.
 */
export function getTriggerLabel(triggerKind: string): string {
	return TRIGGER_LABELS[triggerKind] ?? `${triggerKind.toUpperCase()} Trigger`;
}

/**
 * Create a TriggerConfig object for a given trigger type.
 */
export function createTriggerConfig(triggerKind: string): TriggerConfig {
	const port = getTriggerPort(triggerKind);
	return {
		kind: triggerKind,
		label: getTriggerLabel(triggerKind),
		port,
		entryPoint: `src/triggers/${triggerKind}/index.ts`,
		startCmd: `bun run src/triggers/${triggerKind}/index.ts`,
	};
}

/**
 * Generate environment variable entries for selected triggers.
 */
export function generateTriggerEnvVars(triggerConfigs: TriggerConfig[]): string {
	if (triggerConfigs.length === 0) return "";

	const lines = ["\n# Triggers (auto-configured by blokctl)"];

	for (const tc of triggerConfigs) {
		lines.push(`TRIGGER_${tc.kind.toUpperCase()}_PORT=${tc.port}`);
	}

	return lines.join("\n");
}

/**
 * Generate supervisord config entries for selected triggers.
 */
export function generateTriggerSupervisordConfig(triggerConfigs: TriggerConfig[]): string {
	let config = "";

	for (const tc of triggerConfigs) {
		config += `
[program:${tc.kind}_trigger]
command=${tc.startCmd}
directory=/app
environment=PORT="${tc.port}",HOST="0.0.0.0"
autostart=true
autorestart=true
stderr_logfile=/var/log/${tc.kind}_trigger.err.log
stdout_logfile=/var/log/${tc.kind}_trigger.out.log
`;
	}

	return config;
}
