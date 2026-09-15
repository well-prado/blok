/**
 * `GET /dashboard` — the deferred/partial/polling page.
 *
 * Two deferred GROUPS (`default` carries the Python `stats`, `secondary`
 * carries the rescued `flaky` prop), so the client issues two parallel
 * follow-up requests (scenarios 8 and 26). Two `scroll()` props on distinct
 * page parameters keep their cursors apart (scenario 23), and `visible` is the
 * `optional()` prop `<WhenVisible>` fetches on scroll (scenario 39).
 */
import { http, workflow } from "@blokjs/core";
import { always, defer, definePage, once, optional, scroll } from "@blokjs/inertia";
import {
	currentUser,
	dashboardStats,
	flakyStats,
	listFeed,
	listOrders,
	listUsers,
	loadPlans,
	secondaryStats,
	whenVisible,
} from "#app/nodes/e2e/index";

export const Dashboard = definePage("Dashboard", {
	auth: always(currentUser),
	orders: listOrders,
	stats: defer(dashboardStats, { group: "default", rescue: true }),
	secondary: defer(secondaryStats, { group: "secondary" }),
	flaky: defer(flakyStats, { group: "secondary", rescue: true }),
	// The SAME once() prop Orders/Index declares. The client only announces a
	// cached once prop while the page it is leaving still carries it, so the
	// optimisation is only observable between two pages that share one.
	plans: once(loadPlans, { until: "1h" }),
	visible: optional(whenVisible),
	feed: scroll(listFeed, { pageName: "feed" }),
	users: scroll(listUsers, { pageName: "users" }),
});

export default workflow("e2e-dashboard", { version: "1.0.0", trigger: http.get("/dashboard") }, (req) => {
	Dashboard.render(
		req,
		"page",
		"/dashboard",
		{
			orders: { page: req.query.page },
			stats: { since: "2026-01-01" },
			flaky: { retry: req.query.retry },
			feed: { page: req.query.feed },
			users: { cursor: req.query.users },
		},
		{ viewData: { title: "Dashboard" } },
	);
});
