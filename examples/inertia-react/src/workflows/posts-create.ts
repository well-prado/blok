/**
 * "Create a post" — the canonical form → workflow → the list on screen updates.
 *
 * Both halves live here: `GET /posts/new` renders the page WITH the current
 * posts, and `POST /posts` validates, writes, and redirects back. Inertia
 * follows that redirect as an XHR, so the page re-renders with the new post at
 * the top of the list and no full page load anywhere.
 *
 * `check` is marked `{ precognition: true }`: the form's blur handler posts the
 * same route with `Precognition: true`, the runner answers 204/422 from that
 * step alone, and nothing after it runs.
 */

import { http, type Handle, branch, eq, step, workflow } from "@blokjs/core";
import { ValidateNode } from "@blokjs/helpers";
import { always, definePage, scroll } from "@blokjs/inertia";
import { z } from "zod";
import { createPost, currentUser, listPosts, rejectSubmission } from "../nodes.js";

export const PostSchema = z.object({
	title: z.string().min(1, "Required."),
	body: z.string().min(1, "Required."),
});

/**
 * `auth` is `always()` for the same reason every page here declares it: the
 * persistent AppLayout reads it for the header identity.
 *
 * `posts` is the same `scroll()` prop the Dashboard grows — one node, two
 * pages. It is what makes the redirect back visible: the list is part of this
 * page's contract, so re-rendering the page re-renders the list.
 */
export const PostsCreate = definePage("Posts/Create", {
	auth: always(currentUser),
	posts: scroll(listPosts),
});

export const page = workflow(
	"posts-create-page",
	{ version: "1.0.0", trigger: http.get("/posts/new", { middleware: ["inertia.shared"] }) },
	(req) => {
		PostsCreate.render(
			req,
			"page",
			"/posts/new",
			{ posts: { page: req.query.page } },
			{
				viewData: { title: "New post" },
			},
		);
	},
);

export default workflow(
	"posts-create",
	{ version: "1.0.0", trigger: http.post("/posts", { middleware: ["inertia.shared"] }) },
	(req) => {
		// An HTTP body is `unknown` on the entry handle — `PostSchema` is what
		// actually validates it, so this cast only names the shape for the reads.
		const body = req.body as Handle<z.infer<typeof PostSchema>>;
		const checked = step("check", ValidateNode, { schema: PostSchema, data: body }, { precognition: true });
		branch("route", eq(checked.ok, true), {
			then: () => {
				step("create", createPost, { title: body.title, body: body.body });
			},
			else: () => {
				step("reject", rejectSubmission, { errors: checked.errors, fallback: "/posts/new" });
			},
		});
	},
);
