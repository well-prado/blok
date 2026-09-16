/** `POST /logout` — clears the session cookie AND the client's history state. */
import { http, step, workflow } from "@blokjs/core";
import { logOut } from "#app/nodes/e2e/index";

export default workflow("e2e-logout", { version: "1.0.0", trigger: http.post("/logout") }, () => {
	step("logout", logOut, {});
});
