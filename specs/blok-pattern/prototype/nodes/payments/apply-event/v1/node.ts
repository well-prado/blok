import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "payments/apply-event@1",
	description:
		"Records what a payment event says about its order, once. A queue may hand the same event over twice, and the second time changes nothing.",
	input: z.object({
		id: z.string().min(1),
		type: z.enum(["payment.succeeded", "payment.failed"]),
		orderId: z.string().min(1),
		amountCents: z.number().int().nonnegative(),
	}),
	output: z.object({ applied: z.boolean().describe("False when this event was already applied.") }),
	effects: ["paymentEvents:firstTime", "kv:write"],
	async run({ id, type, orderId, amountCents }, { ports }) {
		// One call decides whether this is the first time, so two copies of an event cannot both be first.
		if (!(await ports.paymentEvents.firstTime(id))) return { applied: false };
		await ports.kv.set(`payment:${orderId}`, { status: type === "payment.succeeded" ? "paid" : "failed", amountCents });
		return { applied: true };
	},
});
