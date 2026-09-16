/**
 * `GET /orders` — the list page.
 *
 * It deliberately declares NO `always` prop: scenario 9 asserts that
 * `router.reload({ only: ["orders"] })` comes back with exactly `orders` and
 * `errors`, and an always-prop (or a shared key named in `only`) would be a
 * third key on the wire.
 */
import { http, workflow } from "@blokjs/core";
import { definePage, merge, once, optional, scroll } from "@blokjs/inertia";
import { listFeed, listOrders, loadFilters, loadPlans } from "#app/nodes/e2e/index";

export const Orders = definePage("Orders/Index", {
	orders: merge(listOrders, { append: "data", matchOn: "id" }),
	filters: optional(loadFilters),
	plans: once(loadPlans, { until: "1h" }),
	feed: scroll(listFeed, { pageName: "feed" }),
});

export default workflow("e2e-orders", { version: "1.0.0", trigger: http.get("/orders") }, (req) => {
	Orders.render(
		req,
		"page",
		"/orders",
		{
			orders: { page: req.query.page, bump: req.query.bump },
			feed: { page: req.query.feed },
		},
		{ viewData: { title: "Orders" } },
	);
});
