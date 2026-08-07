/**
 * #692 — the dev-loop contract, proved end to end against a REAL file watcher.
 *
 * `core/runner/src/hmr/` has shipped a complete HMR subsystem for a long time
 * and none of it ran: `blokctl dev` also wrapped the app in `bun --watch`, so
 * every edit killed the process before in-process HMR could apply it, and the
 * reload path got zero real-world exercise. This suite is the regression net —
 * it drives actual file writes through actual `fs.watch` events into an actual
 * booted `HttpTrigger`, in one process, and asserts the PID never changes.
 *
 * Rows asserted here map 1:1 to the table in `docs/d/cli/dev.mdx`:
 *
 *   workflow edit   → hot   (route serves the new response)
 *   node edit       → hot   (next invocation runs the new code)
 *   workflow add    → hot   (route appears, no restart, no registration)
 *   workflow delete → hot   (route 404s)
 *   .env / entrypoint → restart (asserted in packages/cli/tests/dev-watch.test.ts)
 *
 * HMR is enabled with `BLOK_HMR=true` and NOTHING else — no CLI, no
 * `NODE_ENV=development` — which is the acceptance criterion for consumers
 * running a production-shaped entrypoint.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { makeOtelApiMock } = await vi.hoisted(() => import("../helpers/otel-api-mock.js"));
vi.mock("@opentelemetry/api", () => makeOtelApiMock());
vi.mock("../../src/runner/metrics/opentelemetry_metrics", () => ({
	bootstrapMetrics: async () => ({ meter: {}, metricsHandler: () => {} }),
	resetBootstrap: () => {},
	metricsHandler: vi.fn(),
}));
vi.mock("../../src/AppRoutes", () => {
	const { Hono } = require("hono");
	return { default: new Hono() };
});
vi.mock("../../src/Workflows", () => ({ default: {} }));

const mockServer = { close: vi.fn(), on: vi.fn() };
vi.mock("@hono/node-server", () => ({
	serve: vi.fn((_opts: unknown, cb?: () => void) => {
		cb?.();
		return mockServer;
	}),
}));
vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: () => vi.fn() }));
vi.mock("@hono/node-server/utils/response", () => ({ RESPONSE_ALREADY_SENT: new Response(null) }));

import { RoutingDiagnostics, WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger.js";

// The scratch project lives INSIDE the package so the generated node file can
// resolve `@blokjs/runner` through the workspace's node_modules. `__tests__/` is
// excluded from watching by the classifier, so it can't live there.
const projectRoot = join(__dirname, "..", "..", ".hmr-e2e-tmp");
const workflowsRoot = join(projectRoot, "workflows");
const jsonDir = join(workflowsRoot, "json");
const nodesDir = join(projectRoot, "nodes");
const echoNodeFile = join(nodesDir, "hmr-echo", "index.ts");

/** A JSON workflow that answers `GET <path>` with a constant, via @blokjs/expr. */
function constantWorkflow(name: string, path: string, value: string): string {
	return JSON.stringify(
		{
			name,
			version: "1.0.0",
			trigger: { http: { method: "GET", path } },
			steps: [{ id: "answer", use: "@blokjs/expr", inputs: { expression: `({ value: ${JSON.stringify(value)} })` } }],
		},
		null,
		2,
	);
}

/** The hot-reloadable node under test. `suffix` is what an "edit" changes. */
function echoNodeSource(suffix: string): string {
	return `import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
	name: "hmr-echo",
	description: "e2e fixture for hot node reload",
	input: z.object({ text: z.string().optional() }),
	output: z.object({ echoed: z.string() }),
	async execute(_ctx, input) {
		return { echoed: \`\${input.text ?? ""}${suffix}\` };
	},
});
`;
}

/** Poll until `check` returns a truthy value, or throw after `timeoutMs`. */
async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs: number, what: string) {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await check();
			if (value) return value;
			last = value;
		} catch (err) {
			last = err;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${what} (last: ${String(last)})`);
}

let trigger: HttpTrigger;
let app: ReturnType<HttpTrigger["getApp"]>;
const bootPid = process.pid;

beforeAll(async () => {
	rmSync(projectRoot, { recursive: true, force: true });
	mkdirSync(jsonDir, { recursive: true });
	mkdirSync(join(nodesDir, "hmr-echo"), { recursive: true });

	writeFileSync(join(jsonDir, "greet.json"), constantWorkflow("hmr-greet", "/hmr/greet", "before"));
	writeFileSync(join(jsonDir, "slow.json"), constantWorkflow("hmr-slow", "/hmr/slow", "v1"));
	writeFileSync(echoNodeFile, echoNodeSource("-v1"));
	writeFileSync(
		join(jsonDir, "echo.json"),
		JSON.stringify({
			name: "hmr-echo-wf",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/hmr/echo" } },
			steps: [{ id: "echo", use: "hmr-echo", inputs: { text: "hi" } }],
		}),
	);

	// The capability switch under test: BLOK_HMR alone, no NODE_ENV.
	process.env.BLOK_HMR = "true";
	// biome-ignore lint/performance/noDelete: restore literal absence, not the string "undefined"
	delete process.env.NODE_ENV;
	process.env.WORKFLOWS_PATH = workflowsRoot;
	process.env.NODES_PATH = nodesDir;
	process.env.BLOK_FILE_BASED_ROUTING = "true";
	process.env.BLOK_TRACE_ENABLED = "false";
	WorkflowRegistry.resetInstance();
	RoutingDiagnostics.resetInstance();

	trigger = new HttpTrigger();
	// The node corpus is normally discovered from the project's own `src/nodes`
	// at module-eval; this scratch project isn't on that path, so seed it once.
	// The RELOAD path (what this suite exercises) re-discovers it from NODES_PATH.
	const { discoverNodes } = await import("@blokjs/runner");
	trigger.getNodeMap().nodes.addNodes(await discoverNodes(nodesDir), { replace: true });
	await trigger.listen();
	app = trigger.getApp();
}, 30_000);

afterAll(async () => {
	await trigger?.stopHotReload?.();
	rmSync(projectRoot, { recursive: true, force: true });
	// biome-ignore lint/performance/noDelete: restore literal absence, not the string "undefined"
	delete process.env.BLOK_HMR;
	// biome-ignore lint/performance/noDelete: restore literal absence, not the string "undefined"
	delete process.env.WORKFLOWS_PATH;
	// biome-ignore lint/performance/noDelete: restore literal absence, not the string "undefined"
	delete process.env.NODES_PATH;
});

const get = (path: string) => app.fetch(new Request(`http://localhost${path}`));
const value = async (res: Response) => ((await res.json()) as { value?: string }).value;

describe("#692 · blokctl dev loop — HMR is real (BLOK_HMR=true, no CLI, no NODE_ENV)", () => {
	it("(a) editing a workflow file changes the route's response, same PID", async () => {
		expect(await value(await get("/hmr/greet"))).toBe("before");

		writeFileSync(join(jsonDir, "greet.json"), constantWorkflow("hmr-greet", "/hmr/greet", "after"));

		await waitFor(async () => (await value(await get("/hmr/greet"))) === "after", 2000, "workflow edit to go live");
		expect(process.pid).toBe(bootPid);
	}, 15_000);

	it("(b) editing a node's execute changes the next invocation, same PID", async () => {
		const first = (await (await get("/hmr/echo")).json()) as { echoed?: string };
		expect(first.echoed).toBe("hi-v1");

		writeFileSync(echoNodeFile, echoNodeSource("-v2"));

		await waitFor(
			async () => ((await (await get("/hmr/echo")).json()) as { echoed?: string }).echoed === "hi-v2",
			6000,
			"node edit to go live",
		);
		expect(process.pid).toBe(bootPid);
	}, 20_000);

	it("(c) a new workflow file serves 200 with no manual registration or restart", async () => {
		// Not-200 rather than 404: an unknown path with no mounted route falls
		// through to the LEGACY catch-all, whose response for an unresolvable
		// workflow key is a 500. That's pre-existing behaviour outside this
		// issue's scope — what matters here is that the path is not served.
		expect((await get("/hmr/fresh")).status).not.toBe(200);

		writeFileSync(join(jsonDir, "fresh.json"), constantWorkflow("hmr-fresh", "/hmr/fresh", "brand-new"));

		await waitFor(async () => (await get("/hmr/fresh")).status === 200, 2000, "new workflow route to appear");
		expect(await value(await get("/hmr/fresh"))).toBe("brand-new");
		expect(process.pid).toBe(bootPid);
	}, 15_000);

	it("(d) deleting that workflow file returns the route to 404", async () => {
		expect((await get("/hmr/fresh")).status).toBe(200);

		rmSync(join(jsonDir, "fresh.json"));

		await waitFor(async () => (await get("/hmr/fresh")).status === 404, 2000, "deleted workflow route to 404");
		expect(process.pid).toBe(bootPid);
	}, 15_000);

	it("reload under traffic: in-flight runs finish on the old module, new requests get the new one", async () => {
		expect(await value(await get("/hmr/slow"))).toBe("v1");

		// Fire a batch of requests, then reload WHILE they are in flight. The
		// in-flight ones resolved their workflow object before the swap, so they
		// must all complete (no dropped or errored responses) — the swap replaces
		// the table entry, it never mutates a run that already started.
		const inFlight = Array.from({ length: 25 }, () => get("/hmr/slow"));
		writeFileSync(join(jsonDir, "slow.json"), constantWorkflow("hmr-slow", "/hmr/slow", "v2"));

		const settled = await Promise.all(inFlight);
		expect(settled.every((r) => r.status === 200)).toBe(true);
		for (const res of settled) expect(await value(res)).toBe("v1");

		// Requests issued after the reload land on the new module.
		await waitFor(async () => (await value(await get("/hmr/slow"))) === "v2", 3000, "post-reload requests to see v2");
		expect(process.pid).toBe(bootPid);
	}, 20_000);
});

// =========================================================================
// #695 — TypeScript workflows are now scanned into the SAME route table as
// JSON (previously `scannedTs` was computed and discarded — see #695). This
// proves the HMR half of that fix: a `.ts` file dropped into
// `src/workflows/` WHILE the server is running becomes routable with no
// restart, exactly like JSON already does above — the mechanism is
// identical (`scanWorkflows` + cache-busted `import()` +
// `buildFileBasedRoutes`'s `hmrOverlay`); TS just wasn't wired into the
// route table until #695.
//
// This writes into the REAL `triggers/http/src/workflows/` directory. The
// TS scan root has no env override (see the design note on `HttpTrigger.
// buildFileBasedRoutes` — it's a deliberate, documented decision, unlike
// JSON's `WORKFLOWS_PATH`), and that's also why this test belongs here
// rather than in the scratch `projectRoot`: this suite's `beforeAll` already
// boots a trigger that watches it (`TriggerBase.resolveHmrRoots()` adds
// `src/workflows` unconditionally). Cleanup is try/finally-scoped to the
// single test so a failure never leaves the fixture behind.
// =========================================================================

describe("#695 · a hot-added TS workflow (no restart, no Workflows.ts entry)", () => {
	const tsWorkflowsDir = join(__dirname, "..", "..", "src", "workflows");
	const freshTsFile = join(tsWorkflowsDir, "zzz-hmr-e2e-fresh.ts");

	function freshTsWorkflowSource(freshValue: string): string {
		return `import { http, node, step, workflow } from "@blokjs/core";

export default workflow("hmr.tsFresh", { version: "1.0.0", trigger: http.get("/hmr/ts-fresh") }, () => {
	step("answer", node("@blokjs/expr"), { expression: "({ value: '${freshValue}' })" });
});
`;
	}

	it("a new .ts file under src/workflows/ serves 200 with no restart and no manual registration, then 404s again once deleted", async () => {
		expect((await get("/hmr/ts-fresh")).status).not.toBe(200);

		try {
			writeFileSync(freshTsFile, freshTsWorkflowSource("brand-new-ts"));
			await waitFor(async () => (await get("/hmr/ts-fresh")).status === 200, 4000, "new TS workflow route to appear");
			expect(await value(await get("/hmr/ts-fresh"))).toBe("brand-new-ts");
			expect(process.pid).toBe(bootPid);

			rmSync(freshTsFile);
			await waitFor(async () => (await get("/hmr/ts-fresh")).status === 404, 2000, "deleted TS workflow route to 404");
			expect(process.pid).toBe(bootPid);
		} finally {
			rmSync(freshTsFile, { force: true });
		}
	}, 15_000);
});
