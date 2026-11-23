import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "storage/kv-set@1",
	description: "Stores a value under a key.",
	input: z.object({ key: z.string().min(1), value: z.unknown() }),
	output: z.object({ key: z.string(), stored: z.literal(true) }),
	effects: ["kv:write"],
	idempotent: true,
	async run({ key, value }, { ports }) {
		await ports.kv.set(key, value);
		return { key, stored: true as const };
	},
});
