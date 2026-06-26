/**
 * MO-METRICS — the `/metrics` route is registered only when metrics are enabled.
 * With `BLOK_METRICS_DISABLED=1` the route is absent (→ 404); by default it's
 * registered. Unlike the other HttpTrigger suites this does NOT mock the metrics
 * module — it drives the real bootstrap gate. Mirrors the tracing-test harness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/Workflows", () => {
	const traced = {
		_blokV2: true,
		_config: {
			name: "traced",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/traced" } },
			steps: [{ id: "out", use: "@blokjs/respond", inputs: { body: { ok: true } } }],
		},
	};
	return { default: { traced } };
});
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

import { WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger";
import { resetBootstrap } from "../../src/runner/metrics/opentelemetry_metrics";

// `delete` truly unsets; `= undefined` stores the string "undefined".
function setDisabled(v: string | undefined): void {
	if (v === undefined) {
		// biome-ignore lint/performance/noDelete: must unset, not set the string "undefined"
		delete process.env.BLOK_METRICS_DISABLED;
	} else {
		process.env.BLOK_METRICS_DISABLED = v;
	}
}

describe("HttpTrigger — metrics opt-out gate (/metrics route)", () => {
	const orig = process.env.BLOK_METRICS_DISABLED;
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		resetBootstrap();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
	});
	afterEach(() => {
		resetBootstrap();
		setDisabled(orig);
	});

	// Each `new HttpTrigger()` gets a fresh Hono app, so inspecting the registered
	// route table is the unambiguous signal — a GET /metrics route exists only
	// when the bootstrap gate allowed it. (A status-code probe is muddied by the
	// catch-all workflow route that also matches /metrics.)
	async function hasMetricsRoute(): Promise<boolean> {
		const trigger = new HttpTrigger();
		await trigger.listen();
		const routes = (trigger.getApp() as unknown as { routes: Array<{ path: string; method: string }> }).routes ?? [];
		return routes.some((r) => r.path === "/metrics" && r.method.toUpperCase() === "GET");
	}

	it("BLOK_METRICS_DISABLED=1 → no /metrics route is registered", async () => {
		process.env.BLOK_METRICS_DISABLED = "1";
		expect(await hasMetricsRoute()).toBe(false);
	});

	it("default → the /metrics route IS registered", async () => {
		setDisabled(undefined);
		expect(await hasMetricsRoute()).toBe(true);
	});
});
