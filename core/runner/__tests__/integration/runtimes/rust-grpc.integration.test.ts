/**
 * Cross-language E2E test — TS runner ↔ Rust SDK over gRPC.
 *
 * Spawns the real Rust SDK binary (built with `--features grpc`) on a random
 * port and proves that the canonical `blok.runtime.v1.NodeRuntime` contract
 * works end-to-end across language boundaries.
 *
 * The test skips with a clear message when the Rust binary is not present
 * (unrelated CI environments and contributors who haven't built the Rust
 * SDK aren't blocked).
 *
 * Build the binary first:
 *   cd sdks/rust && cargo build --features grpc
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import type { Context } from "@blokjs/shared";
import { BlokError } from "@blokjs/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import RunnerNode from "../../../src/RunnerNode";
import { GrpcRuntimeAdapter } from "../../../src/adapters/grpc/GrpcRuntimeAdapter";
import { GRPC_DEFAULTS, type GrpcAdapterConfig } from "../../../src/adapters/grpc/types";

// Resolve the Rust binary built with the gRPC feature.
const RUST_BINARY = path.resolve(__dirname, "../../../../../sdks/rust/target/debug/blok");
const RUST_BINARY_AVAILABLE = existsSync(RUST_BINARY);

/** Reserve a free TCP port via the OS, then close so the SDK can bind it. */
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

class RustNode extends RunnerNode {
	async run() {
		return { success: true, data: null, error: null };
	}
}

function makeNode(stepName: string, registeredName: string): RunnerNode {
	const n = new RustNode();
	n.name = stepName;
	n.node = registeredName;
	n.type = "runtime.rust";
	return n;
}

function makeCtx(stepName: string, inputs: Record<string, unknown>, body: unknown): Context {
	return {
		id: "rust-grpc-e2e",
		workflow_name: "rust-grpc-e2e",
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
		kind: "rust",
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

/** Poll Health until SERVING or timeout. Returns true on success. */
async function waitForHealth(adapter: GrpcRuntimeAdapter, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await adapter.checkHealth()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

describe.skipIf(!RUST_BINARY_AVAILABLE)("TS runner ↔ Rust SDK over gRPC (E2E)", () => {
	let httpPort: number;
	let grpcPort: number;
	let rust: ChildProcess;
	let adapter: GrpcRuntimeAdapter;

	beforeAll(async () => {
		httpPort = await reserveFreePort();
		grpcPort = await reserveFreePort();

		// Spawn the Rust SDK with both transports listening on ephemeral ports.
		// stderr is inherited so test failures surface the SDK's own logs.
		rust = spawn(RUST_BINARY, [], {
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
		});

		adapter = new GrpcRuntimeAdapter(makeAdapterConfig(grpcPort));

		const healthy = await waitForHealth(adapter, 10_000);
		if (!healthy) {
			throw new Error(`Rust SDK gRPC server did not become healthy on port ${grpcPort} within 10s`);
		}
	}, 15_000);

	afterAll(async () => {
		adapter?.close();
		if (rust && rust.exitCode === null) {
			rust.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					rust.kill("SIGKILL");
					resolve();
				}, 1_000);
				rust.on("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	});

	it("invokes hello-world over gRPC and receives the rust-formatted greeting", async () => {
		const node = makeNode("step-greet", "hello-world");
		const ctx = makeCtx("step-greet", { prefix: "Hi" }, { name: "Blok" });

		const result = await adapter.execute(node, ctx);

		expect(result.success).toBe(true);
		expect(result.errors).toBeNull();

		const data = result.data as { message: string; language: string; timestamp: string };
		expect(data.message).toBe("Hi, Blok!");
		expect(data.language).toBe("rust");
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
		expect(err.runtimeKind).toBe("runtime.rust");
		expect(err.sdk).toBe("blok-rust");
		expect(err.message).toMatch(/not found/i);
	});

	it("Health probe returns true while the Rust server is running", async () => {
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

	it("ExecuteStream emits NodeStarted -> final and resolves to the same payload as Execute", async () => {
		const node = makeNode("step-greet", "hello-world");
		const ctx = makeCtx("step-greet", { prefix: "Hi" }, { name: "Blok" });

		const { events, result } = adapter.executeStream(node, ctx);
		const eventTypes: string[] = [];
		for await (const ev of events) eventTypes.push(ev.type);
		const final = await result;

		expect(eventTypes[0]).toBe("started");
		expect(eventTypes[eventTypes.length - 1]).toBe("final");

		expect(final.success).toBe(true);
		const data = final.data as { message: string; language: string };
		expect(data.message).toBe("Hi, Blok!");
		expect(data.language).toBe("rust");
	});
});
