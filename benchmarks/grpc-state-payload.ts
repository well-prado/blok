/**
 * Runtime-boundary payload harness (#874).
 *
 * A `runtime.*` step called N times over REAL gRPC (loopback, in-process echo
 * server), against a `ctx.state` that accumulates one step output per
 * iteration — the shape of a pipeline whose steps persist as they go. The
 * runner used to ship that whole state bag on every call, so per-call cost was
 * linear in the accumulated state and the total was O(n²).
 *
 * Reports request bytes + per-call wall time by decile, with the state diet
 * ON (the default since #874) and OFF (`BLOK_GRPC_STATE_DIET=0`, the old
 * payload) in the same process.
 *
 * Run: bun run benchmarks/grpc-state-payload.ts [calls] [bytesPerStateEntry]
 */
import { GrpcRuntimeAdapter, getNodeRuntimeService } from "@blokjs/runner";
import type { Context } from "@blokjs/shared";
import { ServerCredentials, Server as ServerCtor } from "@grpc/grpc-js";

const CALLS = Number(process.argv[2] ?? 600);
const ENTRY_BYTES = Number(process.argv[3] ?? 512);

/** The adapter reads only `name` / `node` / `type` off the step. */
type Step = Parameters<GrpcRuntimeAdapter["execute"]>[0];
const NODE = { name: "parse", node: "parse", type: "runtime.rust" } as unknown as Step;

/** ctx whose `state` holds `n` accumulated step outputs (`ctx.vars` aliases it). */
function makeCtx(n: number): Context {
	const state: Record<string, unknown> = {};
	const filler = "x".repeat(ENTRY_BYTES);
	for (let i = 0; i < n; i++) state[`parse-${i}`] = { path: `src/file-${i}.ts`, body: filler };
	return {
		id: "run_bench",
		workflow_name: "index-repo",
		workflow_path: "/index-repo",
		request: {
			body: { repo: "well-prado/blok" },
			headers: {},
			params: {},
			query: {},
			cookies: {},
			method: "POST",
			url: "/index-repo",
			baseUrl: "",
		} as unknown as Context["request"],
		response: { data: { previous: 1 }, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: {
			parse: { inputs: { path: "src/file.ts", source: "export const a = 1;" } },
		} as unknown as Context["config"],
		state: state as Context["state"],
		vars: state as Context["vars"],
		env: {} as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;
}

async function startEchoServer(): Promise<{ port: number; stop: () => Promise<void> }> {
	const server = new ServerCtor();
	const service = getNodeRuntimeService() as unknown as { service: Parameters<typeof server.addService>[0] };
	server.addService(service.service, {
		Execute: (
			call: { request: { inputs: Buffer } },
			callback: (err: null, response: Record<string, unknown>) => void,
		) => {
			callback(null, {
				success: true,
				data: call.request.inputs,
				contentType: "application/json",
				error: null,
				varsDelta: Buffer.alloc(0),
				logs: [],
				metrics: null,
			});
		},
		Health: (_call: unknown, callback: (err: null, response: Record<string, unknown>) => void) => {
			callback(null, { status: "SERVING", sdkVersion: "1.0.0", registeredNodes: [] });
		},
		ListNodes: (_call: unknown, callback: (err: null, response: Record<string, unknown>) => void) => {
			callback(null, { nodes: [], sdkName: "bench", sdkVersion: "1.0.0", protoVersion: "1.0.0" });
		},
		ExecuteStream: (call: { end: () => void }) => call.end(),
	});
	const port = await new Promise<number>((resolve, reject) => {
		server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p)));
	});
	return { port, stop: () => new Promise<void>((resolve) => server.tryShutdown(() => resolve())) };
}

function decile(xs: number[], d: number): number {
	const slice = xs.slice(Math.floor((xs.length * d) / 10), Math.floor((xs.length * (d + 1)) / 10));
	return slice.reduce((a, b) => a + b, 0) / slice.length;
}

async function phase(label: string, adapter: GrpcRuntimeAdapter): Promise<void> {
	const times: number[] = [];
	const bytes: number[] = [];
	const wall = performance.now();
	for (let i = 0; i < CALLS; i++) {
		const ctx = makeCtx(i); // state accumulates one entry per completed call
		const t = performance.now();
		const res = await adapter.execute(NODE, ctx);
		times.push(performance.now() - t);
		bytes.push(res.metrics?.request_bytes ?? 0);
		if (!res.success) throw new Error(`call ${i} failed: ${JSON.stringify(res.errors)}`);
	}
	const total = performance.now() - wall;
	const totalBytes = bytes.reduce((a, b) => a + b, 0);
	console.log(`\n${label}`);
	console.log(`  total            ${total.toFixed(0)}ms for ${CALLS} calls (${(total / CALLS).toFixed(2)}ms/call)`);
	console.log(
		`  bytes sent       ${(totalBytes / 1024 / 1024).toFixed(2)} MiB total, ${Math.round(totalBytes / CALLS)} B/call avg`,
	);
	console.log(`  first/last call  ${bytes[0]} B -> ${bytes[bytes.length - 1]} B`);
	console.log(`  ms by decile     ${Array.from({ length: 10 }, (_, d) => decile(times, d).toFixed(2)).join("  ")}`);
}

const mock = await startEchoServer();
const adapter = new GrpcRuntimeAdapter({
	kind: "rust",
	host: "127.0.0.1",
	port: mock.port,
	defaultDeadlineMs: 30_000,
	maxMessageBytes: 256 * 1024 * 1024,
	keepalive: { timeMs: 30_000, timeoutMs: 5_000, permitWithoutCalls: true },
	healthCheckIntervalMs: 0,
});

console.log(`#874 — ${CALLS} runtime.rust calls, state grows by one ${ENTRY_BYTES}B step output per call`);

process.env.BLOK_GRPC_STATE_DIET = "0";
await phase("BLOK_GRPC_STATE_DIET=0  (pre-#874 default: full accumulated state on every call)", adapter);

// biome-ignore lint/performance/noDelete: must fully unset, not store "undefined"
delete process.env.BLOK_GRPC_STATE_DIET;
await phase("default                 (state diet on)", adapter);

adapter.close();
await mock.stop();
