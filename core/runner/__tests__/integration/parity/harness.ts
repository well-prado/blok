/**
 * Cross-language parity harness — SDK lifecycle helpers shared by the
 * matrix runner.
 *
 * One entry per SDK that participates in the matrix. Each entry exposes:
 *   - {@link SdkProfile.detect | detect()} — synchronously check whether
 *     the SDK toolchain is installed locally. The matrix calls
 *     {@link describe.skipIf} on the result so missing toolchains
 *     gracefully skip instead of failing CI.
 *   - {@link SdkProfile.spawn | spawn()} — start a fresh SDK process
 *     listening on the supplied gRPC port and return a `kill` callable.
 *   - {@link SdkProfile.kind} — the {@link RuntimeKind} value the runner
 *     uses internally (drives adapter config + step-prefix display).
 *
 * Why per-SDK profiles instead of a single `spawn(sdk, port)` helper:
 * each language has subtly different boot semantics (Python expects
 * `PORT` + `GRPC_PORT`; Java reads `BLOK_TRANSPORT=grpc`; PHP routes
 * through RoadRunner; etc.). Encoding those subtleties as explicit
 * profile records keeps the matrix runner generic.
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import type { RuntimeKind } from "../../../src/adapters/RuntimeAdapter";
import { GrpcRuntimeAdapter } from "../../../src/adapters/grpc/GrpcRuntimeAdapter";
import { GRPC_DEFAULTS, type GrpcAdapterConfig } from "../../../src/adapters/grpc/types";

const REPO_ROOT = path.resolve(__dirname, "../../../../../");

/**
 * Reserve an OS-assigned ephemeral port. The OS hands us a free port,
 * we close the listener immediately so the SDK can bind it. The brief
 * race window (port reused before SDK binds) has never been observed
 * in practice with the integration suite running serially.
 */
export async function reserveFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (typeof addr === "object" && addr !== null) {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close();
				reject(new Error("could not determine ephemeral port"));
			}
		});
		srv.on("error", reject);
	});
}

/** SDK lifecycle profile consumed by the matrix runner. */
export interface SdkProfile {
	readonly id: string;
	readonly kind: RuntimeKind;
	readonly detect: () => boolean;
	readonly spawn: (httpPort: number, grpcPort: number) => ChildProcess;
}

// =============================================================================
// Per-SDK profiles
// =============================================================================

const PYTHON_SDK_ROOT = path.join(REPO_ROOT, "sdks/python3");
const PYTHON_SERVE_SCRIPT = path.join(PYTHON_SDK_ROOT, "bin/serve.py");

const pythonProfile: SdkProfile = {
	id: "python3",
	kind: "python3",
	detect: () => {
		try {
			execSync(`python3 -c "import grpc; from blok.runtime.v1 import runtime_pb2"`, {
				cwd: PYTHON_SDK_ROOT,
				stdio: "ignore",
			});
			return true;
		} catch {
			return false;
		}
	},
	spawn: (httpPort, grpcPort) =>
		spawn("python3", [PYTHON_SERVE_SCRIPT], {
			cwd: PYTHON_SDK_ROOT,
			env: {
				...process.env,
				PORT: String(httpPort),
				GRPC_PORT: String(grpcPort),
				BLOK_TRANSPORT: "grpc",
				HOST: "127.0.0.1",
				LOG_LEVEL: "WARN",
				PYTHONUNBUFFERED: "1",
			},
			stdio: ["ignore", "ignore", "inherit"],
		}),
};

const GO_BINARY = path.join(REPO_ROOT, "sdks/go/bin/blok");

const goProfile: SdkProfile = {
	id: "go",
	kind: "go",
	detect: () => existsSync(GO_BINARY),
	spawn: (httpPort, grpcPort) =>
		spawn(GO_BINARY, [], {
			env: {
				...process.env,
				PORT: String(httpPort),
				GRPC_PORT: String(grpcPort),
				BLOK_TRANSPORT: "grpc",
				HOST: "127.0.0.1",
				LOG_LEVEL: "WARN",
			},
			stdio: ["ignore", "ignore", "inherit"],
		}),
};

const RUST_BINARY = path.join(REPO_ROOT, "sdks/rust/target/debug/blok");

const rustProfile: SdkProfile = {
	id: "rust",
	kind: "rust",
	detect: () => existsSync(RUST_BINARY),
	// Rust starts both HTTP and gRPC listeners under `tokio::select!` when
	// `ENABLE_GRPC=true`. Match the per-SDK rust-grpc.integration.test.ts
	// env exactly (LOG_LEVEL=INFO, RUST_LOG=info) — earlier "WARN" caused
	// a silent boot stall on tracing-subscriber's filter parser.
	spawn: (httpPort, grpcPort) =>
		spawn(RUST_BINARY, [], {
			env: {
				...process.env,
				PORT: String(httpPort),
				GRPC_PORT: String(grpcPort),
				ENABLE_GRPC: "true",
				HOST: "127.0.0.1",
				LOG_LEVEL: "INFO",
				RUST_LOG: "info",
			},
			stdio: ["ignore", "ignore", "inherit"],
		}),
};

const JAVA_JAR = path.join(REPO_ROOT, "sdks/java/target/blok-java-1.0.0.jar");

function detectJavaBin(): string | null {
	const candidates = ["/opt/homebrew/opt/openjdk@21/bin/java", "/usr/lib/jvm/openjdk-21/bin/java", "java"];
	for (const candidate of candidates) {
		try {
			execSync(`${candidate} -version`, { stdio: "ignore" });
			return candidate;
		} catch {
			// keep trying
		}
	}
	return null;
}

const javaProfile: SdkProfile = {
	id: "java",
	kind: "java",
	detect: () => detectJavaBin() !== null && existsSync(JAVA_JAR),
	spawn: (httpPort, grpcPort) => {
		const javaBin = detectJavaBin();
		if (javaBin === null) throw new Error("Java not detected; should not be called when detect() returned false");
		return spawn(javaBin, ["-jar", JAVA_JAR], {
			env: {
				...process.env,
				PORT: String(httpPort),
				GRPC_PORT: String(grpcPort),
				BLOK_TRANSPORT: "grpc",
				HOST: "127.0.0.1",
				LOG_LEVEL: "WARN",
			},
			stdio: ["ignore", "ignore", "inherit"],
		});
	},
};

const CSHARP_DLL = path.join(REPO_ROOT, "sdks/csharp/bin/release/Blok.Core.dll");

const csharpProfile: SdkProfile = {
	id: "csharp",
	kind: "csharp",
	detect: () => existsSync(CSHARP_DLL),
	spawn: (httpPort, grpcPort) =>
		spawn("dotnet", [CSHARP_DLL], {
			env: {
				...process.env,
				PORT: String(httpPort),
				GRPC_PORT: String(grpcPort),
				BLOK_TRANSPORT: "grpc",
				HOST: "127.0.0.1",
				LOG_LEVEL: "WARN",
			},
			stdio: ["ignore", "ignore", "inherit"],
		}),
};

const RUBY_SDK_ROOT = path.join(REPO_ROOT, "sdks/ruby");
const RUBY_SERVE_SCRIPT = path.join(RUBY_SDK_ROOT, "bin/serve.rb");

function detectRubyBin(): string | null {
	const candidates = ["/opt/homebrew/opt/ruby@3.3/bin/ruby", "/opt/homebrew/opt/ruby/bin/ruby", "ruby"];
	for (const bin of candidates) {
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

const rubyProfile: SdkProfile = {
	id: "ruby",
	kind: "ruby",
	detect: () => detectRubyBin() !== null && existsSync(RUBY_SERVE_SCRIPT),
	spawn: (httpPort, grpcPort) => {
		const rubyBin = detectRubyBin();
		if (rubyBin === null) throw new Error("Ruby not detected; should not be called when detect() returned false");
		return spawn(rubyBin, [RUBY_SERVE_SCRIPT], {
			env: {
				...process.env,
				PORT: String(httpPort),
				GRPC_PORT: String(grpcPort),
				BLOK_TRANSPORT: "grpc",
				HOST: "127.0.0.1",
				LOG_LEVEL: "WARN",
			},
			stdio: ["ignore", "ignore", "inherit"],
		});
	},
};

/**
 * PHP is intentionally NOT in the matrix. RoadRunner has its own daemon
 * lifecycle and the per-SDK PHP integration test
 * (`php-grpc.integration.test.ts`) already proves §17 parity. Adding it
 * here would double the matrix walltime without expanding coverage.
 *
 * If/when PHP support lands without RoadRunner (Path B from §11), revisit.
 */

/**
 * The full ordered list of SDK profiles the matrix iterates over.
 * Order is locked: Python first (most universally available locally),
 * then the binary-only SDKs (Rust/Go) which boot in <100 ms, then the
 * heavier JVM/.NET/Ruby tail.
 */
export const SDK_PROFILES: ReadonlyArray<SdkProfile> = [
	pythonProfile,
	goProfile,
	rustProfile,
	javaProfile,
	csharpProfile,
	rubyProfile,
];

// =============================================================================
// Adapter helpers
// =============================================================================

export function buildGrpcAdapter(kind: RuntimeKind, port: number): GrpcRuntimeAdapter {
	const config: GrpcAdapterConfig = {
		kind,
		host: "127.0.0.1",
		port,
		defaultDeadlineMs: 10_000,
		maxMessageBytes: GRPC_DEFAULTS.MAX_MESSAGE_BYTES,
		keepalive: {
			timeMs: GRPC_DEFAULTS.KEEPALIVE_TIME_MS,
			timeoutMs: GRPC_DEFAULTS.KEEPALIVE_TIMEOUT_MS,
			permitWithoutCalls: GRPC_DEFAULTS.KEEPALIVE_PERMIT_WITHOUT_CALLS,
		},
	};
	return new GrpcRuntimeAdapter(config);
}

/** Poll `Health.Check` until SERVING or timeout. */
export async function waitForGrpcHealth(adapter: GrpcRuntimeAdapter, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await adapter.checkHealth()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

/**
 * Gracefully terminate an SDK child process. Tries SIGTERM first, then
 * SIGKILL after `gracefulMs`. Resolves once the process has exited (or
 * the kill timer fires).
 */
export async function killSdkProcess(proc: ChildProcess | null, gracefulMs = 2_000): Promise<void> {
	if (!proc || proc.exitCode !== null) return;
	proc.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			resolve();
		}, gracefulMs);
		proc.on("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}
