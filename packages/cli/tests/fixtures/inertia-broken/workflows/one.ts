import { http, workflow } from "@blokjs/core";
import { definePage } from "@blokjs/inertia";
import { whoami } from "../nodes.js";

export const One = definePage("Broken/One", { auth: whoami });

export default workflow("broken.one", { version: "1.0.0", trigger: http.get("/one") }, (req) => {
	One.render(req, "page", "/one", {});
});
