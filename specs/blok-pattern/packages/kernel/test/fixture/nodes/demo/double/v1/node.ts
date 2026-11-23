import { z } from "zod";
import { node } from "../../../../blok.ts";

export default node({
	id: "demo/double@1",
	description: "Doubles a number, and refuses thirteen.",
	input: z.object({ n: z.number().int() }),
	output: z.object({ n: z.number().int() }),
	errors: ["unlucky"],
	run({ n }, { ports, fail }) {
		if (n === 13) throw fail("unlucky", "Thirteen is refused.");
		ports.seen.push(n);
		return { n: n * 2 };
	},
});
