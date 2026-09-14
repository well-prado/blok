import { http, workflow } from "@blokjs/core";
import { always, definePage } from "@blokjs/inertia";
import { currentUser, listOrders } from "../nodes.js";

/** Missing `<!--blok:head-->`: `renderShell` would not throw, `head` would just vanish. */
const SHELL = "<!doctype html><html><head></head><body><!--blok:app--></body></html>";

/** A component the client's pages.json does not have. */
export const Dashboard = definePage("Dashboard/Missing", {
	auth: always(currentUser),
	orders: listOrders,
});

export default workflow("dashboard", { version: "1.0.0", trigger: http.get("/") }, (req) => {
	Dashboard.render(req, "page", "/", {}, { shell: SHELL });
});
