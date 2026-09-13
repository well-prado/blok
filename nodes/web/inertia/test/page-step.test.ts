/**
 * The `page` control step (#1008) driven through the REAL runner — every case
 * here goes `workflow() → normalizer → Configuration → PageNode → @blokjs/inertia`
 * via `runWorkflow`, so the assertions cover the shipped execution path.
 *
 * Numbered cases map 1:1 to the tests listed in issue #1008.
 */

import { fileURLToPath } from "node:url";
import { http, defineNode, workflow } from "@blokjs/core";
import { runWorkflow } from "@blokjs/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import "../src/index.js"; // registers the @blokjs/inertia serializer node
import { always, defer, definePage, merge, once, optional, scroll, shared } from "../src/define-page.js";
import type { PageObject } from "../src/protocol.js";

// =============================================================================
// Counter nodes — one per prop, so "did it run, and how often" is observable.
// =============================================================================

const counts: Record<string, number> = {};
function calls(name: string): number {
	return counts[name] ?? 0;
}

const currentUser = defineNode({
	name: "page-current-user",
	description: "counter prop",
	input: z.object({}),
	output: z.object({ id: z.string(), email: z.string() }),
	async execute() {
		counts["page-current-user"] = calls("page-current-user") + 1;
		return { id: "u-1", email: "a@b.c" };
	},
});

const listOrders = defineNode({
	name: "page-list-orders",
	description: "counter prop with a required input",
	input: z.object({ userId: z.string() }),
	output: z.object({ items: z.array(z.string()) }),
	async execute(_ctx, input) {
		counts["page-list-orders"] = calls("page-list-orders") + 1;
		return { items: [`o-${input.userId}`] };
	},
});

const loadFilters = defineNode({
	name: "page-load-filters",
	description: "counter prop",
	input: z.object({}),
	output: z.object({ open: z.boolean() }),
	async execute() {
		counts["page-load-filters"] = calls("page-load-filters") + 1;
		return { open: true };
	},
});

const heavyStats = defineNode({
	name: "page-heavy-stats",
	description: "counter prop that can be told to throw",
	input: z.object({ boom: z.boolean().optional() }),
	output: z.object({ total: z.number() }),
	async execute(_ctx, input) {
		counts["page-heavy-stats"] = calls("page-heavy-stats") + 1;
		if (input.boom) throw new Error("stats exploded");
		return { total: 42 };
	},
});

const otherStats = defineNode({
	name: "page-other-stats",
	description: "a prop in a second deferred group",
	input: z.object({}),
	output: z.object({ n: z.number() }),
	async execute() {
		counts["page-other-stats"] = calls("page-other-stats") + 1;
		return { n: 1 };
	},
});

const paginatePosts = defineNode({
	name: "page-paginate-posts",
	description: "counter prop with a nested shape",
	input: z.object({}),
	output: z.object({ data: z.array(z.string()), meta: z.object({ page: z.number() }) }),
	async execute() {
		counts["page-paginate-posts"] = calls("page-paginate-posts") + 1;
		return { data: ["p-1"], meta: { page: 1 } };
	},
});

const loadFeed = defineNode({
	name: "page-load-feed",
	description: "merge-mode prop",
	input: z.object({}),
	output: z.object({ data: z.array(z.string()) }),
	async execute() {
		counts["page-load-feed"] = calls("page-load-feed") + 1;
		return { data: ["f-1"] };
	},
});

const loadPlans = defineNode({
	name: "page-load-plans",
	description: "once-mode prop",
	input: z.object({}),
	output: z.object({ tiers: z.array(z.string()) }),
	async execute() {
		counts["page-load-plans"] = calls("page-load-plans") + 1;
		return { tiers: ["free"] };
	},
});

const slowA = defineNode({
	name: "page-slow-a",
	description: "100ms prop",
	input: z.object({}),
	output: z.object({ v: z.literal("a") }),
	async execute() {
		await new Promise((r) => setTimeout(r, 100));
		return { v: "a" as const };
	},
});

const slowB = defineNode({
	name: "page-slow-b",
	description: "100ms prop",
	input: z.object({}),
	output: z.object({ v: z.literal("b") }),
	async execute() {
		await new Promise((r) => setTimeout(r, 100));
		return { v: "b" as const };
	},
});

const flaky = defineNode({
	name: "page-flaky",
	description: "fails the first attempt, succeeds on the second",
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	async execute() {
		counts["page-flaky"] = calls("page-flaky") + 1;
		if (calls("page-flaky") < 2) throw new Error("transient");
		return { ok: true };
	},
});

// =============================================================================
// Pages
// =============================================================================

const OrdersIndex = definePage("Orders/Index", {
	auth: always(currentUser),
	orders: listOrders,
	filters: optional(loadFilters),
	stats: defer(heavyStats, { group: "dashboard" }),
	other: defer(otherStats, { group: "sidebar" }),
	feed: merge(loadFeed, { append: "data", matchOn: "id" }),
	plans: once(loadPlans, { until: "1h" }),
	posts: scroll(paginatePosts, { wrapper: "data" }),
});

const RescuePage = definePage("Rescue/Index", {
	auth: always(currentUser),
	stats: defer(heavyStats, { group: "dashboard", rescue: true }),
});

const StrictPage = definePage("Strict/Index", {
	auth: always(currentUser),
	stats: defer(heavyStats, { group: "dashboard" }),
});

const ParallelPage = definePage("Parallel/Index", { a: slowA, b: slowB });

const RetryPage = definePage("Retry/Index", { auth: always(currentUser), flaky });

// =============================================================================
// Harness
// =============================================================================

// Props resolve IN PARALLEL, so one prop can never read another's output. What
// it CAN read is the request, or a middleware step's output via `shared()`.
function ordersWorkflow() {
	return workflow("orders-page", { version: "1.0.0", trigger: http.get("/orders") }, (req) => {
		OrdersIndex.render(req, "page", "/orders", { orders: { userId: req.query.userId } }, { version: "v1" });
	});
}

const QUERY = { userId: "u-1" };

const INERTIA = { "x-inertia": "true" };

function pageOf(response: unknown): PageObject {
	return (response as { body: PageObject }).body;
}

beforeEach(() => {
	for (const key of Object.keys(counts)) delete counts[key];
});

// =============================================================================

describe("1 — full visit", () => {
	it("runs regular + always once each, skips optional and deferred, announces the groups", async () => {
		const run = await runWorkflow(await ordersWorkflow(), {}, { headers: INERTIA, query: QUERY });

		expect(run.ok).toBe(true);
		expect(calls("page-current-user")).toBe(1);
		expect(calls("page-list-orders")).toBe(1);
		expect(calls("page-load-filters")).toBe(0);
		expect(calls("page-heavy-stats")).toBe(0);
		expect(calls("page-other-stats")).toBe(0);

		const page = pageOf(run.response);
		expect(page.component).toBe("Orders/Index");
		expect(page.props.auth).toEqual({ id: "u-1", email: "a@b.c" });
		expect(page.props.orders).toEqual({ items: ["o-u-1"] });
		expect(page.props.filters).toBeUndefined();
		expect(page.props.stats).toBeUndefined();
		expect(page.deferredProps).toEqual({ dashboard: ["stats"], sidebar: ["other"] });
		// merge / once / scroll resolve like a regular prop and carry their labels.
		expect(page.props.feed).toEqual({ data: ["f-1"] });
		expect(page.mergeProps).toContain("feed.data");
		expect(page.matchPropsOn).toContain("feed.data.id");
		expect(page.onceProps?.plans?.prop).toBe("plans");
		expect(page.scrollProps?.["posts.data"]?.pageName).toBe("page");
	});
});

describe("2 — partial `only: [orders]`", () => {
	it("runs orders and the always-prop only, and still emits errors", async () => {
		const run = await runWorkflow(
			await ordersWorkflow(),
			{},
			{
				query: QUERY,
				headers: {
					...INERTIA,
					"x-inertia-partial-component": "Orders/Index",
					"x-inertia-partial-data": "orders",
				},
			},
		);

		expect(calls("page-list-orders")).toBe(1);
		expect(calls("page-current-user")).toBe(1);
		expect(calls("page-load-feed")).toBe(0);
		expect(calls("page-load-plans")).toBe(0);

		const page = pageOf(run.response);
		expect(Object.keys(page.props).sort()).toEqual(["auth", "errors", "orders"]);
		expect(page.props.errors).toEqual({});
	});
});

describe("3 — partial `only: [filters]` (optional prop)", () => {
	it("runs the optional prop and returns it", async () => {
		const run = await runWorkflow(
			await ordersWorkflow(),
			{},
			{
				query: QUERY,
				headers: {
					...INERTIA,
					"x-inertia-partial-component": "Orders/Index",
					"x-inertia-partial-data": "filters",
				},
			},
		);

		expect(calls("page-load-filters")).toBe(1);
		const page = pageOf(run.response);
		expect(page.props.filters).toEqual({ open: true });
		expect(page.props.orders).toBeUndefined();
	});
});

describe("4 — partial `except: [orders]`", () => {
	it("runs every regular prop but that one, and keeps the always-prop", async () => {
		const run = await runWorkflow(
			await ordersWorkflow(),
			{},
			{
				query: QUERY,
				headers: {
					...INERTIA,
					"x-inertia-partial-component": "Orders/Index",
					"x-inertia-partial-except": "orders",
				},
			},
		);

		expect(calls("page-list-orders")).toBe(0);
		expect(calls("page-current-user")).toBe(1);
		expect(calls("page-load-feed")).toBe(1);

		const page = pageOf(run.response);
		expect(page.props.orders).toBeUndefined();
		expect(page.props.auth).toEqual({ id: "u-1", email: "a@b.c" });
		expect(page.props.feed).toEqual({ data: ["f-1"] });
	});
});

describe("5 — `X-Inertia-Partial-Component` names a different component", () => {
	it("is treated as a full visit — optional and deferred stay unresolved", async () => {
		const run = await runWorkflow(
			await ordersWorkflow(),
			{},
			{
				query: QUERY,
				headers: {
					...INERTIA,
					"x-inertia-partial-component": "Other/Page",
					"x-inertia-partial-data": "filters",
				},
			},
		);

		expect(calls("page-load-filters")).toBe(0);
		expect(calls("page-heavy-stats")).toBe(0);
		expect(calls("page-list-orders")).toBe(1);
		expect(pageOf(run.response).deferredProps).toEqual({ dashboard: ["stats"], sidebar: ["other"] });
	});
});

describe("6 — deferred group request", () => {
	it("`only: [stats]` runs stats and leaves the other group untouched", async () => {
		const run = await runWorkflow(
			await ordersWorkflow(),
			{},
			{
				query: QUERY,
				headers: {
					...INERTIA,
					"x-inertia-partial-component": "Orders/Index",
					"x-inertia-partial-data": "stats",
				},
			},
		);

		expect(calls("page-heavy-stats")).toBe(1);
		expect(calls("page-other-stats")).toBe(0);
		const page = pageOf(run.response);
		expect(page.props.stats).toEqual({ total: 42 });
		// A partial never re-announces deferred work — that would loop forever.
		expect(page.deferredProps).toBeUndefined();
	});
});

describe("7 — rescue", () => {
	it("`rescue: true` omits the failed prop, lists it in rescuedProps, and the run succeeds", async () => {
		const wf = await workflow("rescue-page", { version: "1.0.0", trigger: http.get("/rescue") }, (req) => {
			RescuePage.render(req, "page", "/rescue", { stats: { boom: true } });
		});
		const run = await runWorkflow(
			wf,
			{},
			{
				headers: {
					...INERTIA,
					"x-inertia-partial-component": "Rescue/Index",
					"x-inertia-partial-data": "stats",
				},
			},
		);

		expect(run.ok).toBe(true);
		const page = pageOf(run.response);
		expect(page.props.stats).toBeUndefined();
		expect(page.rescuedProps).toEqual(["stats"]);
		// The failure is reported, not swallowed: the prop's own step never
		// persisted state.
		expect(run.state("page.stats")).toBeUndefined();
	});

	it("without `rescue` the same throw fails the workflow", async () => {
		const wf = await workflow("strict-page", { version: "1.0.0", trigger: http.get("/strict") }, (req) => {
			StrictPage.render(req, "page", "/strict", { stats: { boom: true } });
		});
		const run = await runWorkflow(
			wf,
			{},
			{
				headers: {
					...INERTIA,
					"x-inertia-partial-component": "Strict/Index",
					"x-inertia-partial-data": "stats",
				},
			},
		);

		expect(run.ok).toBe(false);
		expect(String(run.error)).toContain("stats exploded");
	});
});

describe("8 — dot-notation paths", () => {
	it("`only: [posts.data]` resolves the prop and narrows it; an unknown path is ignored", async () => {
		const run = await runWorkflow(
			await ordersWorkflow(),
			{},
			{
				query: QUERY,
				headers: {
					...INERTIA,
					"x-inertia-partial-component": "Orders/Index",
					"x-inertia-partial-data": "posts.data,nope.nothing",
				},
			},
		);

		expect(run.ok).toBe(true);
		expect(calls("page-paginate-posts")).toBe(1);
		const page = pageOf(run.response);
		expect(page.props.posts).toEqual({ data: ["p-1"] });
		expect(page.props.nope).toBeUndefined();
	});
});

describe("9 — parallelism", () => {
	it("two 100ms props finish in well under 200ms", async () => {
		const wf = await workflow("parallel-page", { version: "1.0.0", trigger: http.get("/parallel") }, (req) => {
			ParallelPage.render(req, "page", "/parallel", {});
		});
		const started = Date.now();
		const run = await runWorkflow(wf, {}, { headers: INERTIA, query: QUERY });
		const elapsed = Date.now() - started;

		expect(run.ok).toBe(true);
		expect(elapsed).toBeLessThan(200);
		expect(pageOf(run.response).props).toMatchObject({ a: { v: "a" }, b: { v: "b" } });
	});
});

describe("10 — per-prop retry", () => {
	it("retries only the prop that carries the retry block", async () => {
		const wf = await workflow("retry-page", { version: "1.0.0", trigger: http.get("/retry") }, (req) => {
			RetryPage.render(req, "page", "/retry", {});
		});
		// `render()` has no retry knob (it is a prop-level concern) — reach the
		// prop's step record directly, the same shape the JSON form carries.
		const model = (wf as unknown as { _config: { steps: { page: { props: Record<string, unknown> } }[] } })._config;
		(model.steps[0].page.props.flaky as Record<string, unknown>).retry = {
			maxAttempts: 2,
			minTimeoutInMs: 0,
			maxTimeoutInMs: 0,
		};

		const run = await runWorkflow(wf, {}, { headers: INERTIA, query: QUERY });

		expect(run.ok).toBe(true);
		expect(calls("page-flaky")).toBe(2);
		expect(calls("page-current-user")).toBe(1); // the sibling prop ran once
		expect(pageOf(run.response).props.flaky).toEqual({ ok: true });
	});
});

describe("11 — per-prop state slots", () => {
	it("each resolved prop lands at `<pageId>.<key>` and reports `executed`", async () => {
		const run = await runWorkflow(await ordersWorkflow(), {}, { headers: INERTIA, query: QUERY });

		expect(run.state("page.orders")).toEqual({ items: ["o-u-1"] });
		expect(run.state("page.auth")).toEqual({ id: "u-1", email: "a@b.c" });
		expect(run.step("page.orders")?.executed).toBe(true);
		expect(run.step("page.filters")?.executed).toBe(false);
		expect(run.state("page.filters")).toBeUndefined();
		// The page step itself persists the serializer's envelope.
		expect((run.state("page") as { status?: number }).status).toBe(200);
	});
});

describe("12 — JSON form (golden)", () => {
	const golden = fileURLToPath(new URL("./fixtures/orders-page.json", import.meta.url));

	it("loads and behaves identically to the TS form on a full visit", async () => {
		const fromJson = await runWorkflow(golden, {}, { headers: INERTIA, query: QUERY });
		for (const key of Object.keys(counts)) delete counts[key];
		const fromTs = await runWorkflow(await ordersWorkflow(), {}, { headers: INERTIA, query: QUERY });

		expect(fromJson.ok).toBe(true);
		// `onceProps.expiresAt` is wall-clock (`until: "1h"` from NOW), so the two
		// runs differ by however long the first took. Assert the shape, compare the rest.
		const stripExpiry = (page: PageObject): PageObject => ({
			...page,
			onceProps: Object.fromEntries(
				Object.entries(page.onceProps ?? {}).map(([k, v]) => [k, { ...v, expiresAt: "<iso>" }]),
			),
		});
		expect(pageOf(fromJson.response).onceProps?.plans?.expiresAt).toMatch(/^\d{4}-/);
		expect(stripExpiry(pageOf(fromJson.response))).toEqual(stripExpiry(pageOf(fromTs.response)));
	});

	it("resolves a deferred prop on a partial reload, exactly like the TS form", async () => {
		const headers = {
			...INERTIA,
			"x-inertia-partial-component": "Orders/Index",
			"x-inertia-partial-data": "stats",
		};
		const fromJson = await runWorkflow(golden, {}, { headers, query: QUERY });
		expect(calls("page-heavy-stats")).toBe(1);
		expect(calls("page-other-stats")).toBe(0);
		expect(pageOf(fromJson.response).props.stats).toEqual({ total: 42 });
		expect(fromJson.state("page.stats")).toEqual({ total: 42 });
	});
});
