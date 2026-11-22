import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "orders/sum-lines@1",
	description: "Adds up priced order lines.",
	input: z.object({ lines: z.array(z.object({ lineCents: z.number().int().nonnegative() })) }),
	output: z.object({ totalCents: z.number().int().nonnegative(), lineCount: z.number().int() }),
	idempotent: true,
	run({ lines }) {
		return { totalCents: lines.reduce((sum, line) => sum + line.lineCents, 0), lineCount: lines.length };
	},
});
