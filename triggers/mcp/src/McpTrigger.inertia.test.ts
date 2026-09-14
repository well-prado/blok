/**
 * The Inertia page-registry MCP tools (#1019).
 *
 * The pages here mirror `packages/cli/tests/fixtures/inertia-app` (and the
 * react example's Dashboard): `Orders/Index` with an array `orders` prop and a
 * deferred `stats` prop. `tests/docs/inertia-mcp.test.ts` runs the same tools
 * against the REAL react example; this file covers the trigger wiring — which
 * needs a registry it controls, and a production gate it can flip.
 */

import { http, defineNode, runtimeNode, workflow } from "@blokjs/core";
import { _resetPageRegistry, defer, definePage, optional } from "@blokjs/inertia";
import { WorkflowRegistry } from "@blokjs/runner";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import McpTrigger from "./McpTrigger.js";
import { _resetInertiaModule, inertiaMcpTools, inertiaToolsEnabled, listInertiaRoutes } from "./inertiaTools.js";

const Order = z.object({ id: z.string(), sku: z.string(), total: z.number() });

const listOrders = defineNode({
	name: "list-orders",
	description: "Orders belonging to one user.",
	input: z.object({ userId: z.string().optional() }),
	output: z.array(Order),
	execute: () => [],
});

const loadFilters = defineNode({
	name: "load-filters",
	description: "Filter options.",
	input: z.object({}),
	output: z.object({ statuses: z.array(z.string()) }),
	execute: () => ({ statuses: [] }),
});

/** Cross-runtime stub: no Zod schema, so it exercises the schemaless path. */
const heavyStats = runtimeNode<{ since?: string }, { revenue: number }>("heavy-stats", "runtime.python3");

async function toolsFor(env?: NodeJS.ProcessEnv) {
	_resetInertiaModule();
	return inertiaMcpTools({ env, routes: () => listInertiaRoutes() });
}

function byName(tools: Awaited<ReturnType<typeof toolsFor>>, name: string) {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return tool;
}

let ordersWorkflow: unknown;

beforeEach(async () => {
	_resetPageRegistry();
	WorkflowRegistry.getInstance().clear();

	const OrdersIndex = definePage("Orders/Index", {
		orders: listOrders,
		filters: optional(loadFilters),
		stats: defer(heavyStats, { group: "dashboard", rescue: true }),
	});

	ordersWorkflow = await workflow("orders.index", { version: "1.0.0", trigger: http.get("/orders") }, (req) => {
		OrdersIndex.render(req, "page", "/orders", {});
	});
});

afterEach(() => {
	_resetPageRegistry();
	WorkflowRegistry.getInstance().clear();
	_resetInertiaModule();
});

describe("inertia.pages.list", () => {
	it("returns every declared page with its prop modes", async () => {
		const result = (await byName(await toolsFor({}), "inertia.pages.list").run({})) as {
			pages: { component: string; props: { key: string; mode: string; group?: string; lazy: boolean }[] }[];
		};

		const page = result.pages.find((candidate) => candidate.component === "Orders/Index");
		expect(page, "Orders/Index is missing from the registry listing").toBeDefined();

		const stats = page?.props.find((prop) => prop.key === "stats");
		expect(stats?.mode).toBe("defer");
		expect(stats?.group).toBe("dashboard");
		expect(stats?.lazy).toBe(true);
		expect(page?.props.find((prop) => prop.key === "orders")?.mode).toBe("regular");
		expect(page?.props.find((prop) => prop.key === "filters")?.mode).toBe("optional");
	});
});

describe("inertia.page.get", () => {
	it("returns a JSON Schema whose orders property is an array", async () => {
		const result = (await byName(await toolsFor({}), "inertia.page.get").run({ component: "Orders/Index" })) as {
			component: string;
			schema: { type: string; properties: Record<string, { type?: string; items?: unknown }>; required: string[] };
		};

		expect(result.component).toBe("Orders/Index");
		expect(result.schema.type).toBe("object");
		expect(result.schema.properties.orders?.type).toBe("array");
		expect(result.schema.properties.orders?.items).toBeDefined();
		// Lazy props are not guaranteed to be on the wire; regular ones are.
		expect(result.schema.required).toContain("orders");
		expect(result.schema.required).not.toContain("stats");
		// A `runtimeNode()` stub carries no Zod schema — the key still exists.
		expect(result.schema.properties.stats).toEqual({});
	});

	it("names the fix when the component is unknown", async () => {
		const tool = byName(await toolsFor({}), "inertia.page.get");
		expect(() => tool.run({ component: "Nope" })).toThrow(/Fix: call inertia\.pages\.list/);
	});
});

describe("inertia.routes.list", () => {
	it("lists the HTTP routes the app serves", async () => {
		WorkflowRegistry.getInstance().register({
			name: "orders.index",
			source: "/test/orders-index.ts",
			workflow: ordersWorkflow as never,
		});
		const result = (await byName(await toolsFor({}), "inertia.routes.list").run({})) as {
			routes: { workflow: string; method: string; path: string }[];
		};
		expect(result.routes).toContainEqual(expect.objectContaining({ method: "GET", path: "/orders" }));
	});
});

describe("the dev-only gate", () => {
	it("is on in development and off in production", () => {
		expect(inertiaToolsEnabled({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(true);
		expect(inertiaToolsEnabled({} as NodeJS.ProcessEnv)).toBe(true);
		expect(inertiaToolsEnabled({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
	});

	it("BLOK_INERTIA_MCP wins in both directions", () => {
		expect(inertiaToolsEnabled({ NODE_ENV: "production", BLOK_INERTIA_MCP: "1" } as NodeJS.ProcessEnv)).toBe(true);
		expect(inertiaToolsEnabled({ NODE_ENV: "development", BLOK_INERTIA_MCP: "off" } as NodeJS.ProcessEnv)).toBe(false);
	});

	it("serves no page tools in production", async () => {
		expect(await toolsFor({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toEqual([]);
	});
});

describe("the trigger exposes them over tools/list", () => {
	async function listTools(env: Record<string, string | undefined>): Promise<string[]> {
		const saved = { NODE_ENV: process.env.NODE_ENV, BLOK_INERTIA_MCP: process.env.BLOK_INERTIA_MCP };
		Object.assign(process.env, env);
		_resetInertiaModule();

		const app = new Hono();
		const registry = WorkflowRegistry.getInstance();
		registry.register({
			name: "echo",
			source: "/test/echo.ts",
			workflow: {
				name: "echo",
				version: "1.0.0",
				input: z.object({ text: z.string() }),
				trigger: { mcp: { path: "/mcp", serverName: "test" } },
				steps: [{ id: "echo", node: "echo-node", type: "module", inputs: {} }],
			},
		});

		const trigger = new McpTrigger(app);
		trigger.setNodeMap({ nodes: {}, workflows: {} } as never);
		await trigger.listen();

		const response = await app.request("/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		const text = await response.text();
		await trigger.stop();
		Object.assign(process.env, saved);
		if (saved.BLOK_INERTIA_MCP === undefined) process.env.BLOK_INERTIA_MCP = undefined;

		return [...text.matchAll(/"name":"([^"]+)"/g)].map((match) => match[1] as string);
	}

	it("lists the page tools in development and hides them in production", async () => {
		expect(await listTools({ NODE_ENV: "development", BLOK_INERTIA_MCP: undefined })).toEqual(
			expect.arrayContaining(["inertia.pages.list", "inertia.page.get", "inertia.routes.list", "echo"]),
		);

		const production = await listTools({ NODE_ENV: "production", BLOK_INERTIA_MCP: undefined });
		expect(production).toContain("echo");
		expect(production).not.toContain("inertia.pages.list");
	});
});
