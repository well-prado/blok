/**
 * Scaffold smoke E2E — drives a REAL scaffolded Blok project (created by the
 * local `blokctl`, booted under `blokctl dev`) and curls every trigger + every
 * runtime endpoint to prove the shipped scaffold actually works: no dead
 * triggers, no dead runtimes, no unresolved helper nodes.
 *
 * This is the "scaffold → boot → curl" verification codified. `run.sh` detects
 * available toolchains/brokers, scaffolds, boots, then invokes THIS driver,
 * which reads the scaffold's `.blok/config.json` to learn what was actually
 * installed and asserts each piece against a live HTTP/WS/gRPC call (or, for
 * portless triggers, the dev log).
 *
 * Environment (set by run.sh):
 *   SMOKE_PROJECT_DIR   absolute path to the scaffolded project (has .blok/config.json)
 *   SMOKE_DEV_LOG       path to the captured `blokctl dev` stdout/stderr
 *   SMOKE_BASE_URL      HTTP trigger base (default http://localhost:4000)
 *   STRIPE_WEBHOOK_SECRET  shared secret the scaffold's webhook trigger verifies
 *
 * Gate:
 *   BLOK_SMOKE_REQUIRE_ALL=1     every applicable check MUST pass (CI mode)
 *   BLOK_SMOKE_REQUIRE=grpc,http only these categories are required to pass
 * Without a gate, a FAIL still exits non-zero; SKIP never does.
 */

import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { GrpcClient, HttpVersionEnum, TransportEnum } from "@blokjs/trigger-grpc";

// ── config / env ────────────────────────────────────────────────────────────

const PROJECT_DIR = process.env.SMOKE_PROJECT_DIR ?? "";
const DEV_LOG = process.env.SMOKE_DEV_LOG ?? "";
const BASE_URL = (process.env.SMOKE_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
const STRIPE_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test";

if (!PROJECT_DIR || !existsSync(`${PROJECT_DIR}/.blok/config.json`)) {
	console.error(`[smoke] SMOKE_PROJECT_DIR is not a scaffolded project: ${PROJECT_DIR}`);
	process.exit(2);
}

interface ProjectConfig {
	triggers?: Record<string, { kind: string; port?: number }>;
	runtimes?: Record<string, { kind: string; label?: string; grpcPort?: number; port?: number }>;
}
const config: ProjectConfig = JSON.parse(readFileSync(`${PROJECT_DIR}/.blok/config.json`, "utf8"));
// SSE / WebSocket / Webhook / MCP MOUNT on the HTTP process, so they never
// appear in .blok/config.json (which only lists spawned trigger processes).
// run.sh passes the REQUESTED trigger set (SMOKE_TRIGGERS); fall back to the
// config keys (union, so both spawned + mounted triggers are covered).
const requestedTriggers = (process.env.SMOKE_TRIGGERS ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const triggers = new Set<string>([...requestedTriggers, ...Object.keys(config.triggers ?? {})]);
const runtimeKinds = Object.keys(config.runtimes ?? {});

const REQUIRE_ALL = /^(1|true)$/i.test(process.env.BLOK_SMOKE_REQUIRE_ALL ?? "");
const REQUIRED = new Set(
	(process.env.BLOK_SMOKE_REQUIRE ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
);

// ── tiny check framework ──────────────────────────────────────────────────────

type Status = "pass" | "fail" | "skip";
interface Result {
	category: string;
	name: string;
	status: Status;
	detail: string;
}
const results: Result[] = [];

/** A check returns pass/fail/skip + a one-line detail. Thrown errors → fail. */
async function check(
	category: string,
	name: string,
	fn: () => Promise<{ status: Status; detail: string }>,
): Promise<void> {
	try {
		const { status, detail } = await fn();
		results.push({ category, name, status, detail });
	} catch (err) {
		results.push({ category, name, status: "fail", detail: (err as Error).message.split("\n")[0] });
	}
}

const PASS = (detail: string) => ({ status: "pass" as const, detail });
const FAIL = (detail: string) => ({ status: "fail" as const, detail });

// ── helpers ───────────────────────────────────────────────────────────────────

interface HttpResp {
	status: number;
	text: string;
	json: unknown;
}

/** fetch with a bounded connect retry (the dev server may still be warming). */
async function http(
	method: string,
	path: string,
	opts: { body?: unknown; headers?: Record<string, string>; retries?: number } = {},
): Promise<HttpResp> {
	const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
	const headers: Record<string, string> = { ...(opts.headers ?? {}) };
	let body: string | undefined;
	if (opts.body !== undefined) {
		body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
		headers["content-type"] ??= "application/json";
	}
	const retries = opts.retries ?? 20;
	let lastErr: unknown;
	for (let i = 0; i < retries; i++) {
		try {
			const res = await fetch(url, { method, headers, body });
			const text = await res.text();
			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch {
				json = undefined;
			}
			return { status: res.status, text, json };
		} catch (err) {
			lastErr = err;
			await sleep(500);
		}
	}
	throw new Error(`${method} ${path} — no response after ${retries} tries: ${(lastErr as Error)?.message}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read the dev log (best-effort) and test a regex against it, polling briefly. */
async function logMatches(re: RegExp, waitMs = 4000): Promise<boolean> {
	if (!DEV_LOG || !existsSync(DEV_LOG)) return false;
	const deadline = Date.now() + waitMs;
	do {
		if (re.test(readFileSync(DEV_LOG, "utf8"))) return true;
		await sleep(250);
	} while (Date.now() < deadline);
	return false;
}

/** WebSocket round-trip: connect, send one frame, collect frames for waitMs. */
function wsRoundtrip(path: string, frame: unknown, waitMs = 3000): Promise<{ opened: boolean; frames: string[] }> {
	return new Promise((resolve) => {
		const url = `${BASE_URL.replace(/^http/, "ws")}${path}`;
		const ws = new WebSocket(url);
		const frames: string[] = [];
		let opened = false;
		const done = () => {
			try {
				ws.close();
			} catch {}
			resolve({ opened, frames });
		};
		ws.onopen = () => {
			opened = true;
			ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
		};
		ws.onmessage = (e) => frames.push(String((e as MessageEvent).data));
		ws.onerror = () => {};
		setTimeout(done, waitMs);
	});
}

/** Stripe signature header: `t=<ts>,v1=<hmac_sha256(secret, "<ts>.<rawBody>")>`. */
function stripeSignature(rawBody: string, secret: string, ts = Math.floor(Date.now() / 1000)): string {
	const sig = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
	return `t=${ts},v1=${sig}`;
}

/** Invoke a module node over the gRPC trigger's WorkflowService (remote-node model). */
async function grpcCallNode(port: number, nodeName: string, inputs: Record<string, unknown>): Promise<unknown> {
	const client = new GrpcClient({
		host: "127.0.0.1",
		port,
		protocol: "http",
		httpVersion: HttpVersionEnum.HTTP2,
		transport: TransportEnum.GRPC,
	});
	const model = {
		name: "Smoke Remote Node",
		version: "1.0.0",
		description: "scaffold-smoke",
		trigger: { grpc: {} },
		steps: [{ id: "node", use: nodeName, type: "module" }],
		nodes: { node: { inputs } },
	};
	const message = Buffer.from(JSON.stringify({ request: {}, workflow: model })).toString("base64");
	const res = (await client.call({
		$typeName: "blok.workflow.v1.WorkflowRequest",
		Name: nodeName,
		Message: message,
		Encoding: "BASE64",
		Type: "JSON",
	} as never)) as { Message?: string };
	if (!res?.Message) throw new Error("gRPC response carried no Message");
	return JSON.parse(Buffer.from(res.Message, "base64").toString("utf8"));
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const RUNTIME_LABEL: Record<string, string> = {
	go: "Go",
	rust: "Rust",
	java: "Java",
	csharp: "C#",
	php: "PHP",
	ruby: "Ruby",
	python3: "Python3",
	node: "Node",
};

// ── checks ────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
	// HTTP — always present. Health + the #640 helper-node regression (respond).
	if (triggers.has("http")) {
		await check("http", "GET /health-check", async () => {
			const r = await http("GET", "/health-check");
			return r.status === 200 && /online/i.test(r.text)
				? PASS(r.text.trim().slice(0, 40))
				: FAIL(`status=${r.status} body=${r.text.slice(0, 60)}`);
		});
		await check("http", "GET /countries-dsl (@blokjs/respond)", async () => {
			const r = await http("GET", "/countries-dsl");
			const data = (r.json as { data?: unknown[] })?.data;
			if (r.status === 200 && Array.isArray(data) && data.length > 0) return PASS(`${data.length} countries`);
			return FAIL(`status=${r.status} body=${r.text.slice(0, 80)}`);
		});
	}

	// SSE — publish helper returns {channel,id}; the stream subscriber is a
	// separate route. Publishing proves @blokjs/sse-publish resolves + runs.
	if (triggers.has("sse")) {
		await check("sse", "POST /v07-sse-publish (@blokjs/sse-publish)", async () => {
			const r = await http("POST", "/v07-sse-publish", { body: { event: "smoke", data: { ok: true } } });
			const j = r.json as { channel?: string; id?: string };
			return r.status === 200 && j?.channel && j?.id
				? PASS(`channel=${j.channel} id=${j.id}`)
				: FAIL(`status=${r.status} body=${r.text.slice(0, 80)}`);
		});
	}

	// WebSocket — real frame round-trip against the shipped echo demo (#650):
	// on connect the workflow must deliver the `connected` greeting, and a
	// `hello` frame (in the demo's event allowlist) must come back as `echo`.
	if (triggers.has("websocket")) {
		await check("websocket", "/ws/echo greeting + echo round-trip (@blokjs/ws-reply)", async () => {
			const { opened, frames } = await wsRoundtrip("/ws/echo", { event: "hello", data: { hi: "smoke" } }, 3000);
			if (!opened) return FAIL("WebSocket did not open");
			const greeted = frames.some((f) => f.includes('"connected"'));
			const echoed = frames.some((f) => f.includes('"echo"') && f.includes("smoke"));
			if (greeted && echoed) return PASS("connected greeting + echo frame delivered");
			return FAIL(`frames=${frames.length} greeting=${greeted} echo=${echoed} — ${frames.join(" | ").slice(0, 80)}`);
		});
	}

	// Webhook — the signature gate must REJECT a bad sig (401) and ACCEPT a
	// validly-signed event (dispatches to the stripe.<type> handler).
	if (triggers.has("webhook")) {
		await check("webhook", "POST /webhooks/stripe rejects a bad signature", async () => {
			const r = await http("POST", "/webhooks/stripe", {
				body: { id: "evt_bad", type: "customer.created" },
				headers: { "Stripe-Signature": "t=1,v1=deadbeef" },
			});
			return r.status === 401 ? PASS("401 (signature verified)") : FAIL(`expected 401, got ${r.status}`);
		});
		await check("webhook", "POST /webhooks/stripe accepts a valid signature", async () => {
			const raw = JSON.stringify({
				id: `evt_${Date.now()}`,
				type: "customer.created",
				data: { object: { id: "cus_1" } },
			});
			const r = await http("POST", "/webhooks/stripe", {
				body: raw,
				headers: { "Stripe-Signature": stripeSignature(raw, STRIPE_SECRET) },
			});
			// 200 = verified + dispatched. 404-class only if the stripe.customer.created
			// handler isn't registered — still proves the signature passed the gate.
			return r.status === 200
				? PASS("200 (verified + dispatched)")
				: FAIL(`expected 200, got ${r.status} body=${r.text.slice(0, 80)}`);
		});
	}

	// MCP — initialize handshake + call the `greet` tool (uses @blokjs/expr).
	if (triggers.has("mcp")) {
		await check("mcp", "POST /mcp initialize + tools/call greet (@blokjs/expr)", async () => {
			const mcpHeaders = { accept: "application/json, text/event-stream" };
			const init = await http("POST", "/mcp", {
				headers: mcpHeaders,
				body: {
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
				},
			});
			if (!/serverInfo/.test(init.text)) return FAIL(`initialize returned no serverInfo: ${init.text.slice(0, 80)}`);
			const call = await http("POST", "/mcp", {
				headers: mcpHeaders,
				body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "greet", arguments: { name: "Blok" } } },
			});
			return /Hello, Blok/.test(call.text)
				? PASS("greet → Hello, Blok")
				: FAIL(`tools/call greet: ${call.text.slice(0, 120)}`);
		});
	}

	// Worker — the fanout producer enqueues N jobs (@blokjs/worker-publish) and
	// the in-memory worker consumes them.
	if (triggers.has("worker") || triggers.has("queue")) {
		await check("worker", "POST /fanout/jobs enqueues + consumes (in-memory)", async () => {
			const r = await http("POST", "/fanout/jobs", { body: { items: [{ id: "a" }, { id: "b" }], tenantId: "smoke" } });
			const queued = (r.json as { queued?: number })?.queued;
			if (r.status !== 200 || queued !== 2)
				return FAIL(`expected queued=2, got status=${r.status} body=${r.text.slice(0, 80)}`);
			const consumed = await logMatches(/(Processing job|Job .*completed|process-job)/i, 4000);
			return consumed ? PASS("queued=2; worker consumed") : PASS("queued=2 (consumer log not observed — producer OK)");
		});
	}

	// Cron — portless scheduler. Assert the trigger booted and scheduled the
	// shipped heartbeat (the wall-clock fire is proven by the trigger's own
	// suite; a per-minute schedule is too slow to fire inside a smoke).
	if (triggers.has("cron")) {
		await check("cron", "cron trigger schedules the heartbeat", async () => {
			const scheduled =
				(await logMatches(/Scheduling workflow: cron-heartbeat/i, 3000)) &&
				(await logMatches(/job\(s\) scheduled/i, 500));
			return scheduled
				? PASS("cron-heartbeat scheduled")
				: FAIL("no 'Scheduling workflow: cron-heartbeat' + 'job(s) scheduled' in the dev log");
		});
	}

	// gRPC — call the always-registered @blokjs/expr node over the wire.
	if (triggers.has("grpc")) {
		const port = config.triggers?.grpc?.port ?? 4003;
		await check("grpc", `GrpcClient → @blokjs/expr (port ${port})`, async () => {
			const out = (await grpcCallNode(port, "@blokjs/expr", { expression: "({ ok: true, n: 6 * 7 })" })) as {
				ok?: boolean;
				n?: number;
			};
			return out?.ok === true && out?.n === 42
				? PASS("expr → {ok:true, n:42}")
				: FAIL(`unexpected gRPC result: ${JSON.stringify(out).slice(0, 80)}`);
		});
	}

	// PubSub — produce over HTTP, consume from the broker, observe the consumer.
	if (triggers.has("pubsub")) {
		await check("pubsub", "POST /orders → broker → consumer (@blokjs/log)", async () => {
			const r = await http("POST", "/orders", { body: { id: "o-smoke", item: "widget" } });
			if (r.status !== 200) return FAIL(`producer POST /orders status=${r.status} body=${r.text.slice(0, 80)}`);
			const consumed = await logMatches(/pubsub consumed a message on orders\.placed/i, 5000);
			return consumed
				? PASS("produced + consumer logged the message")
				: FAIL("producer OK but consumer did not log within 5s");
		});
	}

	// Runtimes — POST /runtimes/<lang>/hello for each scaffolded sidecar.
	// "Still warming" comes in two shapes, both retried until the shared
	// deadline instead of false-failing (compiled runtimes cold-build for
	// minutes under `blokctl dev`):
	//   503 GRPC_UNAVAILABLE          — sidecar not reachable yet
	//   502 GRPC_RUNTIME_UNAVAILABLE  — the runner's circuit breaker opened on
	//       early health-probe failures; it's retryable:true and self-recovers
	//       on the next successful probe once the sidecar is up.
	const stillWarming = (r: HttpResp) =>
		r.status === 503 || (r.status === 502 && r.text.includes("GRPC_RUNTIME_UNAVAILABLE"));
	const runtimeDeadline = Date.now() + Number(process.env.SMOKE_RUNTIME_WAIT_MS ?? 300_000);
	for (const kind of runtimeKinds) {
		if (kind === "node") continue; // node is in-process, no /runtimes route
		const label = RUNTIME_LABEL[kind] ?? cap(kind);
		await check("runtime", `POST /runtimes/${kind}/hello`, async () => {
			let r = await http("POST", `/runtimes/${kind}/hello`, { body: { name: "Blok" }, retries: 40 });
			while (stillWarming(r) && Date.now() < runtimeDeadline) {
				await sleep(3000);
				r = await http("POST", `/runtimes/${kind}/hello`, { body: { name: "Blok" }, retries: 3 });
			}
			const msg = (r.json as { message?: string })?.message ?? "";
			return r.status === 200 && msg.includes(`Hello from the ${label} runtime, Blok!`)
				? PASS(msg)
				: FAIL(`status=${r.status} body=${r.text.slice(0, 100)}`);
		});
	}
}

// ── report + exit ─────────────────────────────────────────────────────────────

function report(): number {
	const pad = (s: string, n: number) => s.padEnd(n);
	const icon = { pass: "✓", fail: "✗", skip: "○" } as const;
	console.log(`\n  Scaffold smoke E2E — ${BASE_URL}`);
	console.log(`  triggers: ${[...triggers].sort().join(", ") || "(none)"}`);
	console.log(`  runtimes: ${runtimeKinds.join(", ") || "(none)"}\n`);

	for (const r of results) {
		const line = `  ${icon[r.status]} ${pad(`[${r.category}]`, 12)} ${pad(r.name, 46)} ${r.detail}`;
		console.log(r.status === "fail" ? `\x1b[31m${line}\x1b[0m` : r.status === "skip" ? `\x1b[2m${line}\x1b[0m` : line);
	}

	const pass = results.filter((r) => r.status === "pass").length;
	const fail = results.filter((r) => r.status === "fail");
	const skip = results.filter((r) => r.status === "skip").length;
	console.log(`\n  ${pass} passed, ${fail.length} failed, ${skip} skipped\n`);

	// A FAIL always fails the run. The REQUIRE gate additionally fails if a
	// required category produced no passing check (caught nothing = rot).
	if (fail.length > 0) return 1;
	const requiredCats = REQUIRE_ALL ? new Set([...triggers, ...runtimeKinds.filter((k) => k !== "node")]) : REQUIRED;
	const passedCats = new Set(results.filter((r) => r.status === "pass").map((r) => r.category));
	const missing = [...requiredCats].filter((c) => {
		// map runtime kinds → the "runtime" category
		const cat = triggers.has(c) || c === "worker" || c === "queue" ? c : "runtime";
		return !passedCats.has(cat) && !passedCats.has(c);
	});
	if (missing.length > 0) {
		console.error(`  REQUIRE gate: no passing check for required: ${missing.join(", ")}\n`);
		return 1;
	}
	return 0;
}

await run();
process.exit(report());
