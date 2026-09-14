/** The nodes behind the Vue example's single page. */

import { defineNode } from "@blokjs/core";
import { paginate, paginatedSchema } from "@blokjs/inertia";
import { z } from "zod";

const Order = z.object({ id: z.string(), sku: z.string(), total: z.number() });
const Post = z.object({ id: z.string(), title: z.string() });

const ORDERS = [
	{ id: "o-1", sku: "BLOK-1", total: 120 },
	{ id: "o-2", sku: "BLOK-2", total: 40 },
];
const POSTS = Array.from({ length: 25 }, (_, index) => ({ id: `p-${index + 1}`, title: `Post ${index + 1}` }));

export const currentUser = defineNode({
	name: "current-user",
	description: "Resolve the signed-in user from the request cookies.",
	input: z.object({ headers: z.record(z.string()).optional() }),
	output: z.object({ id: z.string(), email: z.string() }),
	execute: () => ({ id: "u-1", email: "ada@example.com" }),
});

export const listOrders = defineNode({
	name: "list-orders",
	description: "Orders belonging to one user.",
	input: z.object({ userId: z.string() }),
	output: z.array(Order),
	execute: () => ORDERS,
});

export const heavyStats = defineNode({
	name: "heavy-stats",
	description: "An aggregate slow enough to be worth deferring.",
	input: z.object({ since: z.string() }),
	output: z.object({ revenue: z.number(), orders: z.number() }),
	execute: () => ({ revenue: 42_000, orders: 128 }),
});

export const listPosts = defineNode({
	name: "list-posts",
	description: "One page of posts, shaped for <InfiniteScroll>.",
	input: z.object({ page: z.string().optional() }),
	output: paginatedSchema(Post),
	execute: (_ctx, input) => paginate(POSTS, { page: input.page ?? 1, perPage: 10 }),
});
