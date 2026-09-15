/** `GET /login` — the page `inertia.auth` redirects a guest to. */
import { http, workflow } from "@blokjs/core";
import { always, definePage } from "@blokjs/inertia";
import { currentUser } from "#app/nodes/e2e/index";

export const Login = definePage("Login", {
	auth: always(currentUser),
});

export default workflow("e2e-login-page", { version: "1.0.0", trigger: http.get("/login") }, (req) => {
	Login.render(req, "page", "/login", {}, { viewData: { title: "Login" } });
});
