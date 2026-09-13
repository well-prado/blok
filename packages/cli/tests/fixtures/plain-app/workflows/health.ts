import { http, defineNode, step, workflow } from "@blokjs/core";
import { z } from "zod";

const ping = defineNode({
	name: "fixture-plain-ping",
	description: "health probe",
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	async execute() {
		return { ok: true };
	},
});

export default workflow("health", { version: "1.0.0", trigger: http.get("/health") }, () => {
	step("ping", ping, {});
});
