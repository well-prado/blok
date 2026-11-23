import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "catalog/price-line@1",
	description: "Prices one order line from the catalog.",
	input: z.object({ sku: z.string(), qty: z.number().int().positive() }),
	output: z.object({ sku: z.string(), qty: z.number().int(), lineCents: z.number().int().nonnegative() }),
	errors: { unknown_sku: "The catalog has no product with this sku." },
	effects: ["catalog:read"],
	idempotent: true,
	async run({ sku, qty }, { ports, fail }) {
		const price = await ports.catalog.priceCents(sku);
		if (price === undefined) throw fail("unknown_sku", `No price for ${sku}`, { sku });
		return { sku, qty, lineCents: price * qty };
	},
});
