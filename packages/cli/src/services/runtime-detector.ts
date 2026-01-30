import child_process from "node:child_process";
import util from "node:util";

const exec = util.promisify(child_process.exec);

export interface RuntimeInfo {
	kind: string;
	label: string;
	available: boolean;
	version?: string;
	installHint: string;
	defaultPort: number;
	/** Command(s) to check availability */
	commands: string[];
	/** Human-readable name of the required toolchain */
	toolchain: string;
	/** Command to install dependencies inside the SDK directory */
	installDeps: string;
	/** Command to start the runtime server */
	startCmd: string;
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

const RUNTIME_DEFINITIONS: Omit<RuntimeInfo, "available" | "version">[] = [
	{
		kind: "python3",
		label: "Python 3",
		installHint: "Install Python: https://python.org/downloads/",
		defaultPort: 9007,
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
		commands: ["rustc --version"],
		toolchain: "rustc + cargo",
		installDeps: "cargo build --release",
		startCmd: "cargo run",
		sdkDir: "rust",
	},
	{
		kind: "java",
		label: "Java",
		installHint: "Install JDK 17+: https://adoptium.net/",
		defaultPort: 9003,
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
		commands: ["dotnet --version"],
		toolchain: "dotnet",
		installDeps: "dotnet restore",
		startCmd: "dotnet run --project src/Blok.Core",
		sdkDir: "csharp",
	},
	{
		kind: "php",
		label: "PHP",
		installHint: "Install PHP 8.2+: https://php.net/downloads",
		defaultPort: 9005,
		commands: ["php --version"],
		toolchain: "php + composer",
		installDeps: "composer install",
		startCmd: "php bin/serve.php",
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
		installHint: "Install Ruby 3.2+: https://ruby-lang.org/en/downloads/",
		defaultPort: 9006,
		commands: ["ruby --version"],
		toolchain: "ruby + bundler",
		installDeps: "bundle install",
		startCmd: "bundle exec rackup --host 0.0.0.0 --port 8080 config.ru",
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

		// Check primary command (try all alternatives until one succeeds)
		for (const cmd of def.commands) {
			const output = await tryExec(cmd);
			if (output) {
				info.available = true;
				info.version = parseVersion(output, def.kind);
				break;
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
