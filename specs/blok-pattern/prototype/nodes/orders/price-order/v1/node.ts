import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "orders/price-order@1",
	description: "Totals an order from catalog prices.",
	input: z.object({ items: z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })) }),
	output: z.object({ totalCents: z.number().int().nonnegative() }),
	errors: ["unknown_sku"],
	effects: ["catalog:read"],
	idempotent: true,
	async run({ items }, { ports, fail }) {
		let totalCents = 0;
		for (const item of items) {
			const price = await ports.catalog.priceCents(item.sku);
			if (price === undefined) throw fail("unknown_sku", `No price for ${item.sku}`, { sku: item.sku });
			totalCents += price * item.qty;
		}
		return { totalCents };
	},
});
