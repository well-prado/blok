/**
 * Cross-language E2E test — TS runner ↔ PHP SDK over gRPC.
 *
 * Spawns the real RoadRunner daemon (`rr serve -c .rr.yaml`) bound to a random
 * port. RoadRunner handles HTTP/2 + gRPC framing in Go and dispatches each
 * call to a PHP worker (`php bin/serve.php` with `BLOK_TRANSPORT=grpc`),
 * proving the canonical `blok.runtime.v1.NodeRuntime` contract works
 * end-to-end through the spiral/roadrunner-grpc bridge.
 *
 * Requires the Path A toolchain (per master plan §16):
 *   brew install protobuf grpc roadrunner
 *   cd sdks/php && composer install
 *
 * Skips cleanly when `rr`, `php`, or composer deps are unavailable.
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { BlokError, type Context } from "@blokjs/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import RunnerNode from "../../../src/RunnerNode";
import { GrpcRuntimeAdapter } from "../../../src/adapters/grpc/GrpcRuntimeAdapter";
import { GRPC_DEFAULTS, type GrpcAdapterConfig } from "../../../src/adapters/grpc/types";

const PHP_SDK_ROOT = path.resolve(__dirname, "../../../../../sdks/php");
const PHP_RR_CONFIG = path.join(PHP_SDK_ROOT, ".rr.yaml");
const PHP_VENDOR_AUTOLOAD = path.join(PHP_SDK_ROOT, "vendor/autoload.php");

function detectRr(): string | null {
	for (const candidate of ["/opt/homebrew/bin/rr", "rr"]) {
		try {
			execSync(`${candidate} --version`, { stdio: "ignore" });
			return candidate;
		} catch {
			// keep trying
		}
	}
	return null;
}

function detectPhp(): string | null {
	for (const candidate of ["/opt/homebrew/bin/php", "php"]) {
		try {
			execSync(`${candidate} --version`, { stdio: "ignore" });
			return candidate;
		} catch {
			// keep trying
		}
	}
	return null;
}

const RR_BIN = detectRr();
const PHP_BIN = detectPhp();
const TOOLCHAIN_AVAILABLE =
	RR_BIN !== null && PHP_BIN !== null && existsSync(PHP_RR_CONFIG) && existsSync(PHP_VENDOR_AUTOLOAD);

async function reserveFreePort(): Promise<number> {
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

class PhpNode extends RunnerNode {
	async run() {
		return { success: true, data: null, error: null };
	}
}

function makeNode(stepName: string, registeredName: string): RunnerNode {
	const n = new PhpNode();
	n.name = stepName;
	n.node = registeredName;
	n.type = "runtime.php";
	return n;
}

function makeCtx(stepName: string, inputs: Record<string, unknown>, body: unknown): Context {
	return {
		id: "php-grpc-e2e",
		workflow_name: "php-grpc-e2e",
		workflow_path: "/test",
		request: {
			body,
			headers: { "content-type": "application/json" },
			params: {},
			query: {},
			cookies: {},
			method: "POST",
			url: "/test",
			baseUrl: "",
		} as unknown as Context["request"],
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: { [stepName]: { inputs } } as unknown as Context["config"],
		vars: {},
		env: {} as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
	};
}

function makeAdapterConfig(grpcPort: number): GrpcAdapterConfig {
	return {
		kind: "php",
		host: "127.0.0.1",
		port: grpcPort,
		defaultDeadlineMs: 5_000,
		maxMessageBytes: GRPC_DEFAULTS.MAX_MESSAGE_BYTES,
		keepalive: {
			timeMs: GRPC_DEFAULTS.KEEPALIVE_TIME_MS,
			timeoutMs: GRPC_DEFAULTS.KEEPALIVE_TIMEOUT_MS,
			permitWithoutCalls: GRPC_DEFAULTS.KEEPALIVE_PERMIT_WITHOUT_CALLS,
		},
	};
}

async function waitForHealth(adapter: GrpcRuntimeAdapter, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await adapter.checkHealth()) return true;
		await new Promise((r) => setTimeout(r, 150));
	}
	return false;
}

describe.skipIf(!TOOLCHAIN_AVAILABLE)("TS runner ↔ PHP SDK over gRPC (E2E via RoadRunner)", () => {
	let grpcPort: number;
	let proc: ChildProcess;
	let adapter: GrpcRuntimeAdapter;

	beforeAll(async () => {
		grpcPort = await reserveFreePort();

		// `rr serve` reads .rr.yaml from cwd and handles HTTP/2 framing in Go.
		// The PHP worker is auto-spawned with BLOK_TRANSPORT=grpc (set in the
		// .rr.yaml `server.env` block) so it enters the spiral worker loop.
		proc = spawn(
			RR_BIN as string,
			["serve", "-c", ".rr.yaml", "--override", `grpc.listen=tcp://127.0.0.1:${grpcPort}`],
			{
				cwd: PHP_SDK_ROOT,
				env: {
					...process.env,
					GRPC_PORT: String(grpcPort),
					HOST: "127.0.0.1",
				},
				stdio: ["ignore", "ignore", "inherit"],
			},
		);

		adapter = new GrpcRuntimeAdapter(makeAdapterConfig(grpcPort));

		const healthy = await waitForHealth(adapter, 20_000);
		if (!healthy) {
			throw new Error(`PHP SDK gRPC server did not become healthy on port ${grpcPort} within 20s`);
		}
	}, 25_000);

	afterAll(async () => {
		adapter?.close();
		if (proc && proc.exitCode === null) {
			proc.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					proc.kill("SIGKILL");
					resolve();
				}, 3_000);
				proc.on("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	});

	it("invokes hello-world over gRPC and receives the php-formatted greeting", async () => {
		const node = makeNode("step-greet", "hello-world");
		const ctx = makeCtx("step-greet", { prefix: "Hi" }, { name: "Blok" });

		const result = await adapter.execute(node, ctx);

		expect(result.success).toBe(true);
		expect(result.errors).toBeNull();

		const data = result.data as { message: string; language: string; timestamp: string };
		expect(data.message).toBe("Hi, Blok!");
		expect(data.language).toBe("php");
		expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("uses the default prefix from the node when inputs omit it", async () => {
		const node = makeNode("step-greet", "hello-world");
		const ctx = makeCtx("step-greet", {}, { name: "World" });

		const result = await adapter.execute(node, ctx);

		expect(result.success).toBe(true);
		const data = result.data as { message: string };
		expect(data.message).toBe("Hello, World!");
	});

	it("returns a structured BlokError when the registered node does not exist", async () => {
		const node = makeNode("step-missing", "nope-not-here");
		const ctx = makeCtx("step-missing", {}, {});

		const result = await adapter.execute(node, ctx);

		expect(result.success).toBe(false);
		expect(result.errors).toBeInstanceOf(BlokError);
		const err = result.errors as BlokError;
		expect(err.runtimeKind).toBe("runtime.php");
		expect(err.sdk).toBe("blok-php");
		expect(err.message).toMatch(/not found/i);
	});

	it("Health probe returns true while the PHP server is running", async () => {
		const healthy = await adapter.checkHealth();
		expect(healthy).toBe(true);
	});

	it("Health probe returns false against a port nothing is listening on", async () => {
		const deadPort = await reserveFreePort();
		const isolatedAdapter = new GrpcRuntimeAdapter(makeAdapterConfig(deadPort));
		try {
			const healthy = await isolatedAdapter.checkHealth();
			expect(healthy).toBe(false);
		} finally {
			isolatedAdapter.close();
		}
	});
});
