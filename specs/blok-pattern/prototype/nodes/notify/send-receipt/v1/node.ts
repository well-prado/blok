import { z } from "zod";
import { node } from "#blok";

/** Formatting is logic too. The workflow hands over the facts and the node writes the message. */
export default node({
	id: "notify/send-receipt@1",
	description: "Emails a receipt to the customer.",
	input: z.object({
		customerId: z.string(),
		orderId: z.string(),
		receiptId: z.string(),
		totalCents: z.number().int(),
	}),
	output: z.object({ sent: z.literal(true) }),
	effects: ["mailer:send"],
	async run({ customerId, orderId, receiptId, totalCents }, { ports }) {
		const total = (totalCents / 100).toFixed(2);
		await ports.mailer.send(customerId, `Receipt for order ${orderId}`, `Paid ${total}. Receipt ${receiptId}.`);
		return { sent: true as const };
	},
});
