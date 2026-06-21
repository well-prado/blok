import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock external dependencies before imports (mirrors HttpTrigger.test.ts).
vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (_name: string, fn: (span: any) => any) =>
				fn({
					setAttribute: vi.fn(),
					setStatus: vi.fn(),
					recordException: vi.fn(),
					end: vi.fn(),
				}),
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
// NOTE: `../../src/Nodes` is intentionally NOT mocked here — F15's header check
// runs AFTER `Configuration.init` resolves the workflow's nodes, so the real
// `@blokjs/respond` node must be available for the request to reach the gate.
vi.mock("../../src/AppRoutes", () => {
	const { Hono } = require("hono");
	return { default: new Hono() };
});

// F15 — a workflow declaring `trigger.http.headers` (required headers) and a
// value-match constraint. Built as a plain object literal matching the v2
// builder shape so the route table picks it up at `/secure`.
vi.mock("../../src/Workflows", () => {
	const secure = {
		_blokV2: true,
		_config: {
			name: "secure",
			version: "1.0.0",
			trigger: {
				http: {
					method: "POST",
					path: "/secure",
					headers: { "x-api-key": "", "x-api-version": "2024-01" },
				},
			},
			steps: [{ id: "out", use: "@blokjs/respond", inputs: {} }],
		},
	};
	return { default: { secure } };
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

import { WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger";

describe("HttpTrigger — required-header validation (F15)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
	});

	async function buildApp() {
		const trigger = new HttpTrigger();
		await trigger.listen();
		return trigger.getApp();
	}

	it("rejects a request missing a required header with 400 + structured body", async () => {
		const app = await buildApp();
		const res = await app.fetch(
			new Request("http://localhost/secure", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-version": "2024-01" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error?: string; header?: string };
		expect(json.error).toBe("required_header");
		expect(json.header).toBe("x-api-key");
	});

	it("rejects a request whose required header value does not match the declared value", async () => {
		const app = await buildApp();
		const res = await app.fetch(
			new Request("http://localhost/secure", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": "abc", "x-api-version": "wrong" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error?: string; header?: string; expected?: string };
		expect(json.error).toBe("required_header");
		expect(json.header).toBe("x-api-version");
		expect(json.expected).toBe("2024-01");
	});

	it("passes header validation when all required headers are present and matching", async () => {
		const app = await buildApp();
		const res = await app.fetch(
			new Request("http://localhost/secure", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": "abc", "x-api-version": "2024-01" },
				body: "{}",
			}),
		);
		// The header gate passed — execution then fails on node resolution in
		// this mock env, so the status is NOT the 400 the header gate emits.
		// (Any non-400 proves the required-header check did not short-circuit.)
		expect(res.status).not.toBe(400);
	});
});
