import { http, workflow } from "@blokjs/core";
import { always, definePage } from "@blokjs/inertia";
import { currentUser, listOrders } from "../nodes.js";

/** A CUSTOM shell, carrying both markers — what `blokctl inertia doctor` checks. */
const SHELL = "<!doctype html><html><head><!--blok:head--></head><body><!--blok:app--></body></html>";

export const Dashboard = definePage("Dashboard", {
	auth: always(currentUser),
	orders: listOrders,
});

export default workflow("dashboard", { version: "1.0.0", trigger: http.get("/") }, (req) => {
	Dashboard.render(req, "page", "/", {}, { shell: SHELL });
});
