/**
 * Cross-language E2E test — TS runner ↔ Python SDK over gRPC.
 *
 * Spawns the real Python SDK (`bin/serve.py`) on a random port with
 * `BLOK_TRANSPORT=grpc` and proves that the canonical
 * `blok.runtime.v1.NodeRuntime` contract works end-to-end.
 *
 * Skips cleanly when:
 *   - Python 3.10+ is not available on the PATH, or
 *   - `grpcio` is not importable (the optional `[grpc]` extra is missing).
 *
 * Build-and-run instructions:
 *   pip install grpcio>=1.60 protobuf>=4.25
 *   bun run test  (this file runs as part of the runner integration suite)
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { BlokError, type Context } from "@blokjs/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import RunnerNode from "../../../src/RunnerNode";
import { RuntimeAdapterNode } from "../../../src/RuntimeAdapterNode";
import { GrpcRuntimeAdapter } from "../../../src/adapters/grpc/GrpcRuntimeAdapter";
import { GRPC_DEFAULTS, type GrpcAdapterConfig } from "../../../src/adapters/grpc/types";
import { RunTracker } from "../../../src/tracing/RunTracker";

const PYTHON_SDK_ROOT = path.resolve(__dirname, "../../../../../sdks/python3");
const PYTHON_SERVE_SCRIPT = path.join(PYTHON_SDK_ROOT, "bin/serve.py");

/** Detect whether Python + grpcio + the generated stubs are importable. */
function pythonGrpcAvailable(): boolean {
	try {
		execSync(`python3 -c "import grpc; from blok.runtime.v1 import runtime_pb2"`, {
			cwd: PYTHON_SDK_ROOT,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

const PYTHON_AVAILABLE = pythonGrpcAvailable();

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

class PyNode extends RunnerNode {
	async run() {
		return { success: true, data: null, error: null };
	}
}

function makeNode(stepName: string, registeredName: string): RunnerNode {
	const n = new PyNode();
	n.name = stepName;
	n.node = registeredName;
	n.type = "runtime.python3";
	return n;
}

function makeCtx(stepName: string, inputs: Record<string, unknown>, body: unknown): Context {
	return {
		id: "python-grpc-e2e",
		workflow_name: "python-grpc-e2e",
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
		kind: "python3",
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

describe.skipIf(!PYTHON_AVAILABLE)("TS runner ↔ Python SDK over gRPC (E2E)", () => {
	let httpPort: number;
	let grpcPort: number;
	let pyProc: ChildProcess;
	let adapter: GrpcRuntimeAdapter;

	beforeAll(async () => {
		httpPort = await reserveFreePort();
		grpcPort = await reserveFreePort();

		pyProc = spawn("python3", [PYTHON_SERVE_SCRIPT], {
			cwd: PYTHON_SDK_ROOT,
			env: {
				...process.env,
				PORT: String(httpPort),
				GRPC_PORT: String(grpcPort),
				BLOK_TRANSPORT: "grpc",
				HOST: "127.0.0.1",
				LOG_LEVEL: "INFO",
				PYTHONUNBUFFERED: "1",
			},
			stdio: ["ignore", "ignore", "inherit"],
		});

		adapter = new GrpcRuntimeAdapter(makeAdapterConfig(grpcPort));

		const healthy = await waitForHealth(adapter, 10_000);
		if (!healthy) {
			throw new Error(`Python SDK gRPC server did not become healthy on port ${grpcPort} within 10s`);
		}
	}, 15_000);

	afterAll(async () => {
		adapter?.close();
		if (pyProc && pyProc.exitCode === null) {
			pyProc.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					pyProc.kill("SIGKILL");
					resolve();
				}, 1_000);
				pyProc.on("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	});

	it("invokes hello-world over gRPC and receives the python-formatted greeting", async () => {
		const node = makeNode("step-greet", "hello-world");
		const ctx = makeCtx("step-greet", { prefix: "Hi" }, { name: "Blok" });

		const result = await adapter.execute(node, ctx);

		expect(result.success).toBe(true);
		expect(result.errors).toBeNull();

		const data = result.data as { message: string; language: string; timestamp: string };
		expect(data.message).toBe("Hi, Blok!");
		expect(data.language).toBe("python3");
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
		expect(err.runtimeKind).toBe("runtime.python3");
		expect(err.sdk).toBe("blok-python3");
		expect(err.message).toMatch(/not found/i);
	});

	it("Health probe returns true while the Python server is running", async () => {
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

	it("ExecuteStream emits NodeStarted -> log -> final and resolves to the same payload as Execute", async () => {
		const node = makeNode("step-greet", "hello-world");
		const ctx = makeCtx("step-greet", { prefix: "Hi" }, { name: "Blok" });

		const { events, result } = adapter.executeStream(node, ctx);
		const eventTypes: string[] = [];
		const logMessages: string[] = [];
		for await (const ev of events) {
			eventTypes.push(ev.type);
			if (ev.type === "log") logMessages.push(ev.log.message);
		}
		const final = await result;

		// Order: NodeStarted first, final last, log frames in between.
		expect(eventTypes[0]).toBe("started");
		expect(eventTypes[eventTypes.length - 1]).toBe("final");
		// hello-world emits one INFO log via the `blok.node` logger.
		expect(logMessages).toContain("greeting Blok with prefix 'Hi'");

		expect(final.success).toBe(true);
		const data = final.data as { message: string; language: string };
		expect(data.message).toBe("Hi, Blok!");
		expect(data.language).toBe("python3");
	});

	it("RuntimeAdapterNode in streaming mode forwards LogLine events to RunTracker.addLog (E2E SSE path)", async () => {
		// This test proves the full Phase 5 wire: Python emits a log on the
		// `blok.node` logger -> rendered as a LogLine ExecuteEvent on the
		// gRPC stream -> RuntimeAdapterNode (streamLogs=true) drains it ->
		// RunTracker.addLog records it -> the existing SSE endpoint surfaces
		// it without any UI changes (per master plan §10).
		const tracker = RunTracker.getInstance();

		// Seed a workflow run + node run so addLog has somewhere to attach.
		// startRun generates its own ID — capture it for getLogs() later.
		const run = tracker.startRun({
			workflowName: "stream-e2e",
			workflowPath: "/stream-e2e",
			triggerType: "http",
		});
		const traceRunId = run.id;
		const startedNode = tracker.startNode(traceRunId, {
			nodeName: "step-greet",
			nodeType: "runtime.python3",
			runtimeKind: "python3",
			depth: 0,
			stepIndex: 0,
		});
		const traceNodeId = startedNode.id;

		const target = makeNode("step-greet", "hello-world");
		const streamingNode = new RuntimeAdapterNode(adapter as unknown as GrpcRuntimeAdapter, target, {
			streamLogs: true,
		});

		const ctx = makeCtx("step-greet", { prefix: "Hi" }, { name: "Studio" });
		(ctx as Record<string, unknown>)._traceRunId = traceRunId;
		(ctx as Record<string, unknown>)._traceNodeId = traceNodeId;

		const response = await streamingNode.run(ctx);

		expect(response.success).toBe(true);
		const data = response.data as { message: string };
		expect(data.message).toBe("Hi, Studio!");

		// The Python hello-world emits one INFO log; it should be persisted
		// by the tracker and visible via getLogs.
		const logs = tracker.getLogs(traceRunId);
		const greetingLogs = logs.filter((l) => l.message.includes("greeting Studio"));
		expect(greetingLogs.length).toBeGreaterThanOrEqual(1);
		expect(greetingLogs[0].level).toBe("info");
		expect(greetingLogs[0].nodeName).toBe("step-greet");
	});
});
