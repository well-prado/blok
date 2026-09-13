/**
 * `definePage()` runtime behaviour (#995): the registry codegen reads, the
 * duplicate-component guard, `shared()`, and the shape of the `page` step
 * `render()` emits.
 *
 * The TYPE half of #995 lives in `test/types/*.ts`, compiled by `tsc --noEmit`.
 */

import { http, defineNode, runtimeNode, workflow } from "@blokjs/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { always, defer, definePage, getPageRegistry, merge, optional, shared } from "../src/define-page.js";

const currentUser = defineNode({
	name: "dp-current-user",
	description: "shared auth prop",
	input: z.object({}),
	output: z.object({ id: z.string(), email: z.string() }),
	async execute() {
		return { id: "u-1", email: "a@b.c" };
	},
});

const listOrders = defineNode({
	name: "dp-list-orders",
	description: "regular prop",
	input: z.object({ userId: z.string() }),
	output: z.object({ items: z.array(z.string()) }),
	async execute() {
		return { items: [] };
	},
});

const loadFilters = defineNode({
	name: "dp-load-filters",
	description: "optional prop",
	input: z.object({}),
	output: z.object({ open: z.boolean() }),
	async execute() {
		return { open: true };
	},
});

/** A cross-runtime prop — no Zod schema, so the registry records no outputSchema. */
const pyStats = runtimeNode<{ userId: string }, { total: number }>("py.stats", "runtime.python3");

const OrdersIndex = definePage("DP/Orders", {
	auth: always(currentUser),
	orders: listOrders,
	filters: optional(loadFilters),
	stats: defer(pyStats, { group: "dashboard", rescue: true }),
	feed: merge(listOrders, { append: "items", matchOn: "id" }),
});

describe("11 — getPageRegistry()", () => {
	it("lists the component, every prop key, its mode and (where there is one) its output schema", () => {
		const entry = getPageRegistry().get("DP/Orders");
		expect(entry).toBeDefined();
		expect(entry?.component).toBe("DP/Orders");
		expect(Object.keys(entry?.props ?? {})).toEqual(["auth", "orders", "filters", "stats", "feed"]);
		expect(entry?.props.auth?.mode).toBe("always");
		expect(entry?.props.orders?.mode).toBe("regular");
		expect(entry?.props.filters?.mode).toBe("optional");
		expect(entry?.props.stats).toMatchObject({ mode: "defer", group: "dashboard", rescue: true });
		expect(entry?.props.feed).toMatchObject({ mode: "merge", merge: { append: "items", matchOn: "id" } });

		// A `defineNode` prop carries its Zod output schema; a `runtimeNode` stub has none.
		expect(entry?.props.auth?.outputSchema?.safeParse({ id: "x", email: "y" }).success).toBe(true);
		expect(entry?.props.stats?.outputSchema).toBeUndefined();
	});

	it("records where the page was declared, for codegen and DevTools", () => {
		const entry = getPageRegistry().get("DP/Orders");
		expect(entry?.source?.file).toContain("define-page.test.ts");
		expect(entry?.source?.line).toBeGreaterThan(0);
	});
});

describe("12 — duplicate component names", () => {
	it("throws at definition time, naming the duplicate", () => {
		expect(() => definePage("DP/Orders", { auth: currentUser })).toThrow(/DP\/Orders.*already declared/s);
	});
});

describe("shared()", () => {
	it("mints a handle rooted at the given state key", () => {
		const auth = shared(currentUser, "auth");
		// Handles are opaque Proxies — the observable contract is that reading a
		// field lowers to that state path, which the emitted step proves below.
		expect(typeof auth).toBe("function");
		expect(() => shared(currentUser, "")).toThrow(/state key/);
	});

	it("lowers to `ctx.state.<key>` inside a rendered page step", async () => {
		const Page = definePage("DP/Shared", { orders: listOrders });
		const wf = await workflow("dp-shared", { version: "1.0.0", trigger: http.get("/dp-shared") }, (req) => {
			Page.render(req, "page", "/dp-shared", { orders: { userId: shared(currentUser, "auth").id } });
		});
		const step = (wf as unknown as { _config: { steps: Record<string, unknown>[] } })._config.steps[0];
		expect(step).toMatchObject({
			id: "page",
			page: {
				component: "DP/Shared",
				url: "/dp-shared",
				props: {
					orders: { use: "dp-list-orders", inputs: { userId: { $ref: { step: "auth", path: ["id"] } } } },
				},
			},
		});
	});
});

describe("render()", () => {
	it("emits ONE page step carrying every prop's node ref, mode and options", async () => {
		const wf = await workflow("dp-orders", { version: "1.0.0", trigger: http.get("/dp-orders") }, (req) => {
			OrdersIndex.render(
				req,
				"page",
				"/dp-orders",
				{ orders: { userId: "u-1" }, stats: { userId: "u-1" }, feed: { userId: "u-1" } },
				{ version: "v2", encryptHistory: true },
			);
		});
		const steps = (wf as unknown as { _config: { steps: Record<string, unknown>[] } })._config.steps;
		expect(steps).toHaveLength(1);
		const page = (steps[0] as { page: Record<string, unknown> }).page;
		expect(page.component).toBe("DP/Orders");
		expect(page.inputs).toEqual({ version: "v2", encryptHistory: true });
		expect(page.props).toMatchObject({
			auth: { use: "dp-current-user", mode: "always", inputs: {} },
			orders: { use: "dp-list-orders", inputs: { userId: "u-1" } },
			filters: { use: "dp-load-filters", mode: "optional", inputs: {} },
			// a cross-runtime prop keeps its runtime KIND as the step type
			stats: { use: "py.stats", type: "runtime.python3", mode: "defer", group: "dashboard", rescue: true },
			feed: { use: "dp-list-orders", mode: "merge", merge: { append: "items", matchOn: "id" } },
		});
	});

	it("rejects a prop declared with something that is not a node", () => {
		expect(() => definePage("DP/Bad", { nope: {} as unknown as { name: string } })).toThrow(/must be a node value/);
	});
});
