/** Throws while being imported — the generator must name this file and carry on. */
import { http, step, workflow } from "@blokjs/core";
import { whoami } from "../nodes.js";

export default workflow("broken.explodes", { version: "1.0.0", trigger: http.get("/explodes") }, () => {
	step("who", whoami, {});
});

// The failure this fixture exists for: a module-scope error at import time.
throw new Error("boom: this workflow module cannot be imported");
