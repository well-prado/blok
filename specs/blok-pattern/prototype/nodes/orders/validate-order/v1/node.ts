import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "orders/validate-order@1",
	description: "Checks an incoming order and gives it an id.",
	input: z.object({
		customerId: z.string().min(1),
		items: z.array(z.object({ sku: z.string().min(1), qty: z.number().int().positive() })).min(1),
	}),
	output: z.object({
		orderId: z.string(),
		customerId: z.string(),
		items: z.array(z.object({ sku: z.string(), qty: z.number() })),
	}),
	effects: ["ids:next"],
	run(input, { ports }) {
		return { orderId: ports.ids.next("ord"), customerId: input.customerId, items: input.items };
	},
});
