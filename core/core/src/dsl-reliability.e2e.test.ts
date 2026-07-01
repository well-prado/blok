import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
/**
 * Handle-DSL reliability E2E — issue #602.
 *
 * Proves the per-step and per-trigger reliability knobs of the @blokjs/core
 * handle DSL against the REAL engine, at the TWO layers the runner CLAUDE.md
 * documents each knob runs in:
 *
 * STEP-LEVEL (gated in RunnerSteps / PersistenceHelper) — driven through the
 * real Configuration + Runner and asserted on `ctx.state`:
 *   - `ephemeral: true`  → no state slot (value only via ctx.prev)
 *   - `spread: true`     → object shallow-merges into state
 *   - `as: "name"`       → renames the state key
 *   - `idempotencyKey`   → 2nd run w/ same key is a cache HIT; execute() NOT
 *                          re-invoked (proven with a call counter). Requires an
 *                          active RunTracker (BLOK_TRACE_ENABLED).
 *   - `retry`            → a flaky step that throws then succeeds completes
 *   - `maxDuration`      → a step exceeding it FAILS the run (StepTimeoutError)
 *
 * TRIGGER-LEVEL (gated in TriggerBase.run, NOT the runner) — driven through a
 * LIVE HttpTrigger bound to a REAL port with REAL POSTs, asserting the real
 * observable HTTP behavior:
 *   - `concurrencyKey`+`concurrencyLimit` over-limit → 429 + Retry-After
 *   - `onLimit: "queue"` over-limit                  → 202 + Location (queued)
 *   - `delay`                                        → 202 + Location; run
 *                                                      shows `delayed` via
 *                                                      GET /__blok/runs/:id
 *   - `debounce` (trailing)                          → 2nd ping within the
 *                                                      window coalesces into
 *                                                      the first run (debounced
 *                                                      terminal + intoRunId)
 *
 * The trigger-level workflows reference `@blokjs/api-call` pointed at a local
 * slow HTTP server this test owns — a real network call that holds the
 * concurrency slot open long enough for the second request to be denied.
 *
 * Gated on `BLOK_INTEGRATION_DSL_RELIABILITY` (the live HttpTrigger boot binds
 * a real socket + runs real node discovery, so it's opt-in). All resources
 * (workflow names, paths, keys, ports) are namespaced with a per-run random
 * suffix so concurrent targets never collide.
 */
import { type Server as HttpServer, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, defineNode, step, workflow } from "@blokjs/core";
// Heavy engine surface (Runner/Configuration/RunTracker + shared primitives)
// lives on the `/runtime` subpath; the test harness on `/testing`. Both are
// @blokjs/core client subpaths (see the barrel doc-comments).
import { Configuration, type Context, type NodeBase, RunTracker, Runner } from "@blokjs/core/runtime";
import { WorkflowTestRunner } from "@blokjs/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

// The raw HttpTrigger class (the package barrel default-exports `App`, a
// composite; the reliability gates live on HttpTrigger itself). No `exports`
// map on @blokjs/trigger-http, so the dist deep-import is allowed.
// @ts-expect-error — deep import into the built trigger, no type surface exported
import HttpTrigger from "@blokjs/trigger-http/dist/runner/HttpTrigger.js";

const SUFFIX = Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------------------
// STEP-LEVEL — real engine (Configuration + Runner), no HTTP.
// ---------------------------------------------------------------------------

// Loose input schema — reliability nodes ignore their inputs and return fixed
// payloads. Output schemas are declared per-node (spread needs a static
// z.object; the others accept a permissive record).
const echoIn = z.object({}).passthrough();
const echoOut = z.record(z.unknown());

describe("DSL reliability — STEP-LEVEL knobs (real engine, ctx.state)", () => {
	it("ephemeral / spread / as land in state exactly per PersistenceHelper rules", async () => {
		// `spread: true` requires a statically-known z.object output (the DSL
		// lowers per-key handles from it), so each node gets a precise schema.
		const eph = defineNode({
			name: `eph-${SUFFIX}`,
			description: "ephemeral echo",
			input: echoIn,
			output: z.object({ v: z.number(), secret: z.string() }),
			execute: async () => ({ v: 1, secret: "shh" }),
		});
		const spr = defineNode({
			name: `spr-${SUFFIX}`,
			description: "spread echo",
			input: echoIn,
			output: z.object({ alpha: z.number(), beta: z.number() }),
			execute: async () => ({ alpha: 1, beta: 2 }),
		});
		const rn = defineNode({
			name: `rn-${SUFFIX}`,
			description: "renamed echo",
			input: echoIn,
			output: z.object({ v: z.number() }),
			execute: async () => ({ v: 3 }),
		});

		const wf = await workflow(
			`reliability-persist-${SUFFIX}`,
			{ version: "1.0.0", trigger: http.post(`/persist-${SUFFIX}`) },
			() => {
				step("keepless", eph, { v: 1 }, { ephemeral: true });
				step("merged", spr, { v: 2 }, { spread: true });
				step("named", rn, { v: 3 }, { as: "renamed" });
			},
		);

		const runner = new WorkflowTestRunner();
		runner.registerNode(eph.name, eph);
		runner.registerNode(spr.name, spr);
		runner.registerNode(rn.name, rn);
		runner.loadWorkflow(wf);
		const result = await runner.execute({});

		expect(result.success).toBe(true);
		// ephemeral → NO state slot.
		expect(result.state?.keepless).toBeUndefined();
		// spread → object keys shallow-merged into state (NOT nested under id).
		expect(result.state?.alpha).toBe(1);
		expect(result.state?.beta).toBe(2);
		expect(result.state?.merged).toBeUndefined();
		// as → landed at state[as]; NOT at state[id].
		expect(result.state?.renamed).toEqual({ v: 3 });
		expect(result.state?.named).toBeUndefined();
	});

	it("retry: a flaky step that throws then succeeds within maxAttempts completes", async () => {
		let attempts = 0;
		const flaky = defineNode({
			name: `flaky-${SUFFIX}`,
			description: "throws twice then succeeds",
			input: echoIn,
			output: echoOut,
			execute: async () => {
				attempts += 1;
				if (attempts < 3) throw new Error(`transient failure #${attempts}`);
				return { v: 42, tag: "recovered" } as never;
			},
		});

		const wf = await workflow(
			`reliability-retry-${SUFFIX}`,
			{ version: "1.0.0", trigger: http.post(`/retry-${SUFFIX}`) },
			() => {
				// minTimeoutInMs kept tiny so the test doesn't sleep whole seconds.
				step("flaky", flaky, { v: 1 }, { retry: { maxAttempts: 3, minTimeoutInMs: 1, maxTimeoutInMs: 5 } });
			},
		);

		const runner = new WorkflowTestRunner();
		runner.registerNode(flaky.name, flaky);
		runner.loadWorkflow(wf);
		const result = await runner.execute({});

		expect(result.success).toBe(true);
		// It actually retried — 3 invocations, only the last succeeded.
		expect(attempts).toBe(3);
		// The successful attempt's output is what persisted.
		expect(result.state?.flaky).toEqual({ v: 42, tag: "recovered" });
	});

	it("maxDuration: a step exceeding its budget FAILS the run", async () => {
		const slow = defineNode({
			name: `slow-${SUFFIX}`,
			description: "sleeps past its maxDuration",
			input: echoIn,
			output: echoOut,
			execute: async () => {
				await new Promise((r) => setTimeout(r, 300));
				return { v: 1 } as never;
			},
		});

		const wf = await workflow(
			`reliability-maxdur-${SUFFIX}`,
			{ version: "1.0.0", trigger: http.post(`/maxdur-${SUFFIX}`) },
			() => {
				step("slow", slow, { v: 1 }, { maxDuration: "50ms" });
			},
		);

		const runner = new WorkflowTestRunner();
		runner.registerNode(slow.name, slow);
		runner.loadWorkflow(wf);
		const result = await runner.execute({});

		// The step blew its budget → run failed, nothing persisted for it.
		expect(result.success).toBe(false);
		expect(result.state?.slow).toBeUndefined();
	});

	it("idempotencyKey: 2nd run w/ same key is a cache HIT — execute() not re-invoked", async () => {
		// The cache is tracker-backed, so we drive the real Runner with an active
		// RunTracker + _traceRunId (BLOK_TRACE_ENABLED path). The workflow is still
		// @blokjs/core-authored; we boot its lowered IR through the real engine.
		let calls = 0;
		const workflowName = `reliability-idem-${SUFFIX}`;
		const counter = defineNode({
			name: `counter-${SUFFIX}`,
			description: "counts real executions",
			input: echoIn,
			output: echoOut,
			execute: async () => {
				calls += 1;
				return { v: calls, tag: "computed" } as never;
			},
		});

		const wf = await workflow(workflowName, { version: "1.0.0", trigger: http.post(`/idem-${SUFFIX}`) }, () => {
			step("cached", counter, { v: 1 }, { idempotencyKey: "static-idem-key", idempotencyKeyTTL: 60_000 });
		});

		const config = new Configuration();
		const nodeMap = {
			nodes: { getNode: (n: string): unknown => (n === counter.name ? counter : null) },
		};
		await config.init(workflowName, nodeMap as never, (wf as { _config: Record<string, unknown> })._config);

		// Use the ACTIVE RunTracker singleton — do NOT resetInstance(), because
		// the live HttpTrigger (trigger-level block below) shares this singleton
		// and its trace routes close over the store captured at boot; resetting
		// it here would 404 the trigger-level detail-endpoint assertions. Cache
		// namespacing is `(workflowName, stepId, key)` and workflowName carries
		// the per-run SUFFIX, so this run can't collide with any other test.
		const runOnce = async (): Promise<Record<string, unknown>> => {
			const tracker = RunTracker.getInstance();
			const run = tracker.startRun({
				workflowName,
				workflowPath: `/${workflowName}`,
				triggerType: "http",
				triggerSummary: workflowName,
				nodeCount: 1,
			});
			const state: Record<string, unknown> = {};
			const ctx = {
				id: "req",
				workflow_name: workflowName,
				workflow_path: `/${workflowName}`,
				request: { body: {}, headers: {}, params: {}, query: {} },
				response: { data: null, success: true, error: null, contentType: "application/json" },
				error: { message: [] },
				logger: { log: () => {}, logLevel: () => {}, error: () => {}, getLogs: () => [] },
				config: config.nodes,
				vars: state,
				state,
				env: {},
				eventLogger: null,
				_PRIVATE_: null,
				_traceRunId: run.id,
			} as unknown as Context;
			await new Runner(config.steps as NodeBase[]).run(ctx);
			return state;
		};

		const first = await runOnce();
		expect(calls).toBe(1);
		expect(first.cached).toEqual({ v: 1, tag: "computed" });

		const second = await runOnce();
		// Cache HIT — execute() was NOT called a second time.
		expect(calls).toBe(1);
		// The cached data still lands in state via the same persistence rules
		// (bare `.data`, NOT the BlokResponse envelope — the RunnerSteps fix).
		expect(second.cached).toEqual({ v: 1, tag: "computed" });
	});
});

// ---------------------------------------------------------------------------
// TRIGGER-LEVEL — live HttpTrigger on a real port, real POSTs.
// ---------------------------------------------------------------------------

const RUN_LIVE = process.env.BLOK_INTEGRATION_DSL_RELIABILITY;
const dLive = RUN_LIVE ? describe : describe.skip;

const HTTP_PORT = 4700 + Math.floor(Math.random() * 250);
const SLOW_PORT = 4960 + Math.floor(Math.random() * 30);
const BASE = `http://localhost:${HTTP_PORT}`;
const TEST_TIMEOUT_MS = 30_000;

// A workflow that holds its concurrency slot open by hitting a local endpoint
// that stalls ~800ms. Namespaced per-run so concurrent targets never collide.
const CONC_PATH = `/rl-conc-${SUFFIX}`;
const QUEUE_PATH = `/rl-queue-${SUFFIX}`;
const DELAY_PATH = `/rl-delay-${SUFFIX}`;
const DEBOUNCE_PATH = `/rl-deb-${SUFFIX}`;

let trigger: { listen: () => Promise<number>; stop: () => Promise<void> } | null = null;
let slowServer: HttpServer | null = null;
let workflowsRoot: string;

async function postJson(path: string, body: unknown = {}): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeAll(async () => {
	if (!RUN_LIVE) return;

	// Local slow endpoint: stalls ~800ms so an in-flight run holds its slot.
	slowServer = createServer((_req, res) => {
		setTimeout(() => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		}, 800);
	});
	await new Promise<void>((r) => slowServer?.listen(SLOW_PORT, r));
	const slowUrl = `http://localhost:${SLOW_PORT}/`;

	// JSON workflows carrying the trigger-level reliability config.
	workflowsRoot = mkdtempSync(join(tmpdir(), `blok-rl-${SUFFIX}-`));
	const jsonDir = join(workflowsRoot, "json");
	mkdirSync(jsonDir, { recursive: true });

	const slowCall = { id: "call", use: "@blokjs/api-call", inputs: { url: slowUrl, method: "GET" } };
	const fastLoad = { id: "load", use: "eval-load-items", inputs: {} };

	writeFileSync(
		join(jsonDir, "conc.json"),
		JSON.stringify({
			name: `rl-conc-${SUFFIX}`,
			version: "1.0.0",
			trigger: {
				http: { method: "POST", path: CONC_PATH, concurrencyKey: `conc-${SUFFIX}`, concurrencyLimit: 1 },
			},
			steps: [slowCall],
		}),
	);
	writeFileSync(
		join(jsonDir, "queue.json"),
		JSON.stringify({
			name: `rl-queue-${SUFFIX}`,
			version: "1.0.0",
			trigger: {
				http: {
					method: "POST",
					path: QUEUE_PATH,
					concurrencyKey: `queue-${SUFFIX}`,
					concurrencyLimit: 1,
					onLimit: "queue",
				},
			},
			steps: [slowCall],
		}),
	);
	writeFileSync(
		join(jsonDir, "delay.json"),
		JSON.stringify({
			name: `rl-delay-${SUFFIX}`,
			version: "1.0.0",
			trigger: { http: { method: "POST", path: DELAY_PATH, delay: "2s" } },
			steps: [fastLoad],
		}),
	);
	writeFileSync(
		join(jsonDir, "debounce.json"),
		JSON.stringify({
			name: `rl-deb-${SUFFIX}`,
			version: "1.0.0",
			trigger: {
				http: {
					method: "POST",
					path: DEBOUNCE_PATH,
					debounce: { key: `doc-${SUFFIX}`, mode: "trailing", delay: "1s", maxDelay: "5s" },
				},
			},
			steps: [fastLoad],
		}),
	);

	process.env.WORKFLOWS_PATH = workflowsRoot;
	process.env.BLOK_FILE_BASED_ROUTING = "true";
	// Concurrency + scheduling gates are tracker-backed — the store IS the lock/
	// deferred-dispatch backend, so tracing must be ON for these knobs to gate.
	process.env.BLOK_TRACE_ENABLED = "true";
	// Keep vitest safe from the trigger's process-level handlers.
	process.env.BLOK_CRASH_AUTOFLIP_DISABLED = "1";
	process.env.BLOK_GRACEFUL_SHUTDOWN_DISABLED = "1";
	process.env.PORT = String(HTTP_PORT);

	trigger = new HttpTrigger();
	await trigger?.listen();
}, TEST_TIMEOUT_MS);

afterAll(async () => {
	if (trigger) await trigger.stop();
	if (slowServer) await new Promise<void>((r) => slowServer?.close(() => r()));
	if (workflowsRoot) rmSync(workflowsRoot, { recursive: true, force: true });
});

dLive("DSL reliability — TRIGGER-LEVEL knobs (live HTTP trigger, real port)", () => {
	it(
		"concurrencyKey + concurrencyLimit: over-limit → 429 + Retry-After",
		async () => {
			// First request grabs the only slot (limit 1) and stalls on the slow call.
			const first = postJson(CONC_PATH);
			await new Promise((r) => setTimeout(r, 150));
			// Second request, same key, arrives while the slot is held → denied.
			const second = await postJson(CONC_PATH);

			expect(second.status).toBe(429);
			const retryAfter = second.headers.get("retry-after");
			expect(retryAfter).toBeTruthy();
			expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);

			const body = (await second.json()) as {
				error: string;
				concurrencyKey: string;
				concurrencyLimit: number;
				currentInFlight: number;
				retryAfterMs: number;
			};
			expect(body.error).toMatch(/concurrency limit/i);
			expect(body.concurrencyKey).toBe(`conc-${SUFFIX}`);
			expect(body.concurrencyLimit).toBe(1);
			expect(body.currentInFlight).toBe(1);
			expect(body.retryAfterMs).toBeGreaterThan(0);

			await first; // let the slot-holder finish so the port drains cleanly.
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"onLimit: 'queue': over-limit → 202 Accepted + Location (queued, not rejected)",
		async () => {
			const first = postJson(QUEUE_PATH);
			await new Promise((r) => setTimeout(r, 150));
			const second = await postJson(QUEUE_PATH);

			expect(second.status).toBe(202);
			const location = second.headers.get("location");
			expect(location).toMatch(/^\/__blok\/runs\/run_/);

			const body = (await second.json()) as { status: string; runId: string; workflowName: string };
			expect(body.status).toBe("queued");
			expect(body.workflowName).toBe(`rl-queue-${SUFFIX}`);
			expect(location).toBe(`/__blok/runs/${body.runId}`);

			await first;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"delay: deferred → 202 + Location; the run shows `delayed` via /__blok/runs/:id",
		async () => {
			const res = await postJson(DELAY_PATH);

			expect(res.status).toBe(202);
			const location = res.headers.get("location");
			expect(location).toMatch(/^\/__blok\/runs\/run_/);

			const body = (await res.json()) as { status: string; runId: string; scheduledAt: number };
			expect(body.status).toBe("delayed");
			expect(body.scheduledAt).toBeGreaterThan(Date.now());

			// The run is observable in the tracker as `delayed` before its timer fires.
			const detail = await fetch(`${BASE}${location}`);
			expect(detail.status).toBe(200);
			const detailBody = (await detail.json()) as { run: { id: string; status: string; scheduledAt?: number } };
			expect(detailBody.run.id).toBe(body.runId);
			expect(detailBody.run.status).toBe("delayed");
			expect(detailBody.run.scheduledAt).toBe(body.scheduledAt);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"debounce (trailing): a 2nd ping within the window coalesces into the first run",
		async () => {
			// First ping opens the debounce window → deferred (its own run).
			const r1 = await postJson(DEBOUNCE_PATH);
			expect(r1.status).toBe(202);
			const b1 = (await r1.json()) as { status: string; runId: string; pingCount: number };
			expect(b1.status).toBe("debounced");
			expect(b1.pingCount).toBe(1);

			// Second ping within `delay` coalesces — a debounced-terminal loser
			// pointing at the first (active) run, with the absorbed ping counted.
			const r2 = await postJson(DEBOUNCE_PATH);
			expect(r2.status).toBe(202);
			const b2 = (await r2.json()) as { status: string; pingCount: number; intoRunId?: string };
			expect(b2.status).toBe("debounced");
			expect(b2.pingCount).toBe(2);
			expect(b2.intoRunId).toBe(b1.runId);
		},
		TEST_TIMEOUT_MS,
	);
});
