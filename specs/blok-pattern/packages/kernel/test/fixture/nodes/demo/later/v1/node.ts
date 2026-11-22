import { z } from "zod";
import { todo } from "../../../../../../src/index.ts";
import { node } from "../../../../blok.ts";

export default node({
	id: "demo/later@1",
	input: z.object({}),
	output: z.object({ done: z.boolean() }),
	run: todo,
});
