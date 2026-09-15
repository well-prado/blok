/**
 * The nodes this example's pages are built from.
 *
 * Every prop of a page is one of these: an ordinary `defineNode()` value, or —
 * for `stats` — a `runtimeNode()` stub pointing at the Python sidecar in
 * `runtimes/python3/`. The runner resolves the selected ones in parallel.
 */

import { defineNode, runtimeNode } from "@blokjs/core";
import { cursorPaginate, cursorPaginatedSchema, flash, paginate, paginatedSchema, redirectBack } from "@blokjs/inertia";
import { z } from "zod";

const Order = z.object({ id: z.string(), sku: z.string(), total: z.number() });
const Post = z.object({ id: z.string(), title: z.string(), body: z.string() });
const Plan = z.object({ id: z.string(), price: z.number() });

/**
 * In-memory data, so the example runs with no database. A process restart is
 * the "migration": `create-post` below pushes onto this array and nothing else.
 * A real app writes to its store in exactly the same place.
 */
const ORDERS = [
	{ id: "o-1", sku: "BLOK-1", total: 120 },
	{ id: "o-2", sku: "BLOK-2", total: 40 },
];
const POSTS = Array.from({ length: 25 }, (_, index) => ({
	id: `p-${index + 1}`,
	title: `Post ${index + 1}`,
	body: `The body of post ${index + 1}.`,
}));

/** Who is signed in. `inertia.shared` runs this into `ctx.state.auth`. */
export const currentUser = defineNode({
	name: "current-user",
	description: "Resolve the signed-in user from the request cookies.",
	input: z.object({ headers: z.record(z.string()).optional() }),
	output: z.object({ id: z.string(), email: z.string() }),
	execute: (_ctx, input) => {
		const cookie = input.headers?.cookie ?? "";
		return cookie.includes("guest=1") ? { id: "", email: "" } : { id: "u-1", email: "ada@example.com" };
	},
});

export const listOrders = defineNode({
	name: "list-orders",
	description: "Orders belonging to one user.",
	input: z.object({ userId: z.string() }),
	output: z.array(Order),
	execute: () => ORDERS,
});

/** `merge()` prop: the client appends each page to `notifications.data`. */
export const loadNotifications = defineNode({
	name: "load-notifications",
	description: "One page of notifications.",
	input: z.object({ page: z.string().optional() }),
	output: z.object({ data: z.array(z.object({ id: z.string(), text: z.string() })) }),
	execute: (_ctx, input) => {
		const page = Number(input.page ?? "1");
		return { data: [{ id: `n-${page}`, text: `Notification ${page}` }] };
	},
});

/** `once()` prop: the client caches it and the node stops being run. */
export const loadPlans = defineNode({
	name: "load-plans",
	description: "Pricing plans — they rarely change.",
	input: z.object({}),
	output: z.array(Plan),
	execute: () => [
		{ id: "free", price: 0 },
		{ id: "pro", price: 20 },
	],
});

/** `scroll()` prop: offset pagination, cursors read off the resolved output. */
export const listPosts = defineNode({
	name: "list-posts",
	description: "One page of posts, shaped for <InfiniteScroll>.",
	input: z.object({ page: z.string().optional() }),
	output: paginatedSchema(Post),
	execute: (_ctx, input) => paginate(POSTS, { page: input.page ?? 1, perPage: 10 }),
});

/** A second scroll prop, on its own query parameter and cursor scheme. */
export const listActivity = defineNode({
	name: "list-activity",
	description: "Cursor-paginated activity feed.",
	input: z.object({ cursor: z.string().optional() }),
	output: cursorPaginatedSchema(z.object({ id: z.string() })),
	execute: (_ctx, input) =>
		cursorPaginate([{ id: `a-${input.cursor ?? "0"}` }], {
			cursor: input.cursor ?? null,
			next: `${Number(input.cursor ?? "0") + 1}`,
			prev: null,
			pageName: "activity",
		}),
});

/**
 * The cross-runtime prop: a Python node, declared as a typed stub.
 *
 * `runtimes/python3/nodes/dashboard_stats/node.py` implements it. Nothing about
 * Inertia reaches the Python side — it takes inputs and returns output, and the
 * runner persists the result like any other step.
 */
export const dashboardStats = runtimeNode<{ since: string }, { revenue: number; orders: number }>(
	"dashboard-stats",
	"runtime.python3",
);

export const createOrder = defineNode({
	name: "create-order",
	description: "Persist an order and bounce back with a toast.",
	input: z.object({ sku: z.string(), total: z.number() }),
	output: z.unknown(),
	execute: (ctx, input) => {
		ORDERS.push({ id: `o-${ORDERS.length + 1}`, sku: input.sku, total: input.total });
		// A STRING, not `{ type, message }`: `client/src/flash-toast.ts` — the
		// listener every template and example ships — toasts string flash values.
		// An object payload still reaches `page.flash`, it just renders nothing
		// until you write a component that reads it (docs/d/spa/flash-data.mdx).
		return flash("toast", `${input.sku} created.`).redirectBack(ctx.request, {
			fallback: "/orders/new",
		});
	},
});

/**
 * The write behind `POST /posts`. New posts go to the FRONT of the list, so the
 * redirect back re-renders the page with the new one already at the top.
 */
export const createPost = defineNode({
	name: "create-post",
	description: "Persist a post and bounce back with a toast.",
	input: z.object({ title: z.string(), body: z.string() }),
	output: z.unknown(),
	execute: (ctx, input) => {
		POSTS.unshift({ id: `p-${POSTS.length + 1}`, title: input.title, body: input.body });
		return flash("toast", "Post created.").redirectBack(ctx.request, {
			fallback: "/posts/new",
		});
	},
});

/** Redirect back carrying the validation errors — the `else` arm of any form. */
export const rejectSubmission = defineNode({
	name: "reject-submission",
	description: "Redirect back carrying the validation errors.",
	input: z.object({ errors: z.record(z.unknown()), fallback: z.string() }),
	output: z.unknown(),
	execute: (ctx, input) => redirectBack(ctx.request, { errors: input.errors, fallback: input.fallback }),
});
