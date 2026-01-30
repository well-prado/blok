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
	port: number;
	startCmd: string;
	cwd: string;
	kind: string;
	label: string;
}

export interface ProjectRuntimeConfig {
	runtimes: Record<string, RuntimeConfig>;
}

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
			await setupRuby(blokctlRuntimeDir, spinner);
			break;
	}

	spinner.message(`${runtime.label} runtime setup complete.`);

	return {
		port: runtime.defaultPort,
		startCmd: startCmdOverride || runtime.startCmd,
		cwd: path.relative(projectDir, blokctlRuntimeDir),
		kind: runtime.kind,
		label: runtime.label,
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
 */
async function setupRuby(sdkDir: string, spinner: SpinnerHandler): Promise<void> {
	spinner.message("Installing Ruby dependencies...");
	await exec("bundle install", { cwd: sdkDir, timeout: 120000 });
	spinner.message("Ruby dependencies installed.");
}

/**
 * Write the .blok/config.json file with runtime configuration.
 */
export function writeProjectConfig(projectDir: string, runtimeConfigs: RuntimeConfig[]): void {
	const config: ProjectRuntimeConfig = {
		runtimes: {},
	};

	for (const rc of runtimeConfigs) {
		config.runtimes[rc.kind] = rc;
	}

	const configPath = path.join(projectDir, ".blok", "config.json");
	fsExtra.ensureDirSync(path.dirname(configPath));
	fsExtra.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Read the .blok/config.json file.
 * Returns null if file doesn't exist.
 */
export function readProjectConfig(projectDir: string): ProjectRuntimeConfig | null {
	const configPath = path.join(projectDir, ".blok", "config.json");
	if (!fsExtra.existsSync(configPath)) {
		return null;
	}
	return JSON.parse(fsExtra.readFileSync(configPath, "utf8"));
}

/**
 * Generate environment variable entries for selected runtimes.
 */
export function generateRuntimeEnvVars(runtimeConfigs: RuntimeConfig[]): string {
	if (runtimeConfigs.length === 0) return "";

	const lines = ["\n# Runtimes (auto-configured by blokctl)"];

	for (const rc of runtimeConfigs) {
		const envKey = rc.kind === "csharp" ? "CSHARP" : rc.kind.toUpperCase();
		lines.push(`RUNTIME_${envKey}_HOST=localhost`);
		lines.push(`RUNTIME_${envKey}_PORT=${rc.port}`);
	}

	return lines.join("\n");
}

/**
 * Generate supervisord config entries for selected runtimes.
 */
export function generateSupervisordConfig(runtimeConfigs: RuntimeConfig[]): string {
	let config = "";

	for (const rc of runtimeConfigs) {
		config += `
[program:${rc.kind}_runtime]
command=${rc.startCmd}
directory=/app/${rc.cwd}
environment=PORT="${rc.port}",HOST="0.0.0.0"
autostart=true
autorestart=true
stderr_logfile=/var/log/${rc.kind}.err.log
stdout_logfile=/var/log/${rc.kind}.out.log
`;
	}

	return config;
}
