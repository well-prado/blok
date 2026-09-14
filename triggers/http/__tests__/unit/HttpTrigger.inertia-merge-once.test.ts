/**
 * Issue #1009 over a REAL `HttpTrigger` — the wire half of merge props and once
 * props. The header cases matter most here: `X-Inertia-Partial-Data`,
 * `X-Inertia-Reset` and `X-Inertia-Except-Once-Props` arrive as real HTTP
 * headers, through the real route table, runner and page control step, so the
 * comma lists and case-insensitivity are exercised rather than assumed.
 *
 * Same shape as `HttpTrigger.inertia.test.ts` (#994): workflows are booted
 * through the trigger and driven with `app.fetch(new Request(...))`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../src/Nodes", async () => {
	const [{ HELPER_NODES }, inertia, page] = await Promise.all([
		import("@blokjs/helpers"),
		import("@blokjs/inertia"),
		import("../helpers/inertia-merge-once-page.js"),
	]);
	// The page step carries prop node REFERENCES by the time the workflow has
	// been serialized at boot, so the registry has to resolve them.
	return {
		default: {
			...HELPER_NODES,
			"@blokjs/inertia": inertia.default,
			"wire-feed": page.loadFeed,
			"wire-plans": page.loadPlans,
		},
	};
});

vi.mock("../../src/Workflows", async () => {
	const { billingWorkflow } = await import("../helpers/inertia-merge-once-page.js");
	return { default: { billing: await billingWorkflow() } };
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
import HttpTrigger from "../../src/runner/HttpTrigger.js";
import { counts } from "../helpers/inertia-merge-once-page.js";

const INERTIA: Record<string, string> = { "x-inertia": "true" };

interface WirePage {
	props: Record<string, unknown>;
	mergeProps?: string[];
	matchPropsOn?: string[];
	onceProps?: Record<string, { prop: string; expiresAt: number | null }>;
}

async function buildApp() {
	const trigger = new HttpTrigger();
	await trigger.listen();
	return trigger.getApp();
}

function get(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
	return app.fetch(new Request("http://localhost/billing", { headers }));
}

describe("HttpTrigger — merge props and once props (#1009)", () => {
	beforeEach(() => {
		for (const key of Object.keys(counts)) delete counts[key];
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
	});

	it("a full visit ships the values with no merge labels, and announces the once entry", async () => {
		const res = await get(await buildApp(), INERTIA);
		expect(res.status).toBe(200);

		const page = (await res.json()) as WirePage;
		expect(page.props.feed).toEqual({ data: [{ id: 1 }] });
		expect(page.mergeProps).toBeUndefined();
		expect(page.matchPropsOn).toBeUndefined();
		expect(page.onceProps?.plans).toEqual({ prop: "plans", expiresAt: null });
		expect(counts["wire-plans"]).toBe(1);
	});

	it("a partial reload labels the merge path and skips the once prop the client still holds", async () => {
		const res = await get(await buildApp(), {
			...INERTIA,
			// Mixed case on purpose — header lookup is case-insensitive.
			"X-Inertia-Partial-Component": "Billing/Index",
			"X-Inertia-Partial-Data": "feed,plans.tiers",
			"X-Inertia-Except-Once-Props": "plans",
		});

		const page = (await res.json()) as WirePage;
		expect(page.mergeProps).toEqual(["feed.data"]);
		expect(page.matchPropsOn).toEqual(["feed.data.id"]);
		// `plans` was named in `only`, so the explicit request wins over the
		// except-once header and the node DOES run.
		expect(counts["wire-plans"]).toBe(1);
		expect(page.props.plans).toEqual({ tiers: ["free"] });
	});

	it("a partial reload without `only` skips the once prop, entry and all others intact", async () => {
		const res = await get(await buildApp(), {
			...INERTIA,
			"x-inertia-partial-component": "Billing/Index",
			"x-inertia-except-once-props": "plans",
		});

		const page = (await res.json()) as WirePage;
		expect(counts["wire-plans"]).toBeUndefined();
		expect(page.props.plans).toBeUndefined();
		expect(page.onceProps?.plans).toEqual({ prop: "plans", expiresAt: null });
		expect(page.mergeProps).toEqual(["feed.data"]);
	});

	it("`X-Inertia-Reset` returns the prop without its labels", async () => {
		const res = await get(await buildApp(), {
			...INERTIA,
			"x-inertia-partial-component": "Billing/Index",
			"x-inertia-partial-data": "feed",
			"x-inertia-reset": "feed.data",
		});

		const page = (await res.json()) as WirePage;
		expect(page.props.feed).toEqual({ data: [{ id: 1 }] });
		expect(page.mergeProps).toBeUndefined();
		expect(page.matchPropsOn).toBeUndefined();
	});
});
