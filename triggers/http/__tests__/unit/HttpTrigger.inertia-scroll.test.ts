/**
 * Issue #1010 over a REAL `HttpTrigger` — the wire half of infinite scroll.
 * The header cases matter most here: `X-Inertia-Infinite-Scroll-Merge-Intent`
 * and `X-Inertia-Reset` arrive as real HTTP headers, and the page cursor
 * arrives as a real QUERY STRING, through the real route table, runner and
 * page control step.
 *
 * Same shape as `HttpTrigger.inertia-merge-once.test.ts` (#1009): the workflow
 * is booted through the trigger and driven with `app.fetch(new Request(...))`.
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
		import("../helpers/inertia-scroll-page.js"),
	]);
	return {
		default: { ...HELPER_NODES, "@blokjs/inertia": inertia.default, "wire-posts": page.listPosts },
	};
});

vi.mock("../../src/Workflows", async () => {
	const { postsWorkflow } = await import("../helpers/inertia-scroll-page.js");
	return { default: { posts: await postsWorkflow() } };
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

const INERTIA: Record<string, string> = { "x-inertia": "true" };
const PARTIAL: Record<string, string> = { ...INERTIA, "x-inertia-partial-component": "Wire/Posts" };

interface ScrollProp {
	pageName: string;
	previousPage: number | string | null;
	nextPage: number | string | null;
	currentPage: number | string | null;
	reset: boolean;
}

interface WirePage {
	props: Record<string, unknown>;
	mergeProps?: string[];
	prependProps?: string[];
	scrollProps?: Record<string, ScrollProp>;
}

async function buildApp() {
	const trigger = new HttpTrigger();
	await trigger.listen();
	return trigger.getApp();
}

async function get(query: string, headers: Record<string, string>): Promise<WirePage> {
	const app = await buildApp();
	const res = await app.fetch(new Request(`http://localhost/posts${query}`, { headers }));
	expect(res.status).toBe(200);
	return (await res.json()) as WirePage;
}

describe("HttpTrigger — infinite scroll (#1010)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
	});

	it("1 — a full visit ships page 1 with its cursors and no merge label", async () => {
		const page = await get("", INERTIA);

		expect((page.props.posts as { data: unknown[] }).data).toHaveLength(10);
		expect(page.scrollProps?.posts).toEqual({
			pageName: "page",
			previousPage: null,
			nextPage: 2,
			currentPage: 1,
			reset: false,
		});
		expect(page.mergeProps).toBeUndefined();
	});

	it("2 — `?page=2` with an append intent labels the wrapper path and re-emits fresh cursors", async () => {
		const page = await get("?page=2", {
			...PARTIAL,
			"X-Inertia-Partial-Data": "posts",
			// Mixed case on purpose — header lookup is case-insensitive.
			"X-Inertia-Infinite-Scroll-Merge-Intent": "append",
		});

		expect(page.mergeProps).toEqual(["posts.data"]);
		expect(page.prependProps).toBeUndefined();
		expect((page.props.posts as { data: { id: number }[] }).data[0]).toEqual({ id: 11 });
		expect(page.scrollProps?.posts).toMatchObject({ previousPage: 1, nextPage: null, currentPage: 2 });
	});

	it("3 — a prepend intent moves the label to prependProps", async () => {
		const page = await get("?page=1", {
			...PARTIAL,
			"x-inertia-partial-data": "posts",
			"x-inertia-infinite-scroll-merge-intent": "prepend",
		});

		expect(page.prependProps).toEqual(["posts.data"]);
		expect(page.mergeProps).toBeUndefined();
	});

	it("4 — `X-Inertia-Reset` flags the prop and drops the label", async () => {
		const page = await get("?page=2", {
			...PARTIAL,
			"x-inertia-partial-data": "posts",
			"x-inertia-infinite-scroll-merge-intent": "append",
			"x-inertia-reset": "posts",
		});

		expect(page.scrollProps?.posts).toMatchObject({ reset: true, currentPage: 2 });
		expect(page.mergeProps).toBeUndefined();
		expect(page.prependProps).toBeUndefined();
		// The prop is still RESOLVED — the client asked for a fresh copy.
		expect((page.props.posts as { data: unknown[] }).data).toHaveLength(10);
	});
});
