import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "orders/release-stock@1",
	description: "Returns reserved stock after a failed order.",
	input: z.object({ orderId: z.string() }),
	output: z.object({ released: z.literal(true) }),
	effects: ["stock:write"],
	idempotent: true,
	async run({ orderId }, { ports }) {
		await ports.stock.release(orderId);
		return { released: true as const };
	},
});
