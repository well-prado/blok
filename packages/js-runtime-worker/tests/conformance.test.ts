/**
 * The portable conformance matrix (issue #942 "Verification").
 *
 * ONE fixture set — `src/conformance/` — executed against the REAL worker
 * binary under every JavaScript engine present on the machine. The point of
 * the shape is that nothing below branches on the engine except where the
 * contract itself is engine-specific (the runtime-constrained fixtures); every
 * other assertion is identical for Node.js, Bun, and Deno, because that is what
 * "one Blok JavaScript contract with three execution backends" has to mean.
 *
 * Control flow, sub-workflows, state, and trace correlation are NOT here: they
 * live in the orchestrator, so they are proven by `conformance.workflow.test.ts`
 * driving the real runner over these same workers.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GrpcRuntimeAdapter } from "@blokjs/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "../..");
const ENTRY = path.join(PKG_ROOT, "dist", "bin.js");

interface Engine {
	target: "node" | "bun" | "deno";
	kind: string;
	bin: string;
	/** The one runtime-constrained fixture this engine must accept. */
	ownFixture: string;
	/** The two it must refuse. */
	foreignFixtures: string[];
}

const ENGINES: Engine[] = [
	{
		target: "node",
		kind: "nodejs",
		bin: "node",
		ownFixture: "conf-node-only",
		foreignFixtures: ["conf-bun-only", "conf-deno-only"],
	},
	{
		target: "bun",
		kind: "bun",
		bin: "bun",
		ownFixture: "conf-bun-only",
		foreignFixtures: ["conf-node-only", "conf-deno-only"],
	},
	{
		target: "deno",
		kind: "deno",
		bin: "deno",
		ownFixture: "conf-deno-only",
		foreignFixtures: ["conf-node-only", "conf-bun-only"],
	},
];

/** A port the OS just confirmed free — never a hard-coded one: a leaked worker
 * on a fixed port reads exactly like "this engine cannot serve gRPC". */
function claimPort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const probe = createTcpServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
	});
}

function binaryAvailable(bin: string): boolean {
	try {
		execFileSync(bin, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Shared claim-check directory: this process writes the blob, the worker
 * reads it. Same-host, exactly the ADR 0014 arrangement. */
const BLOB_DIR = mkdtempSync(path.join(tmpdir(), "blok-conf-blobs-"));

const started: ChildProcess[] = [];

async function boot(engine: Engine, port: number): Promise<ChildProcess> {
	const args =
		engine.target === "deno"
			? [
					"run",
					"--allow-net=127.0.0.1,localhost",
					`--allow-read=${REPO_ROOT},${BLOB_DIR}`,
					"--allow-env",
					"--node-modules-dir=manual",
					ENTRY,
				]
			: [ENTRY];
	const child = spawn(engine.bin, args, {
		cwd: PKG_ROOT,
		env: {
			...process.env,
			GRPC_PORT: String(port),
			HOST: "127.0.0.1",
			BLOK_WORKER_CONFORMANCE: "1",
			BLOK_BLOB_DIR: BLOB_DIR,
		},
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
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (log.includes("serving on")) return Object.assign(child, { bootLog: log });
		if (child.exitCode !== null) throw new Error(`${engine.bin} worker exited (${child.exitCode}):\n${log}`);
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`${engine.bin} worker never reported ready:\n${log}`);
}

function adapterFor(kind: string, port: number): GrpcRuntimeAdapter {
	return new GrpcRuntimeAdapter({
		kind: kind as never,
		host: "127.0.0.1",
		port,
		defaultDeadlineMs: 60_000,
		maxMessageBytes: 16 * 1024 * 1024,
		keepalive: { timeMs: 10_000, timeoutMs: 5_000, permitWithoutCalls: true },
		healthCheckIntervalMs: 0,
	});
}

interface ExecResult {
	success?: boolean;
	data?: Record<string, unknown> | null;
	errors?: unknown;
	logs?: Array<{ message?: string }>;
}

function ctxWith(inputs: unknown, env: Record<string, string> = {}): unknown {
	return {
		id: "conformance-run",
		workflow_name: "conformance",
		request: { body: {}, headers: {}, params: {}, query: {}, method: "POST", url: "/", cookies: {}, baseUrl: "" },
		response: { data: null, contentType: "application/json", success: true, error: null },
		state: { "upstream-step": { should: "not cross the boundary" } },
		vars: {},
		env,
		config: { s1: { inputs } },
	};
}

/** One local HTTP origin the `conf-fetch` fixture can reach on every engine. */
let echoUrl = "";
let echoServer: ReturnType<typeof createServer> | null = null;

beforeAll(async () => {
	echoServer = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("conformance-fetch-ok");
	});
	await new Promise<void>((resolve) => echoServer?.listen(0, "127.0.0.1", () => resolve()));
	const address = echoServer.address() as { port: number };
	echoUrl = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
	echoServer?.close();
	// Reap deliberately and WAIT: a leaked worker poisons the next run.
	await Promise.all(
		started.map(
			(child) =>
				new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) return resolve();
					child.once("exit", () => resolve());
					try {
						child.kill("SIGKILL");
					} catch {
						resolve();
					}
					setTimeout(resolve, 5_000);
				}),
		),
	);
	rmSync(BLOB_DIR, { recursive: true, force: true });
});

const available = ENGINES.filter((e) => binaryAvailable(e.bin));

describe.skipIf(!existsSync(ENTRY) || available.length === 0)("portable conformance matrix", () => {
	for (const engine of ENGINES) {
		describe.skipIf(!available.includes(engine))(`${engine.bin} → runtime.${engine.kind}`, () => {
			let adapter: GrpcRuntimeAdapter;
			let child: ChildProcess;
			let bootLog = "";

			const run = async (node: string, inputs: unknown, env?: Record<string, string>): Promise<ExecResult> =>
				(await adapter.execute(
					{ node, name: "s1", type: `runtime.${engine.kind}` } as never,
					ctxWith(inputs, env) as never,
				)) as never;

			beforeAll(async () => {
				const port = await claimPort();
				child = await boot(engine, port);
				bootLog = (child as unknown as { bootLog: string }).bootLog;
				adapter = adapterFor(engine.kind, port);
			}, 60_000);

			it("serves the whole portable fixture set", async () => {
				const names = (await adapter.listNodes()).map((n) => n.name);
				expect(names).toEqual(
					expect.arrayContaining([
						"conf-validate",
						"conf-context",
						"conf-env",
						"conf-fetch",
						"conf-throw",
						"conf-reject",
						"conf-non-serializable",
						"conf-bytes",
						"conf-modules",
					]),
				);
			});

			it("validates input and output against the declared Zod schemas", async () => {
				const ok = await run("conf-validate", { n: 21 });
				expect(ok.success).toBe(true);
				expect(ok.data).toMatchObject({ doubled: 42 });

				const badInput = await run("conf-validate", { n: "twenty-one" });
				expect(badInput.success).toBe(false);
				expect(JSON.stringify(badInput.errors)).toMatch(/VALIDATION/i);

				const badOutput = await run("conf-validate", { n: 1, breakOutput: true });
				expect(badOutput.success).toBe(false);
				expect(JSON.stringify(badOutput.errors)).toMatch(/VALIDATION/i);
			});

			it("projects the documented context and nothing more", async () => {
				const out = await run("conf-context", { note: "hello" });
				expect(out.success).toBe(true);
				expect(out.data).toMatchObject({
					runId: "conformance-run",
					workflowName: "conformance",
					runtime: engine.kind,
					note: "hello",
				});
				// ADR 0016 §3: accumulated workflow state does NOT cross the boundary.
				expect(out.data?.stateKeys).toEqual([]);
			});

			it("returns the structured logs a node emitted", async () => {
				const out = await run("conf-context", { note: "logged" });
				const messages = (out.logs ?? []).map((l) => String(l.message ?? l));
				expect(messages.some((m) => m.includes("conf-context run=conformance-run"))).toBe(true);
				expect(messages.some((m) => m.includes("second line"))).toBe(true);
			});

			it("reads the environment projection the runner sent", async () => {
				const out = await run("conf-env", { name: "CONF_VALUE" }, { CONF_VALUE: "from-runner" });
				expect(out.data).toMatchObject({ present: true, value: "from-runner" });
				// A variable only the WORKER's own process has must not leak in.
				const absent = await run("conf-env", { name: "PATH" }, { CONF_VALUE: "from-runner" });
				expect(absent.data).toMatchObject({ present: false });
			});

			it("performs async I/O with web-standard fetch", async () => {
				const out = await run("conf-fetch", { url: echoUrl });
				expect(out.success).toBe(true);
				expect(out.data).toMatchObject({ status: 200, body: "conformance-fetch-ok" });
			});

			it("maps a thrown error and a rejected promise to the same envelope", async () => {
				for (const [node, needle] of [
					["conf-throw", "conformance: thrown"],
					["conf-reject", "conformance: rejected"],
				]) {
					const out = await run(node, {});
					expect(out.success, node).toBe(false);
					expect(JSON.stringify(out.errors), node).toContain(needle);
				}
			});

			it("refuses a non-serializable result without dropping the worker", async () => {
				const out = await run("conf-non-serializable", {});
				expect(out.success).toBe(false);
				expect(JSON.stringify(out.errors).length).toBeGreaterThan(0);
				// Still serving: a bad result is an error, not a crash.
				expect((await run("conf-validate", { n: 2 })).data).toMatchObject({ doubled: 4 });
			});

			it("carries an oversized payload in and refuses an oversized one out", async () => {
				// 2 MiB inputs: over the adapter's 1 MiB offload threshold, so this
				// travels as a `blob-v1` claim-check the worker resolves.
				const payload = "z".repeat(2 * 1024 * 1024);
				const offloaded = await run("conf-bytes", { payload, out: 0 });
				expect(offloaded.success).toBe(true);
				expect(offloaded.data).toMatchObject({ received: payload.length });

				// Outbound has no claim-check (ADR 0014 is inbound-only), so the
				// boundary must be a structured error rather than a truncated frame.
				const tooBig = await run("conf-bytes", { out: 20 * 1024 * 1024 });
				expect(tooBig.success).toBe(false);
				expect(JSON.stringify(tooBig.errors)).toMatch(/TOO_LARGE|RESOURCE_EXHAUSTED|too large/i);
			});

			it("resolves ESM specifiers, package exports, dynamic import, JSON and top-level await", async () => {
				const out = await run("conf-modules", {});
				expect(out.success).toBe(true);
				expect(out.data).toMatchObject({
					relativeSum: 5,
					dynamic: "dynamic-import-ok",
					topLevelAwait: "top-level-await-ok",
					json: { marker: "json-module-ok", count: 3 },
					npmDependency: "zod-ok",
					packageExports: true,
				});
				// Measured, not asserted — the conformance doc records which
				// mechanism each engine used.
				console.log(`[conformance] ${engine.kind}: JSON module via ${out.data?.jsonVia}`);
				expect(String(out.data?.stack)).toContain("boom");
			});

			it("accepts only the runtime-constrained fixture that names this engine", async () => {
				const names = (await adapter.listNodes()).map((n) => n.name);
				expect(names).toContain(engine.ownFixture);
				for (const foreign of engine.foreignFixtures) {
					expect(names, foreign).not.toContain(foreign);
					// Refused at BOOT, with both sides named…
					expect(bootLog).toContain(foreign);
					expect(bootLog).toContain(`cannot run on runtime.${engine.kind}`);
					// …and refused again at execution, distinctly from "not found".
					const out = await run(foreign, {});
					expect(out.success, foreign).toBe(false);
					expect(JSON.stringify(out.errors), foreign).toContain("NODE_RUNTIME_INCOMPATIBLE");
				}
				expect((await run(engine.ownFixture, {})).success).toBe(true);
			});

			// LAST: this one kills the process every case above shares.
			it("dies on an unrecoverable node crash instead of hanging", async () => {
				const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
				await run("conf-crash", {}).catch(() => undefined);
				expect(await exited).toBe(94);
			});
		});
	}
});
