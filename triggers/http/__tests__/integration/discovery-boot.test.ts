/**
 * #361 — End-to-end guard that the hand-maintained local-node listing in
 * `Nodes.ts` is truly gone. The local nodes are now AUTO-DISCOVERED
 * (`discoverNodes` → `eval/` + `examples/` map-export barrels + single-node
 * dirs); `Nodes.ts` only lists the three THIRD-PARTY npm packages
 * (`@blokjs/api-call`, `@blokjs/if-else`, `HELPER_NODES`).
 *
 * Crucially this test does NOT `vi.mock("../../src/Nodes", ...)` — it boots the
 * REAL discovery so a regression that breaks auto-import (empty corpus, bad
 * dir, barrel not flattened) fails HERE. It proves:
 *   (1) a TS workflow step using `use: "@blokjs/api-call"` (third-party module)
 *       resolves;
 *   (2) a TS workflow step using a DISCOVERED local node (`eval-load-items`)
 *       resolves AND EXECUTES — output reaches the HTTP response, proving
 *       discovery wired execution, not just registration;
 *   (3) a `type: "runtime.go"` step resolves (no sidecar — resolution only);
 *   (4) a JSON workflow referencing a discovered node by its catalog `ref`
 *       resolves + executes;
 *   (5) `GET /__blok/nodes` lists the discovered corpus and every entry's `ref`
 *       resolves through the same registry.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Shared OTel double + metrics/server stubs (mirrors HttpTrigger.test.ts) so the
// test never binds a real port or installs a real exporter. NOTE: `../../src/Nodes`
// is deliberately NOT mocked — discovery must run for real.
const { makeOtelApiMock } = await vi.hoisted(() => import("../helpers/otel-api-mock"));
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

// A TS workflow whose LAST step is a DISCOVERED local node that actually
// executes (eval-load-items, no network) — its output is the HTTP body, proving
// discovery wired execution. An earlier `@blokjs/api-call` step (third-party
// module) is present but inactive so it resolves without making a real request.
vi.mock("../../src/Workflows", () => {
	const apiCallThenLocal = {
		_blokV2: true,
		_config: {
			name: "discovery-mixed",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/discovery-mixed" } },
			steps: [
				{
					id: "fetch",
					use: "@blokjs/api-call",
					inputs: { url: "https://example.invalid/never-called" },
					active: false,
				},
				{ id: "load", use: "eval-load-items", inputs: {} },
			],
		},
	};
	return { default: { apiCallThenLocal } };
});

const mockServer = { close: vi.fn(), on: vi.fn() };
vi.mock("@hono/node-server", () => ({
	serve: vi.fn((_opts: any, cb: any) => {
		if (cb) cb();
		return mockServer;
	}),
}));
vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: () => vi.fn() }));
vi.mock("@hono/node-server/utils/response", () => ({ RESPONSE_ALREADY_SENT: new Response(null) }));

import { Configuration, RoutingDiagnostics, WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger, { type AppBindings } from "../../src/runner/HttpTrigger";

// Minimal structural step shape — `RunnerNode` isn't re-exported from the
// package barrel, but the resolver only reads `node`/`name`/`type`.
type ResolvableStep = { node: string; name: string; type: string };

// Expose the protected resolver to prove a `runtime.*` ref resolves (acceptance
// #3 — resolution only; no sidecar is up so it would not *execute*).
class TestConfiguration extends Configuration {
	resolve(node: ResolvableStep): Promise<unknown> {
		return (this as unknown as { nodeResolver(n: ResolvableStep): Promise<unknown> }).nodeResolver(node);
	}
}

let workflowsRoot: string;

beforeAll(() => {
	// A JSON workflow referencing a DISCOVERED node by its catalog ref. Lives
	// under WORKFLOWS_PATH/json so file-based routing scans + registers it.
	workflowsRoot = mkdtempSync(join(tmpdir(), "blok-discovery-"));
	const jsonDir = join(workflowsRoot, "json");
	mkdirSync(jsonDir, { recursive: true });
	writeFileSync(
		join(jsonDir, "eval.json"),
		JSON.stringify({
			name: "discovery-json",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/discovery-json" } },
			steps: [{ id: "load", use: "eval-load-items", inputs: {} }],
		}),
	);

	process.env.WORKFLOWS_PATH = workflowsRoot;
	process.env.BLOK_FILE_BASED_ROUTING = "true";
	process.env.BLOK_TRACE_ENABLED = "false";
	WorkflowRegistry.resetInstance();
	RoutingDiagnostics.resetInstance();
});

afterAll(() => {
	if (workflowsRoot) rmSync(workflowsRoot, { recursive: true, force: true });
});

describe("HttpTrigger boots with NO hand-listed local nodes (#360/#361)", () => {
	it("boots, auto-discovers local nodes, and resolves+executes module/runtime/JSON refs", async () => {
		const trigger = new HttpTrigger();
		await trigger.listen();
		const app = trigger.getApp();

		// The registry was populated by real discovery — no hand-listing.
		const moduleNodes = (trigger.getNodeMap().nodes as { getNodes?: () => Map<string, unknown> }).getNodes?.();
		expect(moduleNodes).toBeDefined();
		// Third-party (api-call) + discovered local (eval-load-items) both present.
		expect(moduleNodes?.has("@blokjs/api-call")).toBe(true);
		expect(moduleNodes?.has("eval-load-items")).toBe(true);
		expect(moduleNodes?.has("base64-pdf")).toBe(true); // examples barrel flattened

		// (1)+(2): TS workflow — `@blokjs/api-call` (third-party module) resolves
		// at load, the discovered eval node executes, and its output is the body.
		const tsRes = await app.fetch(new Request("http://localhost/discovery-mixed"));
		expect(tsRes.status).toBe(200);
		const tsBody = (await tsRes.json()) as { items?: unknown[] };
		expect(Array.isArray(tsBody.items)).toBe(true);
		expect(tsBody.items?.length).toBe(3);

		// (3): a `runtime.go` ref resolves through the SAME resolver the boot uses
		// (routes to the runtime adapter, NOT a module-not-found) — no sidecar is
		// up, so this proves resolution, not execution.
		const config = new TestConfiguration();
		(config as unknown as { globalOptions: unknown }).globalOptions = trigger.getNodeMap();
		const runtimeNode = await config.resolve({ node: "noop", name: "noop", type: "runtime.go" });
		expect(runtimeNode).toBeDefined();
		expect((runtimeNode as { type?: string }).type).toBe("runtime.go");

		// (4): JSON workflow referencing a discovered node by ref resolves+runs.
		const jsonRes = await app.fetch(new Request("http://localhost/discovery-json"));
		expect(jsonRes.status).toBe(200);
		const jsonBody = (await jsonRes.json()) as { items?: unknown[] };
		expect(jsonBody.items?.length).toBe(3);

		// (5): /__blok/nodes lists the discovered corpus; every module ref is a
		// key in the live registry (i.e. resolvable through the same map).
		const catalogRes = await app.fetch(new Request("http://localhost/__blok/nodes"));
		expect(catalogRes.status).toBe(200);
		const catalog = (await catalogRes.json()) as { nodes: Array<{ name: string; ref: string }>; count: number };
		expect(catalog.count).toBeGreaterThanOrEqual(50);
		const moduleRefs = catalog.nodes.filter((n) => !n.ref.startsWith("runtime."));
		expect(moduleRefs.length).toBeGreaterThan(0);
		for (const entry of moduleRefs) {
			// `ref` for a module node is its name — must be a live registry key.
			expect(moduleNodes?.has(entry.ref)).toBe(true);
		}
	});

	it("uses the shared app when one is provided (boot path stays the same)", async () => {
		const { Hono } = await import("hono");
		const shared = new Hono<AppBindings>();
		const trigger = new HttpTrigger(shared);
		await trigger.listen();
		expect(trigger.getApp()).toBe(shared);
		const res = await shared.fetch(new Request("http://localhost/discovery-json"));
		expect(res.status).toBe(200);
	});
});
