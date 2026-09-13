/**
 * Warm-worker throughput, concurrency saturation, and process-count regression
 * for the three JavaScript execution targets (#942, ADR 0016 §3).
 *
 * It measures; it does not claim a target. Every number below is produced on
 * the machine that runs it, and the environment block is printed with the
 * results so a figure can never be quoted without the hardware it came from.
 *
 * What it proves, beyond the numbers:
 *   - worker reuse: the worker's own execution counter advances by exactly the
 *     number of calls, from ONE pid, for the whole sustained run;
 *   - bounded process count: the worker's direct-child count does not move
 *     under sustained concurrent load (no process per step);
 *   - backpressure: past the concurrency gate, calls are refused with a
 *     retryable `WORKER_OVERLOADED` rather than queued without limit.
 *
 * Run:  bun run benchmarks/js-runtime-worker.ts [calls] [maxConcurrency]
 *       bun run benchmarks/js-runtime-worker.ts --json > artifacts.json
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GrpcRuntimeAdapter } from "@blokjs/runner";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO_ROOT, "packages/js-runtime-worker/dist/bin.js");

const JSON_OUT = process.argv.includes("--json");
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const CALLS = Number(positional[0] ?? 2000);
const PEAK_CONCURRENCY = Number(positional[1] ?? 64);
const CONCURRENCY_SWEEP = [1, 4, 16, 64, 256].filter((c) => c <= Math.max(PEAK_CONCURRENCY, 256));
/** Payload the step carries. Small on purpose: this measures the worker, not the wire. */
const INPUTS = { name: "Ada", repeat: 2 };

const ENGINES = [
	{ target: "node", kind: "nodejs", bin: "node" },
	{ target: "bun", kind: "bun", bin: "bun" },
	{ target: "deno", kind: "deno", bin: "deno" },
] as const;

function say(line: string): void {
	if (!JSON_OUT) console.log(line);
}

function binaryVersion(bin: string): string | null {
	try {
		return execFileSync(bin, ["--version"], { encoding: "utf8" }).trim().split("\n")[0];
	} catch {
		return null;
	}
}

function claimPort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
	});
}

async function boot(
	engine: (typeof ENGINES)[number],
	port: number,
	extraEnv: Record<string, string> = {},
): Promise<ChildProcess> {
	const args =
		engine.target === "deno"
			? [
					"run",
					`--allow-net=127.0.0.1:${port},localhost:${port}`,
					`--allow-read=${REPO_ROOT}`,
					"--allow-env",
					"--node-modules-dir=manual",
					ENTRY,
				]
			: [ENTRY];
	const child = spawn(engine.bin, args, {
		cwd: path.join(REPO_ROOT, "packages/js-runtime-worker"),
		env: { ...process.env, GRPC_PORT: String(port), HOST: "127.0.0.1", ...extraEnv },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = "";
	child.stdout?.on("data", (b) => {
		log += String(b);
	});
	child.stderr?.on("data", (b) => {
		log += String(b);
	});
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (log.includes("serving on")) return child;
		if (child.exitCode !== null) throw new Error(`${engine.bin} worker exited (${child.exitCode}):\n${log}`);
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`${engine.bin} worker never became ready:\n${log}`);
}

/** Direct children of `pid` — the process-per-step regression check. */
function childCount(pid: number): number {
	try {
		return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
			.split("\n")
			.filter(Boolean).length;
	} catch {
		return 0; // pgrep exits 1 when there are no matches
	}
}

/** Resident set (KiB) and accumulated CPU time (seconds) of a live process. */
function processCost(pid: number): { rssKb: number; cpuSeconds: number } {
	try {
		const out = execFileSync("ps", ["-o", "rss=,time=", "-p", String(pid)], { encoding: "utf8" }).trim();
		const [rss, time] = out.split(/\s+/);
		const parts = (time ?? "0:00").split(":").map(Number);
		const cpuSeconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
		return { rssKb: Number(rss ?? 0), cpuSeconds };
	} catch {
		return { rssKb: 0, cpuSeconds: 0 };
	}
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}

type ExecFn = (
	node: string,
	inputs: unknown,
) => Promise<{ success?: boolean; data?: Record<string, unknown> | null; errors?: unknown }>;

function executor(adapter: GrpcRuntimeAdapter, kind: string): ExecFn {
	const ctx = (inputs: unknown) => ({
		id: "bench",
		request: { body: {}, headers: {}, params: {}, query: {}, method: "POST", url: "/", cookies: {}, baseUrl: "" },
		response: { data: null, contentType: "application/json", success: true, error: null },
		state: {},
		vars: {},
		env: {},
		config: { s1: { inputs } },
	});
	return (node, inputs) =>
		adapter.execute({ node, name: "s1", type: `runtime.${kind}` } as never, ctx(inputs) as never) as never;
}

interface PhaseResult {
	concurrency: number;
	calls: number;
	wallMs: number;
	rps: number;
	p50: number;
	p95: number;
	p99: number;
	errors: number;
	overloaded: number;
}

/** `calls` executions at a fixed in-flight `concurrency`, measured per call. */
async function phase(run: ExecFn, calls: number, concurrency: number): Promise<PhaseResult> {
	const latencies: number[] = [];
	let errors = 0;
	let overloaded = 0;
	let issued = 0;
	const wall = performance.now();

	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			for (;;) {
				if (issued >= calls) return;
				issued++;
				const started = performance.now();
				const result = await run("typed-greet", INPUTS).catch((err: unknown) => ({
					success: false,
					errors: String(err),
				}));
				latencies.push(performance.now() - started);
				if (result.success !== true) {
					errors++;
					if (JSON.stringify(result.errors ?? "").includes("WORKER_OVERLOADED")) overloaded++;
				}
			}
		}),
	);

	const wallMs = performance.now() - wall;
	const sorted = [...latencies].sort((a, b) => a - b);
	return {
		concurrency,
		calls,
		wallMs,
		rps: (calls / wallMs) * 1000,
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		p99: percentile(sorted, 99),
		errors,
		overloaded,
	};
}

interface BackpressureResult {
	capacity: number;
	inFlight: number;
	succeeded: number;
	overloaded: number;
	otherErrors: number;
}

/**
 * Saturate a DELIBERATELY tiny worker and check what happens past the gate.
 * The default worker (64 concurrent + 256 queued) absorbs anything this
 * harness can throw at it on one box, so a backpressure test against it would
 * only ever prove that the machine is slower than the limit.
 */
async function backpressure(engine: (typeof ENGINES)[number]): Promise<BackpressureResult> {
	const concurrency = 2;
	const queue = 2;
	const inFlight = 64;
	const port = await claimPort();
	const child = await boot(engine, port, {
		BLOK_WORKER_MAX_CONCURRENCY: String(concurrency),
		BLOK_WORKER_MAX_QUEUE: String(queue),
	});
	const adapter = new GrpcRuntimeAdapter({
		kind: engine.kind as never,
		host: "127.0.0.1",
		port,
		defaultDeadlineMs: 30_000,
		maxMessageBytes: 16 * 1024 * 1024,
		keepalive: { timeMs: 10_000, timeoutMs: 5_000, permitWithoutCalls: true },
		healthCheckIntervalMs: 0,
	});
	const run = executor(adapter, engine.kind);
	try {
		const results = await Promise.all(
			Array.from({ length: inFlight }, () =>
				run("slow-echo", { ms: 250, value: "x" }).catch((err: unknown) => ({ success: false, errors: String(err) })),
			),
		);
		let succeeded = 0;
		let overloaded = 0;
		let otherErrors = 0;
		for (const result of results) {
			if (result.success === true) succeeded++;
			else if (JSON.stringify(result.errors ?? "").includes("WORKER_OVERLOADED")) overloaded++;
			else otherErrors++;
		}
		return { capacity: concurrency + queue, inFlight, succeeded, overloaded, otherErrors };
	} finally {
		adapter.close();
		await new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.kill("SIGKILL");
			setTimeout(resolve, 5_000);
		});
	}
}

interface EngineResult {
	engine: string;
	kind: string;
	version: string;
	pid: number;
	warm: PhaseResult;
	sweep: PhaseResult[];
	backpressure: BackpressureResult;
	reuse: { executionsDelta: number; expected: number; singlePid: boolean };
	processes: { before: number; after: number };
	cost: { rssKbBefore: number; rssKbAfter: number; cpuSeconds: number };
}

async function benchmarkEngine(engine: (typeof ENGINES)[number], version: string): Promise<EngineResult> {
	const port = await claimPort();
	const child = await boot(engine, port);
	const pid = child.pid as number;
	const adapter = new GrpcRuntimeAdapter({
		kind: engine.kind as never,
		host: "127.0.0.1",
		port,
		defaultDeadlineMs: 30_000,
		maxMessageBytes: 16 * 1024 * 1024,
		keepalive: { timeMs: 10_000, timeoutMs: 5_000, permitWithoutCalls: true },
		healthCheckIntervalMs: 0,
	});
	const run = executor(adapter, engine.kind);

	try {
		// Warm the worker: JIT, module graph, and the gRPC channel. Measuring a
		// cold process would measure startup, which is not what a persistent
		// worker's steady state costs.
		await phase(run, 200, 8);

		const before = childCount(pid);
		const costBefore = processCost(pid);
		const baseline = ((await run("worker-info", {})).data?.executions as number) ?? 0;

		const warm = await phase(run, CALLS, PEAK_CONCURRENCY);

		const sweep: PhaseResult[] = [];
		for (const concurrency of CONCURRENCY_SWEEP) {
			sweep.push(await phase(run, Math.max(200, Math.floor(CALLS / 4)), concurrency));
		}

		const info = (await run("worker-info", {})).data as { executions: number; pid: number };
		const after = childCount(pid);
		const costAfter = processCost(pid);
		const expected = warm.calls + sweep.reduce((total, s) => total + s.calls, 0) + 1 /* the worker-info call itself */;
		const gate = await backpressure(engine);

		return {
			backpressure: gate,
			engine: engine.target,
			kind: engine.kind,
			version,
			pid,
			warm,
			sweep,
			reuse: { executionsDelta: info.executions - baseline, expected, singlePid: info.pid === pid },
			processes: { before, after },
			cost: {
				rssKbBefore: costBefore.rssKb,
				rssKbAfter: costAfter.rssKb,
				cpuSeconds: costAfter.cpuSeconds - costBefore.cpuSeconds,
			},
		};
	} finally {
		adapter.close();
		await new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.kill("SIGTERM");
			setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 5_000);
		});
	}
}

function environment(): Record<string, unknown> {
	const cpus = os.cpus();
	let commit = "unknown";
	try {
		commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
	} catch {
		// not a git checkout
	}
	return {
		platform: `${os.platform()} ${os.release()} ${os.arch()}`,
		cpu: cpus[0]?.model ?? "unknown",
		cores: cpus.length,
		totalMemGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
		harness: `bun ${process.versions.bun ?? process.versions.node}`,
		commit,
		workload: `typed-greet (${JSON.stringify(INPUTS).length} B inputs), ${CALLS} calls at concurrency ${PEAK_CONCURRENCY}`,
		date: new Date().toISOString(),
	};
}

if (!existsSync(ENTRY)) {
	console.error(`${ENTRY} is missing — run \`bun run build\` first.`);
	process.exit(1);
}

const env = environment();
say("JavaScript runtime worker — warm throughput, saturation, and process-count regression");
say("");
for (const [key, value] of Object.entries(env)) say(`  ${key.padEnd(12)} ${String(value)}`);

const results: EngineResult[] = [];
for (const engine of ENGINES) {
	const version = binaryVersion(engine.bin);
	if (version === null) {
		say(`\n${engine.bin}: not installed — skipped`);
		continue;
	}
	say(`\n=== ${engine.bin} (${version}) → runtime.${engine.kind} ===`);
	const result = await benchmarkEngine(engine, version);
	results.push(result);

	const w = result.warm;
	say(
		`  warm        ${w.calls} calls @ ${w.concurrency} concurrent: ${w.rps.toFixed(0)} rps, ` +
			`p50 ${w.p50.toFixed(2)}ms  p95 ${w.p95.toFixed(2)}ms  p99 ${w.p99.toFixed(2)}ms, ` +
			`${w.errors} error(s)`,
	);
	say("  saturation  concurrency     rps      p50      p95      p99   errors  overloaded");
	for (const s of result.sweep) {
		say(
			`              ${String(s.concurrency).padStart(11)} ${s.rps.toFixed(0).padStart(7)} ` +
				`${s.p50.toFixed(2).padStart(8)} ${s.p95.toFixed(2).padStart(8)} ${s.p99.toFixed(2).padStart(8)} ` +
				`${String(s.errors).padStart(8)} ${String(s.overloaded).padStart(11)}`,
		);
	}
	say(
		`  reuse       executions +${result.reuse.executionsDelta} (expected ${result.reuse.expected}), ` +
			`single pid: ${result.reuse.singlePid}`,
	);
	say(`  processes   direct children ${result.processes.before} → ${result.processes.after} (must not grow)`);
	say(
		`  cost        RSS ${(result.cost.rssKbBefore / 1024).toFixed(0)} → ${(result.cost.rssKbAfter / 1024).toFixed(0)} MiB, ` +
			`CPU ${result.cost.cpuSeconds.toFixed(2)}s over the measured phases`,
	);
	const bp = result.backpressure;
	say(
		`  backpress.  ${bp.inFlight} in flight against capacity ${bp.capacity}: ` +
			`${bp.succeeded} served, ${bp.overloaded} WORKER_OVERLOADED, ${bp.otherErrors} other`,
	);
}

// The regression assertions. A benchmark that only prints numbers cannot fail,
// and "no process per step" is exactly the property that must fail loudly.
let failed = false;
for (const result of results) {
	if (result.processes.after !== result.processes.before) {
		console.error(
			`FAIL ${result.engine}: direct child count moved ${result.processes.before} → ${result.processes.after} under load — something is spawning per step.`,
		);
		failed = true;
	}
	if (!result.reuse.singlePid || result.reuse.executionsDelta !== result.reuse.expected) {
		console.error(
			`FAIL ${result.engine}: worker reuse not proven (executions +${result.reuse.executionsDelta}, expected ${result.reuse.expected}, single pid ${result.reuse.singlePid}).`,
		);
		failed = true;
	}
	if (result.backpressure.overloaded === 0 || result.backpressure.otherErrors > 0) {
		console.error(
			`FAIL ${result.engine}: backpressure did not engage (${result.backpressure.overloaded} overloaded, ${result.backpressure.otherErrors} other errors) — the gate must refuse, not queue without limit.`,
		);
		failed = true;
	}
	if (result.warm.errors > 0) {
		console.error(`FAIL ${result.engine}: ${result.warm.errors} error(s) in the warm phase.`);
		failed = true;
	}
}

if (JSON_OUT) console.log(JSON.stringify({ environment: env, results }, null, 2));
process.exit(failed ? 1 : 0);
