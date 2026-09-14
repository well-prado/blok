/**
 * Issue #1010 — infinite scroll, driven through the REAL runner:
 * `workflow() → normalizer → Configuration → PageNode → @blokjs/inertia`, so
 * every assertion covers the shipped path. Numbered cases map 1:1 to the tests
 * listed in the issue (10 lives in `client.jsdom.test.ts`, which drives the
 * stock `@inertiajs/core` client against these same responses; the
 * `<InfiniteScroll>` browser run is #1003).
 *
 * The header-driven cases (2, 3, 4) are ALSO run as real HTTP in
 * `triggers/http/__tests__/unit/HttpTrigger.inertia-scroll.test.ts`.
 */

import { http, defineNode, workflow } from "@blokjs/core";
import { runPage, runWorkflow } from "@blokjs/core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import "../src/index.js"; // registers the @blokjs/inertia serializer node
import { defer, definePage, scroll } from "../src/define-page.js";
import { cursorPaginate, cursorPaginatedSchema, paginate, paginatedSchema } from "../src/paginate.js";
import type { PageObject } from "../src/protocol.js";

// =============================================================================
// Prop nodes
// =============================================================================

const POSTS = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));
const postSchema = z.object({ id: z.number() });
const pageInput = z.object({ page: z.union([z.number(), z.string()]).optional() });

/** The ordinary case: a node that returns through `paginate()`. */
const listPosts = defineNode({
	name: "scroll-posts",
	description: "offset-paginated posts",
	input: pageInput,
	output: paginatedSchema(postSchema),
	async execute(_ctx, input) {
		return paginate(POSTS, { page: input.page ?? 1, perPage: 10 });
	},
});

/** Same data under a different wrapper key (test 5). */
const listItems = defineNode({
	name: "scroll-items",
	description: "paginated posts under `items`",
	input: pageInput,
	output: paginatedSchema(postSchema)
		.omit({ data: true })
		.extend({ items: z.array(postSchema) }),
	async execute(_ctx, input) {
		const { data, ...meta } = paginate(POSTS, { page: input.page ?? 1, perPage: 10 });
		return { ...meta, items: data };
	},
});

/** A shape that satisfies nothing — only a `metadata` resolver can read it (test 6). */
const legacyFeed = defineNode({
	name: "scroll-legacy",
	description: "a hand-rolled paginator",
	input: pageInput,
	output: z.object({
		rows: z.array(postSchema),
		meta: z.object({ cur: z.number(), nxt: z.number().nullable(), prv: z.number().nullable() }),
	}),
	async execute(_ctx, input) {
		const page = paginate(POSTS, { page: input.page ?? 1, perPage: 5 });
		return { rows: page.data, meta: { cur: page.currentPage, nxt: page.nextPage, prv: page.previousPage } };
	},
});

/** Cursor pagination (test 8). */
const CURSORS: Record<string, { next: string | null; prev: string | null }> = {
	"": { next: "cur-2", prev: null },
	"cur-2": { next: "cur-3", prev: "cur-1" },
};
const listMessages = defineNode({
	name: "scroll-messages",
	description: "cursor-paginated messages",
	input: z.object({ cursor: z.string().optional() }),
	output: cursorPaginatedSchema(z.string()),
	async execute(_ctx, input) {
		const at = CURSORS[input.cursor ?? ""] ?? { next: null, prev: null };
		return cursorPaginate(["m-1", "m-2"], { cursor: input.cursor ?? null, next: at.next, prev: at.prev });
	},
});

/** Two paginators on one page, each with its own query parameter (test 7). */
const listUsers = defineNode({
	name: "scroll-users",
	description: "paginated users",
	input: pageInput,
	output: paginatedSchema(z.string()),
	async execute(_ctx, input) {
		return paginate(["u-1", "u-2", "u-3"], { page: input.page ?? 1, perPage: 1, pageName: "users" });
	},
});
const listOrders = defineNode({
	name: "scroll-orders",
	description: "paginated orders",
	input: pageInput,
	output: paginatedSchema(z.string()),
	async execute(_ctx, input) {
		return paginate(["o-1", "o-2", "o-3"], { page: input.page ?? 1, perPage: 1, pageName: "orders" });
	},
});

// =============================================================================
// Pages
// =============================================================================

const PostsPage = definePage("Scroll/Posts", { posts: scroll(listPosts) });
const ItemsPage = definePage("Scroll/Items", { posts: scroll(listItems, { wrapper: "items" }) });
const LegacyPage = definePage("Scroll/Legacy", {
	legacy: scroll(legacyFeed, {
		wrapper: "rows",
		metadata: (out) => ({
			pageName: "p",
			currentPage: out.meta.cur,
			nextPage: out.meta.nxt,
			previousPage: out.meta.prv,
		}),
	}),
});
const MessagesPage = definePage("Scroll/Messages", { messages: scroll(listMessages) });
const TwoPage = definePage("Scroll/Two", {
	users: scroll(listUsers, { pageName: "users" }),
	orders: scroll(listOrders, { pageName: "orders" }),
});
const DeferredPage = definePage("Scroll/Deferred", { posts: defer(scroll(listPosts)) });

// A node whose output carries no cursor at all: the contract violation.
const bareList = defineNode({
	name: "scroll-bare",
	description: "no cursor metadata anywhere",
	input: z.object({}),
	output: z.object({ data: z.array(z.string()) }),
	async execute() {
		return { data: ["x"] };
	},
});
const BarePage = definePage("Scroll/Bare", { posts: scroll(bareList) });

// =============================================================================
// Harness
// =============================================================================

function postsWorkflow() {
	return workflow("scroll-posts-page", { version: "1.0.0", trigger: http.get("/posts") }, (req) => {
		PostsPage.render(req, "page", "/posts", { posts: { page: req.query.page } }, { version: "v1" });
	});
}

function itemsWorkflow() {
	return workflow("scroll-items-page", { version: "1.0.0", trigger: http.get("/items") }, (req) => {
		ItemsPage.render(req, "page", "/items", { posts: { page: req.query.page } }, { version: "v1" });
	});
}

function legacyWorkflow() {
	return workflow("scroll-legacy-page", { version: "1.0.0", trigger: http.get("/legacy") }, (req) => {
		LegacyPage.render(req, "page", "/legacy", { legacy: { page: req.query.p } }, { version: "v1" });
	});
}

function messagesWorkflow() {
	return workflow("scroll-messages-page", { version: "1.0.0", trigger: http.get("/messages") }, (req) => {
		MessagesPage.render(req, "page", "/messages", { messages: { cursor: req.query.cursor } }, { version: "v1" });
	});
}

function twoWorkflow() {
	return workflow("scroll-two-page", { version: "1.0.0", trigger: http.get("/two") }, (req) => {
		TwoPage.render(
			req,
			"page",
			"/two",
			{ users: { page: req.query.users }, orders: { page: req.query.orders } },
			{ version: "v1" },
		);
	});
}

function deferredWorkflow() {
	return workflow("scroll-deferred-page", { version: "1.0.0", trigger: http.get("/deferred") }, (req) => {
		DeferredPage.render(req, "page", "/deferred", { posts: { page: req.query.page } }, { version: "v1" });
	});
}

function bareWorkflow() {
	return workflow("scroll-bare-page", { version: "1.0.0", trigger: http.get("/bare") }, (req) => {
		BarePage.render(req, "page", "/bare", { posts: {} }, { version: "v1" });
	});
}

const INERTIA = { "x-inertia": "true" };

function pageOf(response: unknown): PageObject {
	return (response as { body: PageObject }).body;
}

/** Headers for a partial reload of `component`, plus whatever else the case needs. */
function partial(component: string, extra: Record<string, string> = {}) {
	return { ...INERTIA, "x-inertia-partial-component": component, ...extra };
}

// =============================================================================

describe("1 — full visit", () => {
	it("ships the first page, its cursors, and no merge label", async () => {
		const run = await runWorkflow(await postsWorkflow(), {}, { headers: INERTIA });

		expect(run.ok).toBe(true);
		const page = pageOf(run.response);
		expect((page.props.posts as { data: unknown[] }).data).toHaveLength(10);
		expect(page.scrollProps?.posts).toEqual({
			pageName: "page",
			previousPage: null,
			nextPage: 2,
			currentPage: 1,
			reset: false,
		});
		// "Full page visits will always replace props entirely, even if you've
		// marked them for merging" — so the LABEL is absent, not the metadata.
		expect(page.mergeProps).toBeUndefined();
		expect(page.prependProps).toBeUndefined();
	});
});

describe("2 — partial reload with `append` intent", () => {
	it("labels the wrapper path and re-emits the page-2 cursors", async () => {
		const run = await runWorkflow(
			await postsWorkflow(),
			{},
			{
				headers: partial("Scroll/Posts", {
					"x-inertia-partial-data": "posts",
					"x-inertia-infinite-scroll-merge-intent": "append",
				}),
				query: { page: "2" },
			},
		);

		const page = pageOf(run.response);
		expect(page.mergeProps).toEqual(["posts.data"]);
		expect(page.prependProps).toBeUndefined();
		expect((page.props.posts as { data: { id: number }[] }).data[0]).toEqual({ id: 11 });
		expect(page.scrollProps?.posts).toEqual({
			pageName: "page",
			previousPage: 1,
			nextPage: null,
			currentPage: 2,
			reset: false,
		});
	});
});

describe("3 — `prepend` intent", () => {
	it("moves the scroll label from mergeProps to prependProps", async () => {
		const run = await runWorkflow(
			await postsWorkflow(),
			{},
			{
				headers: partial("Scroll/Posts", {
					"x-inertia-partial-data": "posts",
					"x-inertia-infinite-scroll-merge-intent": "prepend",
				}),
				query: { page: "1" },
			},
		);

		const page = pageOf(run.response);
		expect(page.prependProps).toEqual(["posts.data"]);
		expect(page.mergeProps).toBeUndefined();
	});
});

describe("4 — `X-Inertia-Reset`", () => {
	it("flags the scroll prop and drops its merge label", async () => {
		const fresh = await runPage(await postsWorkflow(), {
			partial: ["posts"],
			reset: ["posts"],
			headers: { "x-inertia-infinite-scroll-merge-intent": "append" },
			query: { page: "2" },
		});

		expect(fresh.scrollProps.posts).toEqual({
			pageName: "page",
			previousPage: 1,
			nextPage: null,
			currentPage: 2,
			reset: true,
		});
		expect(fresh.mergeProps).toEqual([]);
		expect(fresh.prependProps).toEqual([]);
	});

	it("resetting the wrapper path means the same prop", async () => {
		const fresh = await runPage(await postsWorkflow(), { partial: ["posts"], reset: ["posts.data"] });

		expect(fresh.scrollProps.posts).toMatchObject({ reset: true });
		expect(fresh.mergeProps).toEqual([]);
	});
});

describe("5 — a custom `wrapper`", () => {
	it("labels `<prop>.<wrapper>` and still keys the entry by the prop", async () => {
		const run = await runWorkflow(
			await itemsWorkflow(),
			{},
			{ headers: partial("Scroll/Items", { "x-inertia-partial-data": "posts" }), query: { page: "2" } },
		);

		const page = pageOf(run.response);
		expect(page.mergeProps).toEqual(["posts.items"]);
		expect(page.scrollProps?.posts).toMatchObject({ currentPage: 2, previousPage: 1 });
		expect((page.props.posts as { items: unknown[] }).items).toHaveLength(10);
	});
});

describe("6 — a `metadata` resolver", () => {
	it("reads the cursors off an arbitrary shape", async () => {
		const run = await runWorkflow(
			await legacyWorkflow(),
			{},
			{ headers: partial("Scroll/Legacy", { "x-inertia-partial-data": "legacy" }), query: { p: "2" } },
		);

		const page = pageOf(run.response);
		expect(page.scrollProps?.legacy).toEqual({
			pageName: "p",
			previousPage: 1,
			nextPage: 3,
			currentPage: 2,
			reset: false,
		});
		expect(page.mergeProps).toEqual(["legacy.rows"]);
	});
});

describe("7 — two scroll props on one page", () => {
	it("gives each its own entry, merge path and query parameter", async () => {
		const run = await runWorkflow(
			await twoWorkflow(),
			{},
			{
				headers: partial("Scroll/Two", { "x-inertia-partial-data": "users,orders" }),
				query: { users: "2", orders: "3" },
			},
		);

		const page = pageOf(run.response);
		expect(page.scrollProps?.users).toMatchObject({ pageName: "users", currentPage: 2, nextPage: 3 });
		expect(page.scrollProps?.orders).toMatchObject({ pageName: "orders", currentPage: 3, nextPage: null });
		expect(page.mergeProps).toEqual(["users.data", "orders.data"]);
		expect(page.props.users).toMatchObject({ data: ["u-2"] });
		expect(page.props.orders).toMatchObject({ data: ["o-3"] });
	});
});

describe("8 — cursor pagination", () => {
	it("emits the cursor strings as the page identifiers", async () => {
		const run = await runWorkflow(
			await messagesWorkflow(),
			{},
			{ headers: partial("Scroll/Messages", { "x-inertia-partial-data": "messages" }), query: { cursor: "cur-2" } },
		);

		const page = pageOf(run.response);
		expect(page.scrollProps?.messages).toEqual({
			pageName: "cursor",
			previousPage: "cur-1",
			nextPage: "cur-3",
			currentPage: "cur-2",
			reset: false,
		});
		expect(page.mergeProps).toEqual(["messages.data"]);
	});
});

describe("9 — `defer(scroll(...))`", () => {
	it("announces the deferred prop with no scrollProps, then ships both on the partial", async () => {
		const full = await runWorkflow(await deferredWorkflow(), {}, { headers: INERTIA });
		const fullPage = pageOf(full.response);
		expect(fullPage.deferredProps).toEqual({ default: ["posts"] });
		expect(fullPage.props.posts).toBeUndefined();
		expect(fullPage.scrollProps).toBeUndefined();

		const deferred = await runWorkflow(
			await deferredWorkflow(),
			{},
			{ headers: partial("Scroll/Deferred", { "x-inertia-partial-data": "posts" }), query: { page: "1" } },
		);
		const page = pageOf(deferred.response);
		expect((page.props.posts as { data: unknown[] }).data).toHaveLength(10);
		expect(page.scrollProps?.posts).toMatchObject({ currentPage: 1, nextPage: 2 });
		expect(page.mergeProps).toEqual(["posts.data"]);
		expect(page.deferredProps).toBeUndefined();
	});
});

describe("a scroll prop whose output carries no cursor", () => {
	it("fails loudly instead of shipping a scroll that can never load", async () => {
		const run = await runWorkflow(await bareWorkflow(), {}, { headers: INERTIA });

		expect(run.ok).toBe(false);
		expect(String((run.error as Error)?.message ?? run.error)).toContain('page prop "posts" is declared `scroll()`');
	});
});
