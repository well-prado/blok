import { z } from "zod";
import { node } from "#blok";

const Page = z.object({ items: z.array(z.unknown()), next: z.string().url().nullish() });

/**
 * A loop that has to find out when to stop lives here, in ordinary code: it keeps its own
 * cursor, checks its own stop condition and has a hard limit. The workflow sees one step.
 */
export default node({
	id: "http/fetch-pages@1",
	description: "Follows a paged API until there is no next page, or until maxPages.",
	input: z.object({ url: z.string().url(), maxPages: z.number().int().min(1).max(100).default(10) }),
	output: z.object({ items: z.array(z.unknown()), pages: z.number().int(), complete: z.boolean() }),
	errors: {
		upstream_failed: "The other service could not be reached, or answered with an error.",
		bad_page: "A page came back in a shape that cannot be read.",
	},
	effects: ["http:request"],
	idempotent: true,
	timeoutMs: 30_000,
	async run({ url, maxPages }, { ports, signal, fail }) {
		const items: unknown[] = [];
		let next: string | null | undefined = url;
		let pages = 0;
		while (next && pages < maxPages) {
			const res = await ports.http.request({ url: next, method: "GET" }, { signal });
			if (res.status >= 400) throw fail("upstream_failed", `GET ${next} answered ${res.status}`);
			const page = Page.safeParse(res.data);
			if (!page.success) throw fail("bad_page", `GET ${next} did not return { items, next }`);
			items.push(...page.data.items);
			next = page.data.next;
			pages++;
		}
		return { items, pages, complete: !next };
	},
});
