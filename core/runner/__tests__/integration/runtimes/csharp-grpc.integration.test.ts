/**
 * Cross-language E2E test — TS runner ↔ C# SDK over gRPC.
 *
 * Spawns the real C# SDK binary on a random port with `BLOK_TRANSPORT=grpc`
 * and proves the canonical `blok.runtime.v1.NodeRuntime` contract works
 * end-to-end across language boundaries.
 *
 * The test skips with a clear message when the C# binary is not present.
 *
 * Build the binary first:
 *   cd sdks/csharp && dotnet publish src/Blok.Core/Blok.Core.csproj -c Release -o bin/release --self-contained false
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { BlokError, type Context } from "@blokjs/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import RunnerNode from "../../../src/RunnerNode";
import { GrpcRuntimeAdapter } from "../../../src/adapters/grpc/GrpcRuntimeAdapter";
import { GRPC_DEFAULTS, type GrpcAdapterConfig } from "../../../src/adapters/grpc/types";

const CSHARP_DLL = path.resolve(__dirname, "../../../../../sdks/csharp/bin/release/Blok.Core.dll");
const CSHARP_AVAILABLE = existsSync(CSHARP_DLL);

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

class CSharpNode extends RunnerNode {
	async run() {
		return { success: true, data: null, error: null };
	}
}

function makeNode(stepName: string, registeredName: string): RunnerNode {
	const n = new CSharpNode();
	n.name = stepName;
	n.node = registeredName;
	n.type = "runtime.csharp";
	return n;
}

function makeCtx(stepName: string, inputs: Record<string, unknown>, body: unknown): Context {
	return {
		id: "csharp-grpc-e2e",
		workflow_name: "csharp-grpc-e2e",
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
		kind: "csharp",
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
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

describe.skipIf(!CSHARP_AVAILABLE)("TS runner ↔ C# SDK over gRPC (E2E)", () => {
	let httpPort: number;
	let grpcPort: number;
	let proc: ChildProcess;
	let adapter: GrpcRuntimeAdapter;

	beforeAll(async () => {
		httpPort = await reserveFreePort();
		grpcPort = await reserveFreePort();

		proc = spawn("dotnet", [CSHARP_DLL], {
			env: {
				...process.env,
				PORT: String(httpPort),
				GRPC_PORT: String(grpcPort),
				BLOK_TRANSPORT: "grpc",
				HOST: "127.0.0.1",
				LOG_LEVEL: "INFO",
				ASPNETCORE_URLS: "",
			},
			stdio: ["ignore", "ignore", "inherit"],
		});

		adapter = new GrpcRuntimeAdapter(makeAdapterConfig(grpcPort));

		const healthy = await waitForHealth(adapter, 15_000);
		if (!healthy) {
			throw new Error(`C# SDK gRPC server did not become healthy on port ${grpcPort} within 15s`);
		}
	}, 20_000);

	afterAll(async () => {
		adapter?.close();
		if (proc && proc.exitCode === null) {
			proc.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					proc.kill("SIGKILL");
					resolve();
				}, 2_000);
				proc.on("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	});

	it("invokes hello-world over gRPC and receives the csharp-formatted greeting", async () => {
		const node = makeNode("step-greet", "hello-world");
		const ctx = makeCtx("step-greet", { prefix: "Hi" }, { name: "Blok" });

		const result = await adapter.execute(node, ctx);

		expect(result.success).toBe(true);
		expect(result.errors).toBeNull();

		const data = result.data as { message: string; language: string; timestamp: string };
		expect(data.message).toBe("Hi, Blok!");
		expect(data.language).toBe("csharp");
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
		expect(err.runtimeKind).toBe("runtime.csharp");
		expect(err.sdk).toBe("blok-csharp");
		expect(err.message).toMatch(/not found/i);
	});

	it("Health probe returns true while the C# server is running", async () => {
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
		expect(data.language).toBe("csharp");
	});
});
