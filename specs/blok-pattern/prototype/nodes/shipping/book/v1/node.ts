import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "shipping/book@1",
	description: "Books a shipment for an order on one lane.",
	input: z.object({ orderId: z.string(), lane: z.enum(["courier", "post", "hold"]) }),
	output: z.object({ trackingId: z.string(), lane: z.string() }),
	effects: ["shipping:book"],
	async run({ orderId, lane }, { ports }) {
		return { trackingId: await ports.shipping.book(orderId, lane), lane };
	},
});
