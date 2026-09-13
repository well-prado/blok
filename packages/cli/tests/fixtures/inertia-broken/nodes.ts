import { defineNode } from "@blokjs/core";
import { z } from "zod";

export const whoami = defineNode({
	name: "broken-fixture-whoami",
	description: "a prop node",
	input: z.object({}),
	output: z.object({ id: z.string() }),
	async execute() {
		return { id: "u-1" };
	},
});
