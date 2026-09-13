/**
 * The Inertia `page` control step (#1008) over a REAL `HttpTrigger`.
 *
 * Issue #1008's test 14: reproduce the executor cases (1–8) end to end with
 * real protocol headers, so the assertions cover route table → runner →
 * `PageNode` → `@blokjs/inertia` → `emitWorkflowResponse` → HTTP.
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

/** Shared with the `Nodes` mock below — how many times each prop node ran. */
const counts = vi.hoisted(() => ({ value: {} as Record<string, number> }));

// Keep the REAL node registry (that is where `@blokjs/inertia` comes from) and
// add the counter props this suite needs.
vi.mock("../../src/Nodes", async (importOriginal) => {
	const actual = (await importOriginal()) as { default: Record<string, unknown> };
	const { defineNode } = await import("@blokjs/core");
	const { z } = await import("zod");

	const bump = (name: string) => {
		counts.value[name] = (counts.value[name] ?? 0) + 1;
	};
	const auth = defineNode({
		name: "pg-auth",
		description: "always prop",
		input: z.object({}),
		output: z.object({ id: z.string() }),
		async execute() {
			bump("pg-auth");
			return { id: "u-1" };
		},
	});
	const orders = defineNode({
		name: "pg-orders",
		description: "regular prop",
		input: z.object({}),
		output: z.object({ items: z.array(z.string()) }),
		async execute() {
			bump("pg-orders");
			return { items: ["o-1"] };
		},
	});
	const filters = defineNode({
		name: "pg-filters",
		description: "optional prop",
		input: z.object({}),
		output: z.object({ open: z.boolean() }),
		async execute() {
			bump("pg-filters");
			return { open: true };
		},
	});
	const stats = defineNode({
		name: "pg-stats",
		description: "deferred prop that always throws",
		input: z.object({}),
		output: z.object({ total: z.number() }),
		async execute() {
			bump("pg-stats");
			throw new Error("stats exploded");
		},
	});
	const posts = defineNode({
		name: "pg-posts",
		description: "nested prop for dot-path narrowing",
		input: z.object({}),
		output: z.object({ data: z.array(z.string()), meta: z.object({ page: z.number() }) }),
		async execute() {
			bump("pg-posts");
			return { data: ["p-1"], meta: { page: 1 } };
		},
	});

	// #1013's marking node is deliberately NOT in HELPER_NODES, so the
	// `inertia.encryptHistory` middleware below needs it registered here.
	const { historyNode } = await import("@blokjs/inertia");

	return {
		default: {
			...actual.default,
			"pg-auth": auth,
			"pg-orders": orders,
			"pg-filters": filters,
			"pg-stats": stats,
			"pg-posts": posts,
			[historyNode.name]: historyNode,
		},
	};
});

vi.mock("../../src/Workflows", () => {
	const page = (name: string, path: string, props: Record<string, unknown>) => ({
		_blokV2: true,
		_config: {
			name,
			version: "1.0.0",
			trigger: { http: { method: "GET", path } },
			steps: [{ id: "page", page: { component: "Orders/Index", url: path, props, inputs: { version: "v1" } } }],
		},
	});
	const props = (rescue: boolean) => ({
		auth: { use: "pg-auth", mode: "always" },
		orders: { use: "pg-orders" },
		filters: { use: "pg-filters", mode: "optional" },
		stats: { use: "pg-stats", mode: "defer", group: "dashboard", ...(rescue ? { rescue: true } : {}) },
		other: { use: "pg-orders", mode: "defer", group: "sidebar" },
		posts: { use: "pg-posts" },
	});
	// #1013 — a route guarded by the real `inertia.encryptHistory` middleware.
	const encrypted = page("page-encrypted", "/orders-encrypted", props(false));
	(encrypted._config.trigger as { http: Record<string, unknown> }).http.middleware = ["inertia.encryptHistory"];

	return {
		default: {
			"page-orders": page("page-orders", "/orders", props(false)),
			"page-rescue": page("page-rescue", "/orders-rescue", props(true)),
			"page-encrypted": encrypted,
			"inertia.encryptHistory": {
				_blokV2: true,
				_config: {
					name: "inertia.encryptHistory",
					version: "1.0.0",
					middleware: true,
					trigger: {},
					steps: [
						{ id: "encrypt-history", use: "@blokjs/inertia.history", inputs: { encrypt: true }, ephemeral: true },
					],
				},
			},
		},
	};
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
const PARTIAL: Record<string, string> = { ...INERTIA, "x-inertia-partial-component": "Orders/Index" };

interface PageObject {
	component: string;
	props: Record<string, unknown>;
	url: string;
	version: string;
	deferredProps?: Record<string, string[]>;
	rescuedProps?: string[];
	encryptHistory?: true;
}

async function buildApp() {
	const trigger = new HttpTrigger();
	await trigger.listen();
	return trigger.getApp();
}

function get(app: Awaited<ReturnType<typeof buildApp>>, path: string, headers: Record<string, string>) {
	return app.fetch(new Request(`http://localhost${path}`, { headers }));
}

function calls(name: string): number {
	return counts.value[name] ?? 0;
}

describe("HttpTrigger — the `page` control step (#1008, test 14)", () => {
	beforeEach(() => {
		counts.value = {};
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
	});

	it("1 — a full Inertia visit resolves regular + always, skips optional/deferred, announces the groups", async () => {
		const res = await get(await buildApp(), "/orders", INERTIA);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-inertia")).toBe("true");

		const page = (await res.json()) as PageObject;
		expect(page.component).toBe("Orders/Index");
		expect(page.props.auth).toEqual({ id: "u-1" });
		expect(page.props.orders).toEqual({ items: ["o-1"] });
		expect(page.props.filters).toBeUndefined();
		expect(page.props.stats).toBeUndefined();
		expect(page.deferredProps).toEqual({ dashboard: ["stats"], sidebar: ["other"] });
		expect(calls("pg-filters")).toBe(0);
		expect(calls("pg-stats")).toBe(0);
	});

	it("1b — a plain browser GET gets the HTML shell with the same resolved props", async () => {
		const res = await get(await buildApp(), "/orders", {});
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		const raw = html.match(/<script type="application\/json" data-page="app">([\s\S]*?)<\/script>/)?.[1];
		const page = JSON.parse(raw as string) as PageObject;
		expect(page.props.orders).toEqual({ items: ["o-1"] });
		expect(page.props.stats).toBeUndefined();
	});

	it("2 — `X-Inertia-Partial-Data: orders` resolves that prop and the always-prop only", async () => {
		const res = await get(await buildApp(), "/orders", { ...PARTIAL, "x-inertia-partial-data": "orders" });
		const page = (await res.json()) as PageObject;
		expect(Object.keys(page.props).sort()).toEqual(["auth", "errors", "orders"]);
		expect(calls("pg-posts")).toBe(0);
	});

	it("3 — an optional prop resolves when it is named", async () => {
		const res = await get(await buildApp(), "/orders", { ...PARTIAL, "x-inertia-partial-data": "filters" });
		const page = (await res.json()) as PageObject;
		expect(page.props.filters).toEqual({ open: true });
		expect(calls("pg-filters")).toBe(1);
	});

	it("4 — `X-Inertia-Partial-Except: orders` drops that prop and keeps the always-prop", async () => {
		const res = await get(await buildApp(), "/orders", { ...PARTIAL, "x-inertia-partial-except": "orders" });
		const page = (await res.json()) as PageObject;
		expect(page.props.orders).toBeUndefined();
		expect(page.props.auth).toEqual({ id: "u-1" });
		expect(calls("pg-orders")).toBe(0);
	});

	it("5 — a partial naming a DIFFERENT component is treated as a full visit", async () => {
		const res = await get(await buildApp(), "/orders", {
			...INERTIA,
			"x-inertia-partial-component": "Other/Page",
			"x-inertia-partial-data": "filters",
		});
		const page = (await res.json()) as PageObject;
		expect(calls("pg-filters")).toBe(0);
		expect(page.props.orders).toEqual({ items: ["o-1"] });
		expect(page.deferredProps).toEqual({ dashboard: ["stats"], sidebar: ["other"] });
	});

	it("6 — a deferred group request resolves that group and leaves the other alone", async () => {
		const res = await get(await buildApp(), "/orders-rescue", { ...PARTIAL, "x-inertia-partial-data": "stats" });
		expect(res.status).toBe(200);
		expect(calls("pg-stats")).toBe(1);
		// `other` lives in the sidebar group and was never asked for.
		expect(calls("pg-orders")).toBe(0);
	});

	it("7 — `rescue: true` answers 200 with rescuedProps; without it the request fails", async () => {
		const rescued = await get(await buildApp(), "/orders-rescue", {
			...PARTIAL,
			"x-inertia-partial-data": "stats",
		});
		expect(rescued.status).toBe(200);
		const page = (await rescued.json()) as PageObject;
		expect(page.props.stats).toBeUndefined();
		expect(page.rescuedProps).toEqual(["stats"]);

		const strict = await get(await buildApp(), "/orders", { ...PARTIAL, "x-inertia-partial-data": "stats" });
		expect(strict.status).toBeGreaterThanOrEqual(400);
	});

	it("#1013 — the `inertia.encryptHistory` middleware reaches a page rendered by the control step", async () => {
		const res = await get(await buildApp(), "/orders-encrypted", INERTIA);
		expect(res.status).toBe(200);
		const page = (await res.json()) as PageObject;
		// The middleware marks the live ctx; the control step's serializer resolves
		// the flag off that same request, so a control-step page is encrypted too.
		expect(page.encryptHistory).toBe(true);
		expect(page.props.orders).toEqual({ items: ["o-1"] });

		// An unguarded route on the same app is untouched.
		const plain = (await (await get(await buildApp(), "/orders", INERTIA)).json()) as PageObject;
		expect(plain.encryptHistory).toBeUndefined();
	});

	it("8 — a dot path narrows the nested prop; an unknown path is ignored", async () => {
		const res = await get(await buildApp(), "/orders", {
			...PARTIAL,
			"x-inertia-partial-data": "posts.data,nope.nothing",
		});
		expect(res.status).toBe(200);
		const page = (await res.json()) as PageObject;
		expect(page.props.posts).toEqual({ data: ["p-1"] });
		expect(page.props.nope).toBeUndefined();
		expect(calls("pg-posts")).toBe(1);
	});
});
