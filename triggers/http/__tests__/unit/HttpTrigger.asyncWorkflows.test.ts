import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../src/Workflows", () => {
	const asyncOrder = Promise.resolve({
		_blokV2: true,
		_config: {
			name: "async-order",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/async-order" } },
			steps: [{ id: "out", use: "@blokjs/respond", inputs: { status: 202, body: { ok: true } } }],
		},
	});

	return { default: { "async-order": asyncOrder } };
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

import { WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger";

describe("HttpTrigger - async Workflows.ts exports", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		process.env = { ...originalEnv };
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		process.env.BLOK_ROUTING_LEGACY = undefined;
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("awaits Promise-valued manual workflows before explicit route registration", async () => {
		const trigger = new HttpTrigger();
		await trigger.listen();

		const res = await trigger.getApp().fetch(new Request("http://localhost/async-order"));

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ ok: true });
	});
});
