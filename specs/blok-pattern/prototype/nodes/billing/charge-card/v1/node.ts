import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "billing/charge-card@1",
	description: "Charges a card token for an order.",
	input: z.object({ orderId: z.string(), amountCents: z.number().int().positive(), token: z.string().min(1) }),
	output: z.object({ receiptId: z.string() }),
	errors: { card_declined: "The payment provider refused the card." },
	effects: ["payments:charge"],
	timeoutMs: 5_000,
	async run(input, { ports, signal, fail }) {
		const res = await ports.payments.charge(input.token, input.amountCents, { signal });
		if (!res.ok) throw fail("card_declined", res.reason, { orderId: input.orderId });
		return { receiptId: res.id };
	},
});
