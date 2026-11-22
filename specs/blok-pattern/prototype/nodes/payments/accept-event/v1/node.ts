import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "payments/accept-event@1",
	description: "Hands a payment event over to be applied later, so the sender gets its answer at once.",
	input: z.object({
		id: z.string().min(1).describe("The sender's id for this event. The same event sent twice has the same id."),
		type: z.enum(["payment.succeeded", "payment.failed"]),
		orderId: z.string().min(1),
		amountCents: z.number().int().nonnegative(),
	}),
	output: z.object({ accepted: z.literal(true) }),
	effects: ["paymentEvents:publish"],
	async run(event, { ports }) {
		await ports.paymentEvents.publish(event);
		return { accepted: true as const };
	},
});
