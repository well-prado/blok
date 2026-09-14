/**
 * The same page contract as the React example, rendered by a Svelte 5 client.
 *
 * That is the point of the split: the server half does not know which framework
 * is on the other end of the protocol.
 */

import { http, workflow } from "@blokjs/core";
import { always, defer, definePage, scroll, shared } from "@blokjs/inertia";
import { currentUser, heavyStats, listOrders, listPosts } from "../nodes.js";

export const Dashboard = definePage("Dashboard", {
	auth: always(currentUser),
	orders: listOrders,
	stats: defer(heavyStats, { group: "dashboard", rescue: true }),
	posts: scroll(listPosts),
});

export default workflow(
	"dashboard",
	{ version: "1.0.0", trigger: http.get("/", { middleware: ["inertia.shared"] }) },
	(req) => {
		Dashboard.render(req, "page", "/", {
			orders: { userId: shared(currentUser, "auth").id },
			stats: { since: "2026-01-01" },
			posts: { page: req.query.page },
		});
	},
);
