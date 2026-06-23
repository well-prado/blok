/**
 * P1.3 — the typed-client RPC mount: `POST /__blok/rpc/:name` runs a registered
 * workflow by NAME and returns its output as JSON. These tests boot a real
 * HttpTrigger (server bind mocked) and drive the mounted Hono app via
 * `app.fetch(...)`, registering workflows in the live WorkflowRegistry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (_name: string, fn: (span: unknown) => unknown) =>
				fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
		}),
	},
	metrics: {
		getMeter: () => ({
			createCounter: () => ({ add: vi.fn() }),
			createHistogram: () => ({ record: vi.fn() }),
			createGauge: () => ({ record: vi.fn() }),
			createObservableGauge: () => ({ addCallback: vi.fn() }),
		}),
	},
	SpanStatusCode: { OK: 0, ERROR: 1 },
}));

vi.mock("../../src/runner/metrics/opentelemetry_metrics", () => ({ metricsHandler: vi.fn() }));

// The RPC mount runs real workflows, so the node map must carry the built-in
// helper nodes (@blokjs/respond etc.) — mock Nodes with the real HELPER_NODES.
vi.mock("../../src/Nodes", async () => {
	const { HELPER_NODES } = await import("@blokjs/helpers");
	return { default: { ...HELPER_NODES } };
});
vi.mock("../../src/Workflows", () => ({ default: {} }));
vi.mock("../../src/AppRoutes", () => {
	const { Hono } = require("hono");
	return { default: new Hono() };
});

const mockServer = { close: vi.fn(), on: vi.fn() };
vi.mock("@hono/node-server", () => ({
	serve: vi.fn((_opts: unknown, cb?: () => void) => {
		cb?.();
		return mockServer;
	}),
}));
vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: () => vi.fn() }));
vi.mock("@hono/node-server/utils/response", () => ({ RESPONSE_ALREADY_SENT: new Response(null) }));

import { workflow } from "@blokjs/helper";
import { WorkflowRegistry } from "@blokjs/runner";
import { z } from "zod";
import HttpTrigger from "../../src/runner/HttpTrigger";

// Trace off → no trace store deps; the RPC mount is registered regardless.
process.env.BLOK_TRACE_ENABLED = "false";

/** Boot a trigger and return its mounted Hono app. */
async function bootApp(): Promise<{ fetch: (req: Request) => Promise<Response> }> {
	const trigger = new HttpTrigger();
	await trigger.listen();
	return trigger.getApp();
}

describe("HttpTrigger — typed-client RPC mount (POST /__blok/rpc/:name) — P1.3", () => {
	beforeEach(() => {
		WorkflowRegistry.getInstance().clear();
	});

	it("runs a registered workflow by name and returns its output as JSON", async () => {
		const app = await bootApp();
		// Register AFTER listen() so the boot-time scan doesn't clear it.
		WorkflowRegistry.getInstance().register({
			name: "echo.upper",
			source: "test",
			workflow: workflow({
				name: "echo.upper",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/echo-native" } },
				input: z.object({ msg: z.string() }),
				output: z.object({ echoed: z.string() }),
				steps: [
					{
						id: "out",
						use: "@blokjs/respond",
						inputs: { body: { echoed: "js/ctx.req.body.msg" } },
						ephemeral: true,
					},
				],
			}),
		});

		const res = await app.fetch(
			new Request("http://localhost/__blok/rpc/echo.upper", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ msg: "hello" }),
			}),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ echoed: "hello" });
	});

	it("mirrors scalar input fields into query so a GET/query-style workflow resolves them", async () => {
		const app = await bootApp();
		WorkflowRegistry.getInstance().register({
			name: "search.q",
			source: "test",
			workflow: workflow({
				name: "search.q",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/search" } },
				steps: [
					// Reads from query — proves the RPC mount mirrored the input there.
					{ id: "out", use: "@blokjs/respond", inputs: { body: { q: "js/ctx.req.query.q" } }, ephemeral: true },
				],
			}),
		});

		const res = await app.fetch(
			new Request("http://localhost/__blok/rpc/search.q", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ q: "design" }),
			}),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ q: "design" });
	});

	it("returns 404 for an unregistered workflow name", async () => {
		const app = await bootApp();
		const res = await app.fetch(
			new Request("http://localhost/__blok/rpc/does.not.exist", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: string }).error).toMatch(/not registered/i);
	});

	it("refuses to run a middleware-only workflow over RPC (404)", async () => {
		const app = await bootApp();
		// The isMiddleware guard returns 404 BEFORE the workflow is run, so the
		// entry's workflow body is never touched — a minimal marker object is fine.
		WorkflowRegistry.getInstance().register({
			name: "auth.guard",
			source: "test",
			isMiddleware: true,
			workflow: { name: "auth.guard" },
		});
		const res = await app.fetch(
			new Request("http://localhost/__blok/rpc/auth.guard", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(404);
	});
});

describe("HttpTrigger — RPC SSE streaming (POST /__blok/rpc/:name, Accept: text/event-stream) — P3.2", () => {
	beforeEach(() => {
		WorkflowRegistry.getInstance().clear();
	});

	it("streams a workflow's @blokjs/sse-emit events, with the input on ctx.request.body", async () => {
		const app = await bootApp();
		WorkflowRegistry.getInstance().register({
			name: "jobs.watch",
			source: "test",
			workflow: workflow({
				name: "jobs.watch",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/jobs" } },
				events: { progress: z.object({ job: z.string(), pct: z.number() }), done: z.object({ ok: z.boolean() }) },
				steps: [
					{
						id: "p1",
						use: "@blokjs/sse-emit",
						inputs: { event: "progress", data: { job: "js/ctx.req.body.jobId", pct: 50 } },
						ephemeral: true,
					},
					{ id: "p2", use: "@blokjs/sse-emit", inputs: { event: "done", data: { ok: true } }, ephemeral: true },
				],
			}),
		});

		const res = await app.fetch(
			new Request("http://localhost/__blok/rpc/jobs.watch", {
				method: "POST",
				headers: { "content-type": "application/json", accept: "text/event-stream" },
				body: JSON.stringify({ jobId: "j1" }),
			}),
		);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await res.text();
		expect(text).toContain("event: progress");
		expect(text).toContain('"job":"j1"'); // input flowed to ctx.req.body
		expect(text).toContain('"pct":50');
		expect(text).toContain("event: done");
		expect(text).toContain('"ok":true');
	});

	it("falls back to a unary JSON response when Accept is not text/event-stream", async () => {
		const app = await bootApp();
		WorkflowRegistry.getInstance().register({
			name: "echo.plain",
			source: "test",
			workflow: workflow({
				name: "echo.plain",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/echo-plain" } },
				steps: [{ id: "out", use: "@blokjs/respond", inputs: { body: { ok: true } }, ephemeral: true }],
			}),
		});
		const res = await app.fetch(
			new Request("http://localhost/__blok/rpc/echo.plain", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(await res.json()).toEqual({ ok: true });
	});
});

describe("HttpTrigger — node catalog (GET /__blok/nodes) — SPEC-B P1.3", () => {
	it("lists in-process module nodes with their reflected JSON Schema", async () => {
		const app = await bootApp();
		const res = await app.fetch(new Request("http://localhost/__blok/nodes"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			count: number;
			nodes: Array<{ name: string; runtime: string; inputSchema: unknown | null; outputSchema: unknown | null }>;
		};
		expect(body.count).toBeGreaterThan(0);
		// @blokjs/respond is one of the registered HELPER_NODES (a defineNode node).
		const respond = body.nodes.find((n) => n.name === "@blokjs/respond");
		expect(respond).toBeDefined();
		expect(respond?.runtime).toBe("module");
		// defineNode nodes expose a real input schema via getReflectionSchemas().
		expect(respond?.inputSchema).not.toBeNull();
		expect((respond?.inputSchema as { type?: string }).type).toBe("object");
	});
});

describe("HttpTrigger — RPC mount auth gate (production deny-by-default)", () => {
	const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
	const ORIGINAL_RPC_DISABLED = process.env.BLOK_RPC_AUTH_DISABLED;

	beforeEach(() => {
		WorkflowRegistry.getInstance().clear();
	});
	afterEach(() => {
		// Restore; "" is treated as unset by the gate (it only matches "1" /
		// "production"). Avoids `delete process.env.*` (lint) without changing
		// the observable env state for these gates.
		process.env.NODE_ENV = ORIGINAL_NODE_ENV ?? "test";
		process.env.BLOK_RPC_AUTH_DISABLED = ORIGINAL_RPC_DISABLED ?? "";
	});

	async function bootTrigger(authFn?: () => boolean) {
		const trigger = new HttpTrigger();
		// Set BEFORE listen() — the production path operators are told to follow.
		if (authFn) trigger.setTraceAuth(authFn);
		await trigger.listen();
		return trigger.getApp();
	}

	function registerEcho(): void {
		WorkflowRegistry.getInstance().register({
			name: "secure.echo",
			source: "test",
			workflow: workflow({
				name: "secure.echo",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/secure-echo" } },
				steps: [{ id: "out", use: "@blokjs/respond", inputs: { body: { ok: true } }, ephemeral: true }],
			}),
		});
	}

	const rpcReq = () =>
		new Request("http://localhost/__blok/rpc/secure.echo", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});

	it("503s in production when no authorize hook is registered", async () => {
		const app = await bootTrigger();
		registerEcho();
		process.env.NODE_ENV = "production";
		process.env.BLOK_RPC_AUTH_DISABLED = ""; // unset (not "1")
		const res = await app.fetch(rpcReq());
		expect(res.status).toBe(503);
		expect((await res.json()).hint).toMatch(/setTraceAuth|BLOK_RPC_AUTH_DISABLED/);
	});

	it("passes through in production when BLOK_RPC_AUTH_DISABLED=1", async () => {
		const app = await bootTrigger();
		registerEcho();
		process.env.NODE_ENV = "production";
		process.env.BLOK_RPC_AUTH_DISABLED = "1";
		const res = await app.fetch(rpcReq());
		expect(res.status).toBe(200);
	});

	it("401s in production when the authorize hook denies", async () => {
		const app = await bootTrigger(() => false);
		registerEcho();
		process.env.NODE_ENV = "production";
		process.env.BLOK_RPC_AUTH_DISABLED = ""; // unset (not "1")
		const res = await app.fetch(rpcReq());
		expect(res.status).toBe(401);
	});

	it("runs the workflow in production when the authorize hook allows", async () => {
		const app = await bootTrigger(() => true);
		registerEcho();
		process.env.NODE_ENV = "production";
		process.env.BLOK_RPC_AUTH_DISABLED = ""; // unset (not "1")
		const res = await app.fetch(rpcReq());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});
