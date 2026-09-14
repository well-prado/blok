/** Nodes the doctor fixture's page resolves its props with. */
import { defineNode } from "@blokjs/core";
import { z } from "zod";

export const currentUser = defineNode({
	name: "doctor-current-user",
	description: "the signed-in user",
	input: z.object({}),
	output: z.object({ id: z.string(), email: z.string() }),
	async execute() {
		return { id: "u-1", email: "a@b.c" };
	},
});

export const listOrders = defineNode({
	name: "doctor-list-orders",
	description: "an array prop",
	input: z.object({}),
	output: z.array(z.object({ id: z.string(), total: z.number() })),
	async execute() {
		return [];
	},
});
