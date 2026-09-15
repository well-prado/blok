/**
 * `GET /` — the conformance fixture's Home page.
 *
 * Scenario 19 (the typing gate) rewrites the `home:` key in THIS file and
 * expects the client's `tsc --noEmit` to fail, so the contract has to stay
 * declared here, outside the workflow callback.
 */
import { http, workflow } from "@blokjs/core";
import { always, definePage } from "@blokjs/inertia";
import { currentUser, homeCopy } from "#app/nodes/e2e/index";

export const Home = definePage("Home", {
	auth: always(currentUser),
	home: homeCopy,
});

export default workflow("e2e-home", { version: "1.0.0", trigger: http.get("/") }, (req) => {
	Home.render(req, "page", "/", {}, { viewData: { title: "Home" } });
});
