/**
 * `GET /secret` — behind `inertia.auth`, and encrypted in the browser's history
 * state (scenarios 12, 13, 33).
 */
import { http, workflow } from "@blokjs/core";
import { always, definePage } from "@blokjs/inertia";
import { currentUser } from "#app/nodes/e2e/index";

export const Secret = definePage("Secret", {
	auth: always(currentUser),
});

export default workflow(
	"e2e-secret",
	{ version: "1.0.0", trigger: http.get("/secret", { middleware: ["inertia.auth"] }) },
	(req) => {
		Secret.render(req, "page", "/secret", {}, { viewData: { title: "Secret" }, encryptHistory: true });
	},
);
