/**
 * SPEC-B end-to-end proof over REAL gRPC.
 *
 * Drives running SDK gRPC servers (all 7: Go/Rust/C#/Java/PHP/Ruby/Python3)
 * through the runner's OWN `GrpcRuntimeAdapter` — the client the runner uses per
 * step. Probes which runtimes are actually up and, per live runtime, proves:
 *   1. ListNodes returns the typed node WITH a real JSON Schema (SPEC-B P1.2 +
 *      each SDK's typed-schema emission).
 *   2. Execute validates the typed input (valid → typed output; invalid →
 *      structured error) — the typed contract over the wire.
 *   3. A cross-runtime chain threads ctx data through every live runtime in
 *      order, proving cross-runtime execution still works.
 *
 * Boot the servers + run via:  bash tests/e2e/cross-runtime/run-spec-b-e2e.sh
 */

import { GrpcRuntimeAdapter } from "@blokjs/runner";

type Json = Record<string, unknown>;
interface ExecResult {
	success?: boolean;
	data?: Json | null;
	errors?: unknown;
	error?: unknown;
}

const RUNTIMES = [
	{ kind: "go", port: Number(process.env.GO_GRPC_PORT ?? 20001) },
	{ kind: "rust", port: Number(process.env.RUST_GRPC_PORT ?? 20002) },
	{ kind: "csharp", port: Number(process.env.CS_GRPC_PORT ?? 20004) },
	{ kind: "java", port: Number(process.env.JAVA_GRPC_PORT ?? 20003) },
	{ kind: "php", port: Number(process.env.PHP_GRPC_PORT ?? 20005) },
	{ kind: "ruby", port: Number(process.env.RUBY_GRPC_PORT ?? 20006) },
	{ kind: "python3", port: Number(process.env.PY_GRPC_PORT ?? 20007) },
] as const;

function makeAdapter(kind: string, port: number): GrpcRuntimeAdapter {
	return new GrpcRuntimeAdapter({
		kind: kind as never,
		host: "localhost",
		port,
		defaultDeadlineMs: 30_000,
		maxMessageBytes: 16 * 1024 * 1024,
		keepalive: { timeMs: 10_000, timeoutMs: 5_000, permitWithoutCalls: true },
		healthCheckIntervalMs: 0,
	});
}

// The runner's RunnerNode shape: `node` = node name to run, `name` = step id
// (used to look up `ctx.config[stepId].inputs`), `type` = runtime kind.
const STEP_ID = "s1";
function runnerNode(nodeName: string, kind: string): unknown {
	return { node: nodeName, name: STEP_ID, type: `runtime.${kind}` };
}
function ctxWith(inputs: unknown): unknown {
	return {
		request: { body: {}, headers: {}, params: {}, query: {}, method: "POST", url: "/", cookies: {}, baseUrl: "" },
		response: { data: null, contentType: "application/json", success: true, error: null },
		state: {},
		vars: {},
		env: {},
		config: { [STEP_ID]: { inputs } },
	};
}

async function run(adapter: GrpcRuntimeAdapter, nodeName: string, kind: string, inputs: unknown): Promise<ExecResult> {
	// Boundary cast: the harness builds minimal node/ctx objects; the adapter's
	// RunnerNode/Context types are internal to the runner.
	const result = await adapter.execute(runnerNode(nodeName, kind) as never, ctxWith(inputs) as never);
	return result as unknown as ExecResult;
}

let pass = 0;
let fail = 0;
function check(cond: boolean, msg: string): void {
	if (cond) {
		pass++;
		console.log(`  ✓ ${msg}`);
	} else {
		fail++;
		console.log(`  ✗ ${msg}`);
	}
}

async function main(): Promise<void> {
	// Probe reachability (listNodes returns [] on a connection error) so the
	// harness runs against whatever subset of runtimes is actually booted.
	const live: { kind: string; port: number }[] = [];
	for (const r of RUNTIMES) {
		const nodes = await makeAdapter(r.kind, r.port).listNodes();
		if (nodes.length > 0) live.push(r);
		else console.log(`  • skipping ${r.kind} (:${r.port}) — not running`);
	}
	if (live.length === 0) {
		console.error("No runtimes reachable — boot servers first (run-spec-b-e2e.sh).");
		process.exit(2);
	}

	for (const { kind, port } of live) {
		console.log(`\n=== ${kind} (gRPC :${port}) ===`);
		const adapter = makeAdapter(kind, port);

		// 1. ListNodes — typed node present with real schema.
		const nodes = await adapter.listNodes();
		const names = nodes.map((n) => n.name);
		check(names.includes("typed-greet"), `${kind}: catalog lists typed-greet`);
		check(names.includes("chain-test"), `${kind}: catalog lists chain-test`);

		const tg = nodes.find((n) => n.name === "typed-greet");
		const inputJson = JSON.stringify(tg?.inputSchema ?? null);
		const outputJson = JSON.stringify(tg?.outputSchema ?? null);
		check(!!tg?.inputSchema && inputJson.includes("name"), `${kind}: typed-greet input schema has 'name'`);
		check(!!tg?.outputSchema && outputJson.includes("greeting"), `${kind}: typed-greet output schema has 'greeting'`);
		check((tg?.description ?? "").length > 0, `${kind}: typed-greet has a description ("${tg?.description}")`);

		// 2a. Execute — valid typed input → typed output.
		const ok = await run(adapter, "typed-greet", kind, { name: "Ada", repeat: 2 });
		check(ok.success === true, `${kind}: valid typed-greet → success`);
		check(ok.data?.greeting === "Hello, AdaHello, Ada", `${kind}: greeting = ${JSON.stringify(ok.data?.greeting)}`);
		check(ok.data?.length === 20, `${kind}: length = ${ok.data?.length}`);

		// 2b. Execute — invalid typed input (repeat is not an int) → structured error.
		const bad = await run(adapter, "typed-greet", kind, { name: "Ada", repeat: "not-a-number" });
		check(bad.success === false, `${kind}: invalid typed-greet → success=false`);
		const errStr = JSON.stringify(bad.errors ?? bad.error ?? null);
		check(
			errStr.includes("VALIDATION") || errStr.includes("validation") || errStr.includes("400"),
			`${kind}: invalid input → structured validation error (${errStr.slice(0, 100)})`,
		);
	}

	// 3. Cross-runtime chain through every booted runtime.
	const order = live.map((r) => r.kind);
	console.log(`\n=== Cross-runtime chain: ${order.join(" → ")} ===`);
	let chain: Json[] = [];
	const origin = "blok-cross-runtime-test";
	for (const { kind, port } of live) {
		const res = await run(makeAdapter(kind, port), "chain-test", kind, { chain, origin });
		check(res.success === true, `chain step ${kind} → success`);
		check(res.data?.origin === origin, `chain step ${kind} → origin preserved`);
		chain = (res.data?.chain as Json[] | undefined) ?? chain;
	}
	const langs = chain.map((e) => e.language);
	// chain-test appends each runtime's own language tag (== its kind).
	check(JSON.stringify(langs) === JSON.stringify(order), `chain languages = ${JSON.stringify(langs)}`);
	check(
		chain.every((e, i) => e.order === i + 1),
		`chain orders sequential 1..${chain.length}`,
	);
	check(chain.length === live.length, `chain has ${live.length} entries (one per runtime)`);

	console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
	process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(2);
});
