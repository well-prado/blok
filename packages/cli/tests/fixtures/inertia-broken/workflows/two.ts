import { http, workflow } from "@blokjs/core";
import { definePage } from "@blokjs/inertia";
import { whoami } from "../nodes.js";

export const Two = definePage("Broken/Two", { auth: whoami });

export default workflow("broken.two", { version: "1.0.0", trigger: http.get("/two") }, (req) => {
	Two.render(req, "page", "/two", {});
});
