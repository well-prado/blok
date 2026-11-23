import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "orders/flag-vip@1",
	description: "Marks a customer as VIP in the CRM.",
	input: z.object({ customerId: z.string() }),
	output: z.object({ flagged: z.literal(true) }),
	effects: ["crm:write"],
	idempotent: true,
	retries: 2,
	async run({ customerId }, { ports }) {
		await ports.crm.flagVip(customerId);
		return { flagged: true as const };
	},
});
