/**
 * Two pages, two named routes — the names are what `blokctl gen app-types`
 * turns into the frontend's typed `route("orders.show", { id })`.
 */

import { http, workflow } from "@blokjs/core";
import { always, definePage, shared } from "@blokjs/inertia";
import { currentUser, listOrders, showOrder } from "../nodes.js";

export const OrdersIndex = definePage("Orders/Index", {
	auth: always(currentUser),
	orders: listOrders,
});

export const OrdersShow = definePage("Orders/Show", {
	auth: always(currentUser),
	order: showOrder,
});

export const index = workflow(
	"orders.index",
	{ version: "1.0.0", trigger: http.get("/orders", { middleware: ["inertia.shared"] }) },
	(req) => {
		OrdersIndex.render(
			req,
			"page",
			"/orders",
			{
				orders: { userId: shared(currentUser, "auth").id },
			},
			{ viewData: { title: "Orders" } },
		);
	},
);

export default workflow(
	"orders.show",
	{ version: "1.0.0", trigger: http.get("/orders/:id", { middleware: ["inertia.shared"] }) },
	(req) => {
		OrdersShow.render(req, "page", "/orders", { order: { id: req.params.id } }, { viewData: { title: "Order" } });
	},
);
