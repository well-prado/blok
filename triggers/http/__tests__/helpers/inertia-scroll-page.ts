/**
 * The page under test in `HttpTrigger.inertia-scroll.test.ts` (#1010).
 *
 * It lives in its own module because the trigger's `Nodes` and `Workflows`
 * mocks both need the SAME node instances: the page step carries prop node
 * REFERENCES (`use: "wire-posts"`) once the workflow has been serialized at
 * boot, so the registry has to hand back the very nodes the page declared.
 */

import { http, defineNode, workflow } from "@blokjs/core";
import { definePage, paginate, paginatedSchema, scroll } from "@blokjs/inertia";
import { z } from "zod";

const POSTS = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));

export const listPosts = defineNode({
	name: "wire-posts",
	description: "offset-paginated posts",
	input: z.object({ page: z.union([z.number(), z.string()]).optional() }),
	output: paginatedSchema(z.object({ id: z.number() })),
	async execute(_ctx, input) {
		return paginate(POSTS, { page: input.page ?? 1, perPage: 10 });
	},
});

export const PostsPage = definePage("Wire/Posts", { posts: scroll(listPosts) });

export function postsWorkflow() {
	return workflow("posts", { version: "1.0.0", trigger: http.get("/posts") }, (req) => {
		PostsPage.render(req, "page", "/posts", { posts: { page: req.query.page } }, { version: "v1" });
	});
}
