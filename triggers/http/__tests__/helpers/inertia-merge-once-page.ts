/**
 * The page under test in `HttpTrigger.inertia-merge-once.test.ts` (#1009).
 *
 * It lives in its own module because the trigger's `Nodes` and `Workflows`
 * mocks both need the SAME node instances: the page step carries prop node
 * REFERENCES (`use: "wire-feed"`) once the workflow has been serialized at
 * boot, so the registry has to hand back the very nodes the page declared.
 */

import { http, defineNode, workflow } from "@blokjs/core";
import { definePage, merge, once } from "@blokjs/inertia";
import { z } from "zod";

/** How often each prop node has run — the proof that a skip is a real skip. */
export const counts: Record<string, number> = {};

function count(name: string): number {
	counts[name] = (counts[name] ?? 0) + 1;
	return counts[name] as number;
}

export const loadFeed = defineNode({
	name: "wire-feed",
	description: "merge prop — one more row per call",
	input: z.object({}),
	output: z.object({ data: z.array(z.object({ id: z.number() })) }),
	async execute() {
		return { data: [{ id: count("wire-feed") }] };
	},
});

export const loadPlans = defineNode({
	name: "wire-plans",
	description: "once prop",
	input: z.object({}),
	output: z.object({ tiers: z.array(z.string()) }),
	async execute() {
		count("wire-plans");
		return { tiers: ["free"] };
	},
});

export const BillingPage = definePage("Billing/Index", {
	feed: merge(loadFeed, { append: "data", matchOn: "id" }),
	plans: once(loadPlans),
});

export function billingWorkflow() {
	return workflow("billing", { version: "1.0.0", trigger: http.get("/billing") }, (req) => {
		BillingPage.render(req, "page", "/billing", {}, { version: "v1" });
	});
}
