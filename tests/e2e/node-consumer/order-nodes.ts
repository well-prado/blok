/**
 * The nodes a downstream project would keep in `src/nodes/` (#688).
 *
 * They exist to be tested — `runNode` unit-tests them in isolation and
 * `runWorkflow` wires them together, so `src/nodes/` never has to be excluded
 * from coverage to keep the suite importable.
 */
import { defineNode } from "@blokjs/core";
import { z } from "zod";

export const orderValidator = defineNode({
	name: "order-validator",
	description: "Normalizes an incoming order payload.",
	input: z.object({ body: z.object({ id: z.string(), total: z.number() }) }),
	output: z.object({ id: z.string(), total: z.number() }),
	execute: (_ctx, input) => ({ id: input.body.id, total: input.body.total }),
});

export const chargeCard = defineNode({
	name: "charge-card",
	description: "Charges a card. Talks to a real payment processor — mock it in tests.",
	input: z.object({ orderId: z.string(), amount: z.number() }),
	output: z.object({ receipt: z.string() }),
	execute: () => {
		throw new Error("charge-card reached the real payment processor — this step must be mocked in tests");
	},
});

export const flagVip = defineNode({
	name: "flag-vip",
	description: "Marks a large order as VIP.",
	input: z.object({ id: z.string() }),
	output: z.object({ vip: z.boolean() }),
	execute: (_ctx, input) => ({ vip: input.id.length > 0 }),
});
