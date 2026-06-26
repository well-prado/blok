import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock external dependencies before imports (mirrors HttpTrigger.test.ts).
// Shared complete OTel double (OBS-02 B2 propagation surface).
const { makeOtelApiMock } = await vi.hoisted(() => import("../helpers/otel-api-mock"));
vi.mock("@opentelemetry/api", () => makeOtelApiMock());

vi.mock("../../src/runner/metrics/opentelemetry_metrics", () => ({
	bootstrapMetrics: async () => ({ meter: {}, metricsHandler: () => {} }),
	resetBootstrap: () => {},
	metricsHandler: vi.fn(),
}));
vi.mock("../../src/Nodes", () => ({ default: {} }));
vi.mock("../../src/AppRoutes", () => {
	const { Hono } = require("hono");
	return { default: new Hono() };
});

// F7 — two workflows sharing the same `name` but DIFFERENT routes/sources.
// Both get live HTTP routes (distinct paths), but only ONE can own the
// name-keyed registry slot used by sub-workflow lookup + RPC.
vi.mock("../../src/Workflows", () => {
	const dupA = {
		_blokV2: true,
		_config: {
			name: "dup",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/dup-a" } },
			steps: [{ id: "a", use: "@blokjs/respond", inputs: {} }],
		},
	};
	const dupB = {
		_blokV2: true,
		_config: {
			name: "dup",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/dup-b" } },
			steps: [{ id: "b", use: "@blokjs/respond", inputs: {} }],
		},
	};
	return { default: { dupA, dupB } };
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

import { RoutingDiagnostics, WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger";

describe("HttpTrigger — workflow name collision detection (F7)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		RoutingDiagnostics.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
	});

	it("records a routing diagnostic when two sources claim the same workflow name", async () => {
		const trigger = new HttpTrigger();
		await trigger.listen();

		const diagnostics = RoutingDiagnostics.getInstance().list();
		const nameCollision = diagnostics.find((d) => d.message.includes("workflow name collision"));
		expect(nameCollision).toBeDefined();
		expect(nameCollision?.message).toContain("dup");
		// First-registered source wins; second is reported as the dropped one.
		expect(nameCollision?.winnerSource).not.toBe(nameCollision?.droppedSource);
	});

	it("registers exactly one workflow object for the colliding name (deterministic winner)", async () => {
		const trigger = new HttpTrigger();
		await trigger.listen();

		const entry = WorkflowRegistry.getInstance().get("dup");
		expect(entry).toBeDefined();
		// Only one entry under the name — the silent pre-dedupe no longer hides
		// the collision, but a single deterministic winner still owns the slot.
		expect(entry?.name).toBe("dup");
	});
});
