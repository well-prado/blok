/**
 * Issue #1009 — merge props and once props, driven through the REAL runner:
 * `workflow() → normalizer → Configuration → PageNode → @blokjs/inertia`, so
 * every assertion covers the shipped path. Numbered cases map 1:1 to the tests
 * listed in the issue (13 lives in `client.jsdom.test.ts`, which drives the
 * stock `@inertiajs/core` client against these same responses).
 *
 * Every prop is a COUNTER node: "the node was skipped" is asserted as "it never
 * ran", not as "the key is missing from the page object".
 */

import { http, defineNode, workflow } from "@blokjs/core";
import { runWorkflow } from "@blokjs/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import "../src/index.js"; // registers the @blokjs/inertia serializer node
import { defer, definePage, merge, once } from "../src/define-page.js";
import type { PageObject } from "../src/protocol.js";

// =============================================================================
// Counter nodes
// =============================================================================

const counts: Record<string, number> = {};
function calls(name: string): number {
	return counts[name] ?? 0;
}

/** A node that counts its runs and returns `value` (or the n-th of a series). */
function counterNode<T extends z.ZodTypeAny>(name: string, output: T, value: (run: number) => z.infer<T>) {
	return defineNode({
		name,
		description: "counter prop",
		input: z.object({}),
		output,
		async execute() {
			counts[name] = calls(name) + 1;
			return value(calls(name));
		},
	});
}

const rowsSchema = z.object({ data: z.array(z.object({ id: z.number() })) });

const loadFeed = counterNode("mo-feed", rowsSchema, (n) => ({ data: [{ id: n }] }));
const loadChat = counterNode("mo-chat", z.object({ messages: z.array(z.string()), online: z.number() }), () => ({
	messages: ["m-1"],
	online: 2,
}));
const loadForum = counterNode(
	"mo-forum",
	z.object({ posts: z.array(z.string()), announcements: z.array(z.string()) }),
	() => ({ posts: ["p-1"], announcements: ["a-1"] }),
);
const loadDashboard = counterNode(
	"mo-dashboard",
	z.object({ notifications: z.array(z.string()), activities: z.array(z.string()), seen: z.boolean() }),
	() => ({ notifications: ["n-1"], activities: ["a-1"], seen: false }),
);
const loadComplex = counterNode(
	"mo-complex",
	z.object({ users: z.object({ data: z.array(z.string()) }), messages: z.array(z.string()) }),
	() => ({ users: { data: ["u-1"] }, messages: ["m-1"] }),
);
const loadDeepChat = counterNode(
	"mo-deep-chat",
	z.object({ messages: z.array(z.object({ id: z.number() })), online: z.number() }),
	() => ({ messages: [{ id: 4 }], online: 12 }),
);
const loadTags = counterNode("mo-tags", z.array(z.string()), () => ["Laravel"]);

const loadPlans = counterNode("mo-plans", z.object({ tiers: z.array(z.string()) }), () => ({ tiers: ["free"] }));
const loadRates = counterNode("mo-rates", z.object({ usd: z.number() }), () => ({ usd: 1 }));
const loadStale = counterNode("mo-stale", z.object({ v: z.number() }), (n) => ({ v: n }));
const loadForced = counterNode("mo-forced", z.object({ v: z.number() }), (n) => ({ v: n }));
const loadRoles = counterNode("mo-roles", z.object({ names: z.array(z.string()) }), () => ({ names: ["admin"] }));

// =============================================================================
// Pages
// =============================================================================

const MergePage = definePage("Merge/Index", {
	// Root-level append is the default; the docs' "load more" case.
	tags: merge(loadTags),
	feed: merge(loadFeed, { append: "data", matchOn: "id" }),
	chat: merge(loadChat, { prepend: "messages" }),
	forum: merge(loadForum, { append: "posts", prepend: "announcements" }),
	dashboard: merge(loadDashboard, { append: ["notifications", "activities"] }),
	complex: merge(loadComplex, { append: { "users.data": "id", messages: "uuid" } }),
	deepChat: merge(loadDeepChat, { deep: true, matchOn: "messages.id" }),
});

const OncePage = definePage("Once/Index", {
	plans: once(loadPlans),
	rates: once(loadRates, { until: "1h" }),
	stale: once(loadStale, { until: "2020-01-01T00:00:00.000Z" }),
	forced: once(loadForced, { fresh: true }),
	memberRoles: once(loadRoles, { as: "catalog" }),
});

// Two pages, two prop names, ONE remembered value — that is what `as` buys.
const InvitePage = definePage("Team/Invite", {
	availableRoles: once(loadRoles, { as: "catalog" }),
});

// `Inertia::defer(fn)->deepMerge()`: deferred on the full visit, mergeable on
// the partial that fetches it.
const DeferMergePage = definePage("Users/Index", {
	results: defer(merge(loadFeed, { deep: true, matchOn: "data.id" }), { group: "dashboard" }),
});

// =============================================================================
// Harness
// =============================================================================

const INERTIA = { "x-inertia": "true" };

function pageOf(response: unknown): PageObject {
	return (response as { body: PageObject }).body;
}

function mergeWorkflow() {
	return workflow("merge-page", { version: "1.0.0", trigger: http.get("/merge") }, (req) => {
		MergePage.render(req, "page", "/merge", {}, { version: "v1" });
	});
}

function onceWorkflow() {
	return workflow("once-page", { version: "1.0.0", trigger: http.get("/billing") }, (req) => {
		OncePage.render(req, "page", "/billing", {}, { version: "v1" });
	});
}

function inviteWorkflow() {
	return workflow("invite-page", { version: "1.0.0", trigger: http.get("/invite") }, (req) => {
		InvitePage.render(req, "page", "/invite", {}, { version: "v1" });
	});
}

function deferMergeWorkflow() {
	return workflow("defer-merge-page", { version: "1.0.0", trigger: http.get("/users") }, (req) => {
		DeferMergePage.render(req, "page", "/users", {}, { version: "v1" });
	});
}

/** Headers for a partial reload of `component`, plus whatever else the case needs. */
function partial(component: string, extra: Record<string, string> = {}) {
	return { ...INERTIA, "x-inertia-partial-component": component, ...extra };
}

beforeEach(() => {
	for (const key of Object.keys(counts)) delete counts[key];
});

// =============================================================================
// merge
// =============================================================================

describe("1 — a full visit carries no merge metadata", () => {
	it("resolves the props and emits none of the merge arrays", async () => {
		const run = await runWorkflow(await mergeWorkflow(), {}, { headers: INERTIA });

		expect(run.ok).toBe(true);
		expect(calls("mo-feed")).toBe(1);
		const page = pageOf(run.response);
		// The values ship — it is only the LABELS that a full visit drops, because
		// "full page visits will always replace props entirely".
		expect(page.props.feed).toEqual({ data: [{ id: 1 }] });
		expect(page.mergeProps).toBeUndefined();
		expect(page.prependProps).toBeUndefined();
		expect(page.deepMergeProps).toBeUndefined();
		expect(page.matchPropsOn).toBeUndefined();
	});
});

describe("2 — partial `only: [feed]`", () => {
	it("labels the targeted sub-path and its match field", async () => {
		const run = await runWorkflow(
			await mergeWorkflow(),
			{},
			{ headers: partial("Merge/Index", { "x-inertia-partial-data": "feed" }) },
		);

		const page = pageOf(run.response);
		expect(page.mergeProps).toEqual(["feed.data"]);
		expect(page.matchPropsOn).toEqual(["feed.data.id"]);
		expect(page.prependProps).toBeUndefined();
	});

	it("a bare `merge(node)` appends the whole prop, and a list targets each path", async () => {
		const run = await runWorkflow(
			await mergeWorkflow(),
			{},
			{ headers: partial("Merge/Index", { "x-inertia-partial-data": "tags,dashboard" }) },
		);

		const page = pageOf(run.response);
		expect(page.mergeProps).toEqual(["tags", "dashboard.notifications", "dashboard.activities"]);
		expect(page.matchPropsOn).toBeUndefined();
	});

	it("the map form pairs each path with its own match field", async () => {
		const run = await runWorkflow(
			await mergeWorkflow(),
			{},
			{ headers: partial("Merge/Index", { "x-inertia-partial-data": "complex" }) },
		);

		const page = pageOf(run.response);
		expect(page.mergeProps).toEqual(["complex.users.data", "complex.messages"]);
		// `<mergePath>.<field>` — the client splits on the LAST dot.
		expect(page.matchPropsOn).toEqual(["complex.users.data.id", "complex.messages.uuid"]);
	});
});

describe("3 — prepend, and both directions on one prop", () => {
	it("`prepend: 'messages'` labels prependProps only", async () => {
		const run = await runWorkflow(
			await mergeWorkflow(),
			{},
			{ headers: partial("Merge/Index", { "x-inertia-partial-data": "chat" }) },
		);

		const page = pageOf(run.response);
		expect(page.prependProps).toEqual(["chat.messages"]);
		expect(page.mergeProps).toBeUndefined();
	});

	it("append + prepend on one prop fills both arrays", async () => {
		const run = await runWorkflow(
			await mergeWorkflow(),
			{},
			{ headers: partial("Merge/Index", { "x-inertia-partial-data": "forum" }) },
		);

		const page = pageOf(run.response);
		expect(page.mergeProps).toEqual(["forum.posts"]);
		expect(page.prependProps).toEqual(["forum.announcements"]);
	});
});

describe("4 — deep merge", () => {
	it("`deep: true` labels the whole prop and `matchOn` addresses the nested array", async () => {
		const run = await runWorkflow(
			await mergeWorkflow(),
			{},
			{ headers: partial("Merge/Index", { "x-inertia-partial-data": "deepChat" }) },
		);

		const page = pageOf(run.response);
		expect(page.deepMergeProps).toEqual(["deepChat"]);
		expect(page.matchPropsOn).toEqual(["deepChat.messages.id"]);
		expect(page.mergeProps).toBeUndefined();
	});
});

describe("5 — `X-Inertia-Reset`", () => {
	it("still resolves the prop, and returns it without a merge label", async () => {
		const run = await runWorkflow(
			await mergeWorkflow(),
			{},
			{
				headers: partial("Merge/Index", {
					"x-inertia-partial-data": "feed,chat",
					"x-inertia-reset": "feed.data",
				}),
			},
		);

		// A reset prop is RESOLVED — the client wants a fresh copy, not no copy.
		expect(calls("mo-feed")).toBe(1);
		const page = pageOf(run.response);
		expect(page.props.feed).toEqual({ data: [{ id: 1 }] });
		expect(page.mergeProps ?? []).not.toContain("feed.data");
		// The matching key goes with it — it names a path nothing merges any more.
		expect(page.matchPropsOn ?? []).not.toContain("feed.data.id");
		// A sibling prop the client did NOT reset keeps its label.
		expect(page.prependProps).toEqual(["chat.messages"]);
	});
});

// =============================================================================
// once
// =============================================================================

describe("6 — once: resolved once, then skipped", () => {
	it("the first visit runs the node and announces the entry", async () => {
		const run = await runWorkflow(await onceWorkflow(), {}, { headers: INERTIA });

		expect(calls("mo-plans")).toBe(1);
		const page = pageOf(run.response);
		expect(page.props.plans).toEqual({ tiers: ["free"] });
		expect(page.onceProps?.plans).toEqual({ prop: "plans", expiresAt: null });
	});

	it("a request carrying the key in `X-Inertia-Except-Once-Props` does NOT run it", async () => {
		const run = await runWorkflow(
			await onceWorkflow(),
			{},
			{ headers: { ...INERTIA, "x-inertia-except-once-props": "plans" } },
		);

		expect(calls("mo-plans")).toBe(0);
		const page = pageOf(run.response);
		expect(page.props.plans).toBeUndefined();
		// The ENTRY stays: the client reads it to learn its cached copy is still
		// good. A missing entry would invalidate the cache.
		expect(page.onceProps?.plans).toEqual({ prop: "plans", expiresAt: null });
	});

	it("a partial reload WITHOUT `only` resolves once props — unless the header excludes them", async () => {
		const resolved = await runWorkflow(await onceWorkflow(), {}, { headers: partial("Once/Index") });
		expect(calls("mo-plans")).toBe(1);
		expect(pageOf(resolved.response).props.plans).toEqual({ tiers: ["free"] });

		counts["mo-plans"] = 0;
		const skipped = await runWorkflow(
			await onceWorkflow(),
			{},
			{ headers: partial("Once/Index", { "x-inertia-except-once-props": "plans" }) },
		);
		expect(calls("mo-plans")).toBe(0);
		expect(pageOf(skipped.response).props.plans).toBeUndefined();
	});
});

describe("7 — `until`", () => {
	it("a duration becomes an epoch-ms expiry, and an elapsed one resolves again", async () => {
		const before = Date.now();
		const run = await runWorkflow(
			await onceWorkflow(),
			{},
			{ headers: { ...INERTIA, "x-inertia-except-once-props": "rates,stale" } },
		);

		const page = pageOf(run.response);
		const expiresAt = page.onceProps?.rates?.expiresAt as number;
		// Milliseconds, because that is what the client compares against Date.now().
		expect(typeof expiresAt).toBe("number");
		expect(expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
		expect(expiresAt).toBeLessThan(before + 3_600_000 + 5_000);
		// `rates` has not expired, so the client's claim stands and it never ran.
		expect(calls("mo-rates")).toBe(0);

		// `stale`'s absolute deadline is in the past: the claim is stale, so the
		// node runs and a fresh value ships despite the header.
		expect(calls("mo-stale")).toBe(1);
		expect(page.props.stale).toEqual({ v: 1 });
		expect(page.onceProps?.stale?.expiresAt).toBe(Date.parse("2020-01-01T00:00:00.000Z"));
	});
});

describe("8 — `fresh`", () => {
	it("resolves and resends even when the client says it still holds the value", async () => {
		const run = await runWorkflow(
			await onceWorkflow(),
			{},
			{ headers: { ...INERTIA, "x-inertia-except-once-props": "plans,forced" } },
		);

		expect(calls("mo-forced")).toBe(1);
		expect(calls("mo-plans")).toBe(0);
		const page = pageOf(run.response);
		expect(page.props.forced).toEqual({ v: 1 });
		expect(page.onceProps?.forced).toEqual({ prop: "forced", expiresAt: null });
	});
});

describe("9 — `as`", () => {
	it("two pages under different prop names share one cache key", async () => {
		const team = pageOf((await runWorkflow(await onceWorkflow(), {}, { headers: INERTIA })).response);
		expect(team.onceProps?.catalog).toEqual({ prop: "memberRoles", expiresAt: null });
		expect(calls("mo-roles")).toBe(1);

		// The second page holds the value under the SAME key, so its own prop is
		// skipped — one resolve for both pages.
		const invite = pageOf(
			(
				await runWorkflow(
					await inviteWorkflow(),
					{},
					{ headers: { ...INERTIA, "x-inertia-except-once-props": "catalog" } },
				)
			).response,
		);
		expect(calls("mo-roles")).toBe(1);
		expect(invite.onceProps?.catalog).toEqual({ prop: "availableRoles", expiresAt: null });
		expect(invite.props.availableRoles).toBeUndefined();
	});
});

describe("10 — an explicit partial request always resolves", () => {
	it("`only: [plans]` wins over the except-once header", async () => {
		const run = await runWorkflow(
			await onceWorkflow(),
			{},
			{
				headers: partial("Once/Index", {
					"x-inertia-partial-data": "plans",
					"x-inertia-except-once-props": "plans",
				}),
			},
		);

		expect(calls("mo-plans")).toBe(1);
		expect(pageOf(run.response).props.plans).toEqual({ tiers: ["free"] });
	});
});

describe("11 — `defer(merge(...))`", () => {
	it("is deferred on the full visit and mergeable on the partial that fetches it", async () => {
		const full = await runWorkflow(await deferMergeWorkflow(), {}, { headers: INERTIA });
		expect(calls("mo-feed")).toBe(0);
		const fullPage = pageOf(full.response);
		expect(fullPage.deferredProps).toEqual({ dashboard: ["results"] });
		expect(fullPage.deepMergeProps).toBeUndefined();

		const partialRun = await runWorkflow(
			await deferMergeWorkflow(),
			{},
			{ headers: partial("Users/Index", { "x-inertia-partial-data": "results" }) },
		);
		expect(calls("mo-feed")).toBe(1);
		const page = pageOf(partialRun.response);
		expect(page.props.results).toEqual({ data: [{ id: 1 }] });
		expect(page.deepMergeProps).toEqual(["results"]);
		expect(page.matchPropsOn).toEqual(["results.data.id"]);
	});
});

describe("12 — prefetch", () => {
	it("a `Purpose: prefetch` request carries the remembered once props", async () => {
		const run = await runWorkflow(
			await onceWorkflow(),
			{},
			{ headers: { ...INERTIA, purpose: "prefetch", "x-inertia-except-once-props": "plans,rates" } },
		);

		expect(calls("mo-plans")).toBe(0);
		const page = pageOf(run.response);
		// The prefetched page names both entries, so the client can fill them from
		// its own cache when it navigates — a prefetch is not a reason to forget.
		expect(page.onceProps?.plans).toEqual({ prop: "plans", expiresAt: null });
		expect(page.onceProps?.rates?.prop).toBe("rates");
		expect(page.props.plans).toBeUndefined();
	});
});
