/**
 * The orchestrator half of the portable conformance matrix (issue #942).
 *
 * `conformance.test.ts` proves what one worker does with one step. This proves
 * what the RUNNER does with those workers: handles and persisted state, branch,
 * switch, loop, forEach, try/catch, sub-workflows, deadlines, error
 * propagation, trace correlation and secret redaction — and a single workflow
 * whose steps run on Node.js, Bun AND Deno in turn.
 *
 * Everything here goes through the real `Configuration`/`Runner` over real
 * gRPC. Nothing is mocked; `runtime.<kind>` steps are dispatched by
 * `RuntimeRegistry` to the workers booted in `beforeAll`.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ifElseNode from "@blokjs/if-else";
import {
	GrpcRuntimeAdapter,
	ManualTrigger,
	NodeMap,
	RunTracker,
	RuntimeRegistry,
	WorkflowRegistry,
	WorkflowTestRunner,
} from "@blokjs/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "../..");
const ENTRY = path.join(PKG_ROOT, "dist", "bin.js");

const ENGINES = [
	{ target: "node", kind: "nodejs", bin: "node" },
	{ target: "bun", kind: "bun", bin: "bun" },
	{ target: "deno", kind: "deno", bin: "deno" },
] as const;

function binaryAvailable(bin: string): boolean {
	try {
		execFileSync(bin, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

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

const started: ChildProcess[] = [];

async function boot(engine: (typeof ENGINES)[number], port: number): Promise<void> {
	const args =
		engine.target === "deno"
			? [
					"run",
					"--allow-net=127.0.0.1,localhost",
					`--allow-read=${REPO_ROOT}`,
					"--allow-env",
					"--node-modules-dir=manual",
					ENTRY,
				]
			: [ENTRY];
	const child = spawn(engine.bin, args, {
		cwd: PKG_ROOT,
		env: { ...process.env, GRPC_PORT: String(port), HOST: "127.0.0.1", BLOK_WORKER_CONFORMANCE: "1" },
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
		if (log.includes("serving on")) return;
		if (child.exitCode !== null) throw new Error(`${engine.bin} worker exited (${child.exitCode}):\n${log}`);
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`${engine.bin} worker never reported ready:\n${log}`);
}

const available = ENGINES.filter((e) => binaryAvailable(e.bin));
const canRun = existsSync(ENTRY) && available.length === ENGINES.length;

/** `runtime.<kind>` step, spelled the way a JSON workflow spells it. */
function runtimeStep(id: string, use: string, kind: string, inputs: Record<string, unknown>): Record<string, unknown> {
	return { id, use, type: `runtime.${kind}`, inputs };
}

/** Structural reference to an upstream step's output — the JSON form of a handle. */
function ref(step: string, ...pathParts: string[]): Record<string, unknown> {
	return { $ref: { step, path: pathParts } };
}

function wf(name: string, steps: unknown[]): Record<string, unknown> {
	return { name, version: "1.0.0", trigger: { http: { method: "POST", path: `/${name}` } }, steps };
}

async function runWorkflowObject(
	model: Record<string, unknown>,
	input: Record<string, unknown> = {},
): Promise<{ success: boolean; state?: Record<string, unknown>; error?: unknown }> {
	const runner = new WorkflowTestRunner();
	// `branch` lowers to the real `@blokjs/if-else` node, exactly as it does in
	// a generated project (where it is an ordinary npm dependency).
	runner.registerNode("@blokjs/if-else", ifElseNode as never);
	runner.loadWorkflow(model);
	const result = await runner.execute(input);
	return result as never;
}

beforeAll(async () => {
	if (!canRun) return;
	// Pre-register the gRPC adapters BEFORE any Configuration exists:
	// `initializeRuntimeRegistry` only fills kinds it does not already have, so
	// this is what keeps `runtime.bun` from resolving to the in-process adapter
	// of the engine running vitest.
	RuntimeRegistry.getInstance().clear();
	for (const engine of ENGINES) {
		const port = await claimPort();
		await boot(engine, port);
		RuntimeRegistry.getInstance().register(
			new GrpcRuntimeAdapter({
				kind: engine.kind as never,
				host: "127.0.0.1",
				port,
				defaultDeadlineMs: 60_000,
				maxMessageBytes: 16 * 1024 * 1024,
				keepalive: { timeMs: 10_000, timeoutMs: 5_000, permitWithoutCalls: true },
				healthCheckIntervalMs: 0,
			}),
		);
	}
}, 180_000);

afterAll(async () => {
	RuntimeRegistry.getInstance().clear();
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
});

describe.skipIf(!canRun)("workflow conformance across the three JavaScript targets", () => {
	it("threads handles and persisted state through a Node.js → Bun → Deno chain", async () => {
		const result = await runWorkflowObject(
			wf("mixed-chain", [
				runtimeStep("seed", "conf-validate", "nodejs", { n: 5 }),
				runtimeStep("via-bun", "conf-validate", "bun", { n: ref("seed", "doubled") }),
				runtimeStep("via-deno", "conf-validate", "deno", { n: ref("via-bun", "doubled") }),
				runtimeStep("who", "conf-context", "deno", { note: "end-of-chain" }),
			]),
		);

		expect(result.success).toBe(true);
		// Every successful step persisted to ctx.state[id], and each read the
		// previous one's output through a structural reference.
		expect(result.state?.seed).toMatchObject({ doubled: 10 });
		expect(result.state?.["via-bun"]).toMatchObject({ doubled: 20 });
		expect(result.state?.["via-deno"]).toMatchObject({ doubled: 40 });
		// …and the engine that produced the last one really was Deno.
		expect(result.state?.who).toMatchObject({ runtime: "deno", note: "end-of-chain" });
	}, 60_000);

	it("takes a branch arm whose steps run on another engine", async () => {
		const build = (n: number) =>
			wf(`branch-${n}`, [
				runtimeStep("seed", "conf-validate", "nodejs", { n }),
				{
					id: "lane",
					branch: {
						when: "ctx.state.seed.doubled > 30",
						then: [runtimeStep("big", "conf-context", "bun", { note: "big" })],
						else: [runtimeStep("small", "conf-context", "deno", { note: "small" })],
					},
				},
			]);

		const big = await runWorkflowObject(build(20));
		expect(big.state?.big).toMatchObject({ note: "big", runtime: "bun" });
		expect(big.state?.small).toBeUndefined();

		const small = await runWorkflowObject(build(2));
		expect(small.state?.small).toMatchObject({ note: "small", runtime: "deno" });
		expect(small.state?.big).toBeUndefined();
	}, 60_000);

	it("selects a switch case that runs on a different engine", async () => {
		const result = await runWorkflowObject(
			wf("switch-case", [
				runtimeStep("seed", "conf-context", "nodejs", { note: "deno" }),
				{
					id: "pick",
					switch: {
						on: "js/ctx.state.seed.note",
						cases: [
							{ when: "bun", do: [runtimeStep("chose-bun", "conf-context", "bun", { note: "bun-arm" })] },
							{ when: "deno", do: [runtimeStep("chose-deno", "conf-context", "deno", { note: "deno-arm" })] },
						],
						default: [runtimeStep("chose-default", "conf-context", "nodejs", { note: "default-arm" })],
					},
				},
			]),
		);

		expect(result.success).toBe(true);
		expect(result.state?.["chose-deno"]).toMatchObject({ runtime: "deno", note: "deno-arm" });
		expect(result.state?.["chose-bun"]).toBeUndefined();
		expect(result.state?.["chose-default"]).toBeUndefined();
	}, 60_000);

	it("runs a forEach body on a remote engine, once per item", async () => {
		const result = await runWorkflowObject(
			wf("for-each", [
				{
					id: "each",
					forEach: {
						in: "js/ctx.request.body.numbers",
						as: "item",
						mode: "sequential",
						do: [runtimeStep("double", "conf-validate", "bun", { n: "js/ctx.state.item" })],
					},
				},
			]),
			{ numbers: [1, 2, 3] },
		);

		expect(result.success).toBe(true);
		// The forEach step collects one body output per item, in order.
		expect(result.state?.each).toEqual([{ doubled: 2 }, { doubled: 4 }, { doubled: 6 }]);
	}, 60_000);

	it("drives a loop whose body executes remotely until the condition flips", async () => {
		const result = await runWorkflowObject(
			wf("loop-until", [
				{ ...runtimeStep("seed-counter", "conf-validate", "nodejs", { n: 1 }), as: "counter" },
				{
					id: "grow",
					loop: {
						while: "(ctx.state.counter?.doubled ?? 0) < 16",
						maxIterations: 10,
						do: [
							{
								...runtimeStep("grow-counter", "conf-validate", "deno", { n: "js/ctx.state.counter.doubled" }),
								as: "counter",
							},
						],
					},
				},
			]),
		);

		expect(result.success).toBe(true);
		// 2 → 4 → 8 → 16, and then the guard stops it.
		expect(result.state?.counter).toMatchObject({ doubled: 16 });
	}, 60_000);

	it("catches a remote failure in try/catch and recovers on another engine", async () => {
		const result = await runWorkflowObject(
			wf("try-catch", [
				{
					id: "guarded",
					tryCatch: {
						try: [runtimeStep("explode", "conf-throw", "nodejs", {})],
						catch: [runtimeStep("recover", "conf-context", "deno", { note: "recovered" })],
					},
				},
			]),
		);

		expect(result.success).toBe(true);
		expect(result.state?.recover).toMatchObject({ note: "recovered", runtime: "deno" });
	}, 60_000);

	it("propagates an uncaught remote failure as a workflow failure", async () => {
		const result = await runWorkflowObject(
			wf("uncaught", [
				runtimeStep("explode", "conf-throw", "bun", {}),
				runtimeStep("never", "conf-context", "bun", { note: "unreachable" }),
			]),
		);

		expect(result.success).toBe(false);
		// A thrown step writes nothing, and nothing downstream of it runs.
		expect(result.state?.explode).toBeUndefined();
		expect(result.state?.never).toBeUndefined();
		expect(JSON.stringify(result.error ?? result)).toContain("conformance: thrown");
	}, 60_000);

	it("enforces a step deadline against a remote engine", async () => {
		const result = await runWorkflowObject(
			wf("deadline", [
				{
					...runtimeStep("slow", "slow-echo", "deno", { ms: 30_000, value: "never" }),
					maxDuration: 500,
				},
			]),
		);

		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error ?? result)).toMatch(/TIMEOUT|DEADLINE|timed out/i);
	}, 60_000);

	it("runs a sub-workflow whose steps target a different engine", async () => {
		WorkflowRegistry.getInstance().register({
			name: "conf-child",
			source: "/conf-child.ts",
			workflow: wf("conf-child", [runtimeStep("child-step", "conf-context", "bun", { note: "from-child" })]) as never,
		});

		const result = await runWorkflowObject(
			wf("conf-parent", [
				runtimeStep("before", "conf-validate", "nodejs", { n: 3 }),
				{ id: "delegate", subworkflow: "conf-child", inputs: {}, wait: true },
			]),
		);

		expect(result.success).toBe(true);
		expect(result.state?.before).toMatchObject({ doubled: 6 });
		expect(JSON.stringify(result.state?.delegate)).toContain("from-child");
	}, 60_000);

	it("correlates every remote step with the run trace and redacts secrets", async () => {
		RunTracker.resetInstance();
		WorkflowRegistry.resetInstance();
		const trigger = new ManualTrigger();
		trigger.setNodeMap({
			nodes: new NodeMap(),
			workflows: {
				"trace-conformance": wf("trace-conformance", [
					runtimeStep("on-node", "conf-env", "nodejs", { name: "CONF_PLAIN" }),
					runtimeStep("on-bun", "conf-context", "bun", { note: "traced", apiKey: "super-secret-value" }),
					runtimeStep("on-deno", "conf-context", "deno", { note: "traced" }),
				]) as never,
			},
		} as never);
		await trigger.listen();
		await trigger.dispatch("trace-conformance", {});

		const tracker = RunTracker.getInstance();
		const runs = tracker.getRuns({ limit: 5 } as never).runs;
		const run = runs.find((r) => r.workflowName === "trace-conformance");
		expect(run, "the run was recorded").toBeDefined();
		const nodeRuns = tracker.getNodeRuns((run as { id: string }).id);

		// One trace record per remote step, each tagged with the engine that ran it.
		const kinds = nodeRuns.map((n) => (n as { runtimeKind?: string }).runtimeKind).filter(Boolean);
		expect(kinds).toEqual(expect.arrayContaining(["nodejs", "bun", "deno"]));

		// A secret-shaped input never reaches the trace store in the clear.
		const recorded = JSON.stringify(nodeRuns);
		expect(recorded).not.toContain("super-secret-value");
		expect(recorded).toContain("REDACTED");
	}, 90_000);
});
