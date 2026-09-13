/**
 * Boots the REAL worker binary under every JavaScript engine present on the
 * machine and drives it with the runner's own `GrpcRuntimeAdapter` — the same
 * client a `runtime.bun` / `runtime.deno` / cross-host `runtime.nodejs` step
 * uses.
 *
 * The assertions that matter for ADR 0016 §3 are the topology ones: ONE
 * long-lived process serves N concurrent executions, and it spawns nothing per
 * step. A test that only checked "the call returned data" would pass just as
 * happily against a process-per-step implementation.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GrpcRuntimeAdapter } from "@blokjs/runner";
import * as grpc from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { afterAll, describe, expect, it } from "vitest";
import { RUNTIME_MANIFEST_METADATA_KEY } from "../src/server.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "../..");
const ENTRY = path.join(PKG_ROOT, "dist", "bin.js");
const PROTO = path.join(PKG_ROOT, "src", "proto", "blok", "runtime", "v1", "runtime.proto");

/** Engines to try, with the port each integration worker binds. */
const ENGINES = [
	{ target: "node", kind: "nodejs", bin: "node", port: 21012 },
	{ target: "bun", kind: "bun", bin: "bun", port: 21013 },
	{ target: "deno", kind: "deno", bin: "deno", port: 21014 },
] as const;

function binaryAvailable(bin: string): boolean {
	try {
		execFileSync(bin, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function launchArgs(engine: (typeof ENGINES)[number]): string[] {
	if (engine.target !== "deno") return [ENTRY];
	// Least-privilege: one port, read the repo, read env. No write/run/ffi.
	return [
		"run",
		`--allow-net=127.0.0.1:${engine.port},localhost:${engine.port}`,
		`--allow-read=${REPO_ROOT}`,
		"--allow-env",
		"--node-modules-dir=manual",
		ENTRY,
	];
}

const started: ChildProcess[] = [];

async function boot(engine: (typeof ENGINES)[number]): Promise<ChildProcess> {
	const child = spawn(engine.bin, launchArgs(engine), {
		cwd: PKG_ROOT,
		env: { ...process.env, GRPC_PORT: String(engine.port), HOST: "127.0.0.1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	started.push(child);
	let log = "";
	child.stdout?.on("data", (b) => {
		log += String(b);
	});
	child.stderr?.on("data", (b) => {
		log += String(b);
	});
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (log.includes("serving on")) return child;
		if (child.exitCode !== null) throw new Error(`${engine.bin} worker exited (${child.exitCode}):\n${log}`);
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`${engine.bin} worker never reported ready:\n${log}`);
}

function adapterFor(kind: string, port: number): GrpcRuntimeAdapter {
	return new GrpcRuntimeAdapter({
		kind: kind as never,
		host: "127.0.0.1",
		port,
		defaultDeadlineMs: 30_000,
		maxMessageBytes: 16 * 1024 * 1024,
		keepalive: { timeMs: 10_000, timeoutMs: 5_000, permitWithoutCalls: true },
		healthCheckIntervalMs: 0,
	});
}

function ctxWith(inputs: unknown): unknown {
	return {
		id: "worker-integration",
		request: { body: {}, headers: {}, params: {}, query: {}, method: "POST", url: "/", cookies: {}, baseUrl: "" },
		response: { data: null, contentType: "application/json", success: true, error: null },
		state: {},
		vars: {},
		env: {},
		config: { s1: { inputs } },
	};
}

async function run(
	adapter: GrpcRuntimeAdapter,
	node: string,
	kind: string,
	inputs: unknown,
): Promise<{ success?: boolean; data?: Record<string, unknown> | null; errors?: unknown }> {
	const result = await adapter.execute(
		{ node, name: "s1", type: `runtime.${kind}` } as never,
		ctxWith(inputs) as never,
	);
	return result as never;
}

/** Direct children of `pid`, via pgrep (present on macOS and Linux). */
function childPids(pid: number): string[] {
	try {
		return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
	} catch {
		return []; // pgrep exits 1 when there are no matches
	}
}

/** Raw client, for the two things the runner's adapter doesn't surface: the
 * ListNodes response metadata and a per-call `options.deadline_ms` that is
 * shorter than the gRPC deadline. */
function rawClient(port: number): grpc.Client & Record<string, unknown> {
	const def = loadSync(PROTO, { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true });
	const Ctor = (grpc.loadPackageDefinition(def) as never as Record<string, never>).blok as never as Record<
		string,
		Record<string, { NodeRuntime: new (a: string, c: grpc.ChannelCredentials) => grpc.Client }>
	>;
	return new Ctor.runtime.v1.NodeRuntime(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as never;
}

afterAll(() => {
	for (const child of started) {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
});

const available = ENGINES.filter((e) => binaryAvailable(e.bin));
const canRun = existsSync(ENTRY) && available.length > 0;

describe.skipIf(!canRun)("JavaScript runtime worker over real gRPC", () => {
	if (!existsSync(ENTRY)) {
		console.warn(`[worker-integration] ${ENTRY} missing — run \`bun run build\` first.`);
	}
	for (const engine of ENGINES) {
		const present = available.includes(engine);
		describe.skipIf(!present)(`${engine.bin} (runtime.${engine.kind})`, () => {
			let child: ChildProcess;
			let adapter: GrpcRuntimeAdapter;

			it("boots and serves its registry", async () => {
				child = await boot(engine);
				adapter = adapterFor(engine.kind, engine.port);
				const names = (await adapter.listNodes()).map((n) => n.name);
				expect(names).toEqual(expect.arrayContaining(["typed-greet", "chain-test", "worker-info", "slow-echo"]));
			});

			it("executes a typed node and reports its own engine", async () => {
				const out = await run(adapter, "typed-greet", engine.kind, { name: "Ada", repeat: 2 });
				expect(out.success).toBe(true);
				expect(out.data).toMatchObject({ greeting: "Hello, AdaHello, Ada", length: 20 });

				const info = await run(adapter, "worker-info", engine.kind, {});
				expect(info.data).toMatchObject({ runtime: engine.kind, pid: child.pid });
			});

			it("serves N concurrent executions from ONE process, spawning nothing per step", async () => {
				const pid = child.pid as number;
				const before = childPids(pid).length;
				const baseline = (await run(adapter, "worker-info", engine.kind, {})).data?.executions as number;

				const results = await Promise.all(
					Array.from({ length: 24 }, () => run(adapter, "worker-info", engine.kind, {})),
				);
				const after = childPids(pid).length;

				expect(results.every((r) => r.success === true)).toBe(true);
				// One process: every execution reports the SAME pid.
				expect(new Set(results.map((r) => r.data?.pid))).toEqual(new Set([pid]));
				// Reuse: the counter advanced by exactly the number of calls, so
				// none of them were served by a fresh registry.
				const highest = Math.max(...results.map((r) => r.data?.executions as number));
				expect(highest).toBe(baseline + 24);
				// No process-per-step: the worker's child count did not move.
				expect(after).toBe(before);
				expect(child.exitCode).toBeNull();
			});

			it("advertises its runtime capability manifest on ListNodes", async () => {
				const client = rawClient(engine.port);
				const manifest = await new Promise<Record<string, unknown>>((resolve, reject) => {
					const call = (client.ListNodes as (req: unknown, cb: (e: unknown) => void) => grpc.ClientUnaryCall)(
						{},
						(err: unknown) => {
							if (err) reject(err);
						},
					);
					call.on("metadata", (md: grpc.Metadata) => {
						const raw = md.get(RUNTIME_MANIFEST_METADATA_KEY)[0];
						resolve(JSON.parse(String(raw)));
					});
					call.on("error", reject);
				});
				expect(manifest).toMatchObject({ runtime: engine.target, protocolVersion: "1.0.0", cancellation: true });
				client.close();
			});

			it("enforces the per-call deadline and reports a TIMEOUT envelope", async () => {
				const client = rawClient(engine.port);
				const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
					(
						client.Execute as (
							req: unknown,
							opts: grpc.CallOptions,
							cb: (e: unknown, r: Record<string, unknown>) => void,
						) => void
					)(
						{
							node: { name: "slow-echo", type: `runtime.${engine.kind}`, version: "" },
							inputs: Buffer.from(JSON.stringify({ ms: 20_000 })),
							step: { name: "s1", index: 0, total: 1, depth: 0 },
							// A generous gRPC deadline, a short per-call one: this
							// isolates the WORKER's deadline handling from the client's.
							options: { deadlineMs: "300", streamLogs: false, captureMetrics: true },
						},
						{ deadline: Date.now() + 20_000 },
						(err, res) => (err ? reject(err) : resolve(res)),
					);
				});
				expect(response.success).toBe(false);
				expect((response.error as { code: string }).code).toBe("NODE_DEADLINE_EXCEEDED");
				expect((response.error as { category: string }).category).toBe("TIMEOUT");
				expect((response.error as { runtimeKind: string }).runtimeKind).toBe(`runtime.${engine.kind}`);
				client.close();
			});

			it("streams a started event and a final response", async () => {
				const { events, result } = adapter.executeStream(
					{ node: "typed-greet", name: "s1", type: `runtime.${engine.kind}` } as never,
					ctxWith({ name: "Ada", repeat: 1 }) as never,
				);
				const seen: string[] = [];
				for await (const event of events) seen.push(event.type);
				const final = await result;
				expect(seen).toContain("started");
				expect(final.success).toBe(true);
			});

			it("drains on SIGTERM instead of dropping the process", async () => {
				const pid = child.pid as number;
				const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
				process.kill(pid, "SIGTERM");
				await expect(exited).resolves.toBe(0);
			});
		});
	}
});
