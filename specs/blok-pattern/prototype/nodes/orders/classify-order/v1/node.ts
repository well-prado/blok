import { z } from "zod";
import { node } from "#blok";

/** A decision is logic, so it lives in a node. The workflow only reads the answer. */
export default node({
	id: "orders/classify-order@1",
	description: "Decides which tier an order belongs to.",
	input: z.object({ totalCents: z.number().int().nonnegative() }),
	output: z.object({ vip: z.boolean(), tier: z.enum(["standard", "vip"]) }),
	idempotent: true,
	run({ totalCents }) {
		const vip = totalCents > 100_00;
		return { vip, tier: vip ? ("vip" as const) : ("standard" as const) };
	},
});
