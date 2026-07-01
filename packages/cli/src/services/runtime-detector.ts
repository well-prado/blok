import child_process from "node:child_process";
import util from "node:util";
import { compareSemver } from "./semver-utils.js";

const exec = util.promisify(child_process.exec);

export interface RuntimeInfo {
	kind: string;
	label: string;
	available: boolean;
	version?: string;
	/**
	 * Minimum toolchain version this SDK's gRPC transport requires, as a bare
	 * semver (e.g. "3.1.0"). Independent of the detected `version` — it is a
	 * SEMANTIC floor, not a pin to whatever is installed. Interpreted runtimes
	 * set it because their gRPC library is a native-build dependency with a
	 * hard floor (the Ruby `grpc` gem needs Ruby 3.x; PHP's RoadRunner gRPC
	 * needs PHP 8.2+). Feeds `requiredVersion` in .blok/config.json and gates
	 * scaffold-time setup with an actionable message.
	 */
	minVersion?: string;
	installHint: string;
	/**
	 * Default port retained for back-compat with `.blok/config.json` files
	 * scaffolded before the gRPC-only flip. The CLI no longer health-probes
	 * it; gRPC is the sole transport since v0.5 (`HttpRuntimeAdapter` was
	 * removed). New scaffolds still emit it so older runner versions that
	 * read the field don't break.
	 */
	defaultPort: number;
	/**
	 * Default gRPC port. Equal to `defaultPort + 1000` by convention
	 * (mirrors `scripts/dev-full.ts` mapping). The CLI's gRPC-only spawn
	 * sets `GRPC_PORT` and `BLOK_TRANSPORT=grpc` from this and probes here
	 * for readiness.
	 */
	defaultGrpcPort: number;
	/** Command(s) to check availability */
	commands: string[];
	/** Human-readable name of the required toolchain */
	toolchain: string;
	/** Command to install dependencies inside the SDK directory */
	installDeps: string;
	/** Command to start the runtime server */
	startCmd: string;
	/**
	 * Optional override for the gRPC-only boot command. If set, the CLI
	 * runs this instead of `startCmd` with `BLOK_TRANSPORT=grpc` env. Used
	 * for SDKs whose gRPC server is a different binary entirely (e.g. PHP
	 * uses RoadRunner).
	 */
	grpcStartCmd?: string;
	/** SDK source directory name inside sdks/ */
	sdkDir: string;
	/** Additional toolchain checks (e.g., maven for Java, composer for PHP) */
	secondaryTool?: {
		name: string;
		command: string;
		available?: boolean;
		version?: string;
		installHint: string;
	};
}

/**
 * Locate the RoadRunner binary. Returns the resolved path or null if
 * neither the brew-default nor `$PATH` location holds an executable.
 *
 * Mirrors the helper in `scripts/dev-full.ts:147-157` so PHP detection
 * stays in lock-step between `bun dev` (in-repo orchestrator) and
 * `blokctl dev` (user-facing CLI).
 */
export function detectRr(): string | null {
	for (const bin of ["/opt/homebrew/bin/rr", "rr"]) {
		try {
			child_process.execSync(`${bin} --version`, { stdio: "ignore" });
			return bin;
		} catch {
			// keep trying
		}
	}
	return null;
}

/**
 * Locate a working `java` launcher. macOS ships a `/usr/bin/java` stub that
 * fails with "Unable to locate a Java Runtime" unless a JDK is system-linked —
 * brew's openjdk is keg-only, so detection can succeed via the keg path while
 * a bare `java -jar …` spawn dies. Keep the candidate list in lock-step with
 * the java entry's `commands` below.
 */
export function detectJava(): string | null {
	for (const bin of ["java", "/opt/homebrew/opt/openjdk/bin/java"]) {
		try {
			child_process.execSync(`${bin} --version`, { stdio: "ignore" });
			return bin;
		} catch {
			// keep trying
		}
	}
	return null;
}

const RUNTIME_DEFINITIONS: Omit<RuntimeInfo, "available" | "version">[] = [
	{
		kind: "python3",
		label: "Python 3",
		installHint: "Install Python: https://python.org/downloads/",
		defaultPort: 9007,
		defaultGrpcPort: 10007,
		commands: ["python3 --version"],
		toolchain: "python3",
		installDeps: "pip3 install -r requirements.txt",
		startCmd: "python3 bin/serve.py",
		sdkDir: "python3",
	},
	{
		kind: "go",
		label: "Go",
		installHint: "Install Go: https://go.dev/dl/",
		defaultPort: 9001,
		defaultGrpcPort: 10001,
		commands: ["go version"],
		toolchain: "go",
		installDeps: "go mod download",
		startCmd: "go run ./cmd/server",
		sdkDir: "go",
	},
	{
		kind: "rust",
		label: "Rust",
		installHint: "Install Rust: https://rustup.rs/",
		defaultPort: 9002,
		defaultGrpcPort: 10002,
		commands: ["rustc --version"],
		toolchain: "rustc + cargo",
		installDeps: "cargo build --features grpc",
		startCmd: "cargo run",
		// The SDK's gRPC server is behind a cargo feature (default = ["http"]),
		// so a plain `cargo run` compiles it OUT and the sidecar silently boots
		// HTTP-only — the runner then gets ECONNREFUSED on GRPC_PORT.
		grpcStartCmd: "cargo run --features grpc",
		sdkDir: "rust",
	},
	{
		kind: "java",
		label: "Java",
		installHint: "Install JDK 17+: https://adoptium.net/",
		defaultPort: 9003,
		defaultGrpcPort: 10003,
		commands: [
			"java --version",
			"/opt/homebrew/opt/openjdk/bin/java --version",
			"/usr/libexec/java_home -v 17+ 2>/dev/null && java --version",
		],
		toolchain: "java + mvn",
		installDeps: "mvn package -q -DskipTests",
		startCmd: "java -jar target/blok-java-1.0.0.jar",
		sdkDir: "java",
		secondaryTool: {
			name: "Maven",
			command: "mvn --version",
			installHint: "Install Maven: https://maven.apache.org/install.html",
		},
	},
	{
		kind: "csharp",
		label: "C# / .NET",
		installHint: "Install .NET SDK: https://dotnet.microsoft.com/download",
		defaultPort: 9004,
		defaultGrpcPort: 10004,
		commands: ["dotnet --version"],
		toolchain: "dotnet",
		installDeps: "dotnet restore",
		startCmd: "dotnet run --project src/Blok.Core",
		sdkDir: "csharp",
	},
	{
		kind: "php",
		label: "PHP",
		// PHP's gRPC transport is RoadRunner (spiral/roadrunner-grpc, pulled by
		// `composer install`) + the `rr` binary — NOT the pecl `grpc` extension.
		// roadrunner-grpc requires PHP 8.2+.
		minVersion: "8.2.0",
		installHint: "Install PHP 8.2+ + RoadRunner: https://php.net/downloads (rr: brew install roadrunner)",
		defaultPort: 9005,
		defaultGrpcPort: 10005,
		commands: ["php --version"],
		toolchain: "php + composer + rr",
		installDeps: "composer install",
		startCmd: "php bin/serve.php",
		// PHP's gRPC server is RoadRunner — a separate binary from
		// `php bin/serve.php`. The CLI invokes this command verbatim;
		// the rr binary path is resolved at spawn-time via `detectRr()`
		// and swapped in if the literal `rr` token isn't on $PATH.
		grpcStartCmd: "rr serve -c .rr.yaml --override grpc.listen=tcp://127.0.0.1:10005",
		sdkDir: "php",
		secondaryTool: {
			name: "Composer",
			command: "composer --version",
			installHint: "Install Composer: https://getcomposer.org/download/",
		},
	},
	{
		kind: "ruby",
		label: "Ruby",
		// The Ruby `grpc` gem (in the SDK gemspec, installed by `bundle install`)
		// is a native build that requires Ruby 3.x — grpc ~> 1.69 dropped 2.x.
		// macOS ships an EOL system Ruby 2.6, so a floor + clear message avoids a
		// cryptic gem-compile failure.
		minVersion: "3.1.0",
		installHint: "Install Ruby 3.1+: https://ruby-lang.org/en/downloads/ (macOS: brew install ruby)",
		defaultPort: 9006,
		defaultGrpcPort: 10006,
		commands: ["ruby --version", "/opt/homebrew/opt/ruby/bin/ruby --version"],
		toolchain: "ruby + bundler",
		installDeps: "bundle install",
		// bin/serve.rb honors BLOK_TRANSPORT (http|grpc|both) + PORT/GRPC_PORT.
		// `rackup config.ru` boots the Rack HTTP app only — no gRPC server —
		// so under `blokctl dev` (BLOK_TRANSPORT=grpc) the runner would get
		// ECONNREFUSED on GRPC_PORT.
		startCmd: "bundle exec ruby bin/serve.rb",
		sdkDir: "ruby",
		secondaryTool: {
			name: "Bundler",
			command: "bundle --version",
			installHint: "Install Bundler: gem install bundler",
		},
	},
];

/**
 * Execute a command and return stdout, or null if it fails.
 */
async function tryExec(command: string): Promise<string | null> {
	try {
		const { stdout } = await exec(command, { timeout: 5000 });
		return stdout.trim();
	} catch {
		return null;
	}
}

/**
 * Parse version string from common version command outputs.
 */
function parseVersion(output: string, kind: string): string | undefined {
	switch (kind) {
		case "go": {
			// "go version go1.22.5 darwin/arm64" → "1.22.5"
			const match = output.match(/go(\d+\.\d+(?:\.\d+)?)/);
			return match ? match[1] : undefined;
		}
		case "rust": {
			// "rustc 1.78.0 (9b00956e5 2024-04-29)" → "1.78.0"
			const match = output.match(/rustc\s+(\d+\.\d+\.\d+)/);
			return match ? match[1] : undefined;
		}
		case "java": {
			// "openjdk 17.0.11 2024-04-16" or "java 21.0.1 2023-10-17" → "17.0.11"
			const match = output.match(/(?:openjdk|java)\s+(\d+[\d.]*)/);
			return match ? match[1] : undefined;
		}
		case "csharp": {
			// "9.0.100" → "9.0.100"
			const match = output.match(/(\d+\.\d+\.\d+)/);
			return match ? match[1] : undefined;
		}
		case "php": {
			// "PHP 8.2.18 (cli) ..." → "8.2.18"
			const match = output.match(/PHP\s+(\d+\.\d+\.\d+)/);
			return match ? match[1] : undefined;
		}
		case "ruby": {
			// "ruby 3.3.0 (2023-12-25 revision 5124f9ac75) [arm64-darwin23]" → "3.3.0"
			const match = output.match(/ruby\s+(\d+\.\d+\.\d+)/);
			return match ? match[1] : undefined;
		}
		case "python3": {
			// "Python 3.12.0" → "3.12.0"
			const match = output.match(/Python\s+(\d+\.\d+\.\d+)/);
			return match ? match[1] : undefined;
		}
		default:
			return undefined;
	}
}

/**
 * Detect all available language runtimes on the current machine.
 * Returns RuntimeInfo[] with availability and version for each.
 */
export async function detectRuntimes(): Promise<RuntimeInfo[]> {
	const results: RuntimeInfo[] = [];

	for (const def of RUNTIME_DEFINITIONS) {
		const info: RuntimeInfo = {
			...def,
			available: false,
			version: undefined,
		};

		// Probe every alternative and keep the HIGHEST version, not the first.
		// Ruby lists both the system `ruby` (an EOL 2.6 on macOS) and a Homebrew
		// path; the sidecar runs under the newer one (see setupRuby), so the
		// higher version is the truthful "what will run" answer.
		for (const cmd of def.commands) {
			const output = await tryExec(cmd);
			if (!output) continue;
			info.available = true;
			const parsed = parseVersion(output, def.kind);
			if (parsed && (!info.version || compareSemver(parsed, info.version) > 0)) {
				info.version = parsed;
			}
		}

		// Check secondary toolchain if defined
		if (def.secondaryTool) {
			const secondaryOutput = await tryExec(def.secondaryTool.command);
			info.secondaryTool = {
				...def.secondaryTool,
				available: secondaryOutput !== null,
				version: secondaryOutput ?? undefined,
			};

			// If primary is available but secondary is not, mark as unavailable
			if (info.available && !info.secondaryTool.available) {
				info.available = false;
			}
		}

		results.push(info);
	}

	return results;
}

/**
 * Detect the version of a single runtime kind.
 * Faster than full detectRuntimes() when you only need one.
 *
 * @returns The detected version string, or undefined if not installed.
 */
export async function detectRuntimeVersion(kind: string): Promise<string | undefined> {
	const def = RUNTIME_DEFINITIONS.find((r) => r.kind === kind);
	if (!def) return undefined;

	// Return the HIGHEST version across all probe commands (see detectRuntimes)
	// so a Homebrew Ruby 3.x is picked over the EOL system Ruby 2.6.
	let best: string | undefined;
	for (const cmd of def.commands) {
		const output = await tryExec(cmd);
		if (!output) continue;
		const parsed = parseVersion(output, def.kind);
		if (parsed && (!best || compareSemver(parsed, best) > 0)) best = parsed;
	}
	return best;
}

/**
 * Get runtime info for a specific kind.
 */
export function getRuntimeDefinition(kind: string): Omit<RuntimeInfo, "available" | "version"> | undefined {
	return RUNTIME_DEFINITIONS.find((r) => r.kind === kind);
}

/**
 * Get all runtime definitions (without detection).
 */
export function getAllRuntimeDefinitions(): Omit<RuntimeInfo, "available" | "version">[] {
	return [...RUNTIME_DEFINITIONS];
}
