/** `POST /login` — sets the session cookie and redirects to the intended page. */
import { http, type Handle, step, workflow } from "@blokjs/core";
import { logIn } from "#app/nodes/e2e/index";

export default workflow("e2e-login", { version: "1.0.0", trigger: http.post("/login") }, (req) => {
	const body = req.body as Handle<{ email: string; to?: string }>;
	step("login", logIn, { email: body.email, to: body.to });
});
