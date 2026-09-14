/** The prop nodes of the standalone backend. */

import { defineNode } from "@blokjs/core";
import { z } from "zod";

const Order = z.object({ id: z.string(), sku: z.string(), total: z.number() });

const ORDERS = [
	{ id: "o-1", sku: "BLOK-1", total: 120 },
	{ id: "o-2", sku: "BLOK-2", total: 40 },
];

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

export const showOrder = defineNode({
	name: "show-order",
	description: "One order by id.",
	input: z.object({ id: z.string() }),
	output: Order,
	execute: (_ctx, input) => ORDERS.find((order) => order.id === input.id) ?? ORDERS[0],
});
