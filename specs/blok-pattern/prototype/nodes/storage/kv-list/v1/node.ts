import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "storage/kv-list@1",
	description: "Lists every stored value.",
	input: z.object({}),
	output: z.object({ items: z.array(z.unknown()) }),
	effects: ["kv:read"],
	idempotent: true,
	async run(_input, { ports }) {
		return { items: await ports.kv.list() };
	},
});
