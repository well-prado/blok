/** Nodes the fixture's pages resolve their props with. */
import { defineNode, runtimeNode } from "@blokjs/core";
import { z } from "zod";

export const currentUser = defineNode({
	name: "fixture-current-user",
	description: "the signed-in user",
	input: z.object({}),
	output: z.object({ id: z.string(), email: z.string() }),
	async execute() {
		return { id: "u-1", email: "a@b.c" };
	},
});

export const listOrders = defineNode({
	name: "fixture-list-orders",
	description: "nested-array prop",
	input: z.object({}),
	output: z.object({
		items: z.array(z.object({ id: z.string(), total: z.number(), tags: z.array(z.string()) })),
		cursor: z.string().nullable(),
	}),
	async execute() {
		return { items: [], cursor: null };
	},
});

export const orderStatus = defineNode({
	name: "fixture-order-status",
	description: "union prop",
	input: z.object({}),
	output: z.object({
		status: z.union([z.literal("open"), z.literal("closed"), z.number()]),
		source: z.enum(["web", "api"]),
		note: z.string().optional(),
	}),
	async execute() {
		return { status: "open" as const, source: "web" as const };
	},
});

export const heavyStats = defineNode({
	name: "fixture-heavy-stats",
	description: "deferred prop",
	input: z.object({}),
	output: z.object({ revenue: z.number() }),
	async execute() {
		return { revenue: 1 };
	},
});

export const loadFilters = defineNode({
	name: "fixture-load-filters",
	description: "optional prop",
	input: z.object({}),
	output: z.object({ open: z.boolean() }),
	async execute() {
		return { open: true };
	},
});

export const orderDetail = defineNode({
	name: "fixture-order-detail",
	description: "one order and its lines",
	input: z.object({}),
	output: z.object({
		id: z.string(),
		lines: z.array(z.object({ sku: z.string(), qty: z.number() })),
	}),
	async execute() {
		return { id: "o-1", lines: [] };
	},
});

export const orderEvents = defineNode({
	name: "fixture-order-events",
	description: "infinite-scroll prop",
	input: z.object({}),
	output: z.object({ data: z.array(z.string()), page: z.number() }),
	async execute() {
		return { data: [], page: 1 };
	},
});

export const orderForm = defineNode({
	name: "fixture-order-form",
	description: "a once-cached prop",
	input: z.object({}),
	output: z.object({ currencies: z.array(z.string()) }),
	async execute() {
		return { currencies: ["EUR"] };
	},
});

export const exportOrders = defineNode({
	name: "fixture-export-orders",
	description: "the step of a workflow with no page",
	input: z.object({}),
	output: z.object({ url: z.string() }),
	async execute() {
		return { url: "/tmp/orders.csv" };
	},
});

/** A cross-runtime stub: no Zod schema, so codegen can only emit `unknown`. */
export const legacyStats = runtimeNode<Record<string, never>, unknown>("fixture-legacy-stats", "runtime.python3");
