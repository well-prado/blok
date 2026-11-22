import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "http/api-call@1",
	description: "Calls an HTTP API and returns its status and body.",
	input: z.object({
		url: z.string().url(),
		method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
		headers: z.record(z.string(), z.string()).optional(),
		body: z.unknown().optional(),
	}),
	output: z.object({ status: z.number().int(), data: z.unknown() }),
	errors: ["upstream_failed"],
	effects: ["http:request"],
	timeoutMs: 10_000,
	async run(input, { ports, signal, fail }) {
		const res = await ports.http.request(input, { signal });
		if (res.status >= 400) throw fail("upstream_failed", `${input.method} ${input.url} answered ${res.status}`);
		return res;
	},
});
