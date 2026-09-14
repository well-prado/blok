/**
 * The dashboard page: one workflow, one `page` control step, six props in five
 * different modes — including `stats`, which is computed by a Python node.
 */

import { http, workflow } from "@blokjs/core";
import { always, defer, definePage, merge, once, scroll, shared } from "@blokjs/inertia";
import {
	currentUser,
	dashboardStats,
	listActivity,
	listOrders,
	listPosts,
	loadNotifications,
	loadPlans,
} from "../nodes.js";

export const Dashboard = definePage("Dashboard", {
	/** Never filtered out — the layout cannot render without it. */
	auth: always(currentUser),
	/** Regular: resolved on a full visit and on any partial that names it. */
	orders: listOrders,
	/** Python. Announced on the full visit, fetched by the client right after. */
	stats: defer(dashboardStats, { group: "dashboard", rescue: true }),
	/** The client appends each page to `notifications.data`. */
	notifications: merge(loadNotifications, { append: "data", matchOn: "id" }),
	/** Resolved once; afterwards the client replays its copy and the node is skipped. */
	plans: once(loadPlans, { until: "1h" }),
	/** `<InfiniteScroll data="posts">` grows this one. */
	posts: scroll(listPosts),
	/** A second scroll prop, on its own query parameter. */
	activity: scroll(listActivity, { pageName: "activity" }),
});

export default workflow(
	"dashboard",
	{ version: "1.0.0", trigger: http.get("/", { middleware: ["inertia.shared"] }) },
	(req) => {
		Dashboard.render(req, "page", "/", {
			orders: { userId: shared(currentUser, "auth").id },
			stats: { since: "2026-01-01" },
			notifications: { page: req.query.page },
			posts: { page: req.query.page },
			activity: { cursor: req.query.activity },
		});
	},
);
