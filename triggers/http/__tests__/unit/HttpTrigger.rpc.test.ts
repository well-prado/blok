/**
 * P1.3 — the typed-client RPC mount: `POST /__blok/rpc/:name` runs a registered
 * workflow by NAME and returns its output as JSON. These tests boot a real
 * HttpTrigger (server bind mocked) and drive the mounted Hono app via
 * `app.fetch(...)`, registering workflows in the live WorkflowRegistry.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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
