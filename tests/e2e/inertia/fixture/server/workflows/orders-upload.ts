/**
 * `PUT /orders/upload` — reached as a POST carrying `_method=PUT` (scenario 31).
 * The multipart parser (#1016) spools the file and the spoofing rewrites the
 * method, so this route only ever sees a PUT.
 */
import { http, type Handle, step, workflow } from "@blokjs/core";
import { uploadProof } from "#app/nodes/e2e/index";

export default workflow("e2e-orders-upload", { version: "1.0.0", trigger: http.put("/orders/upload") }, (req) => {
	const body = req.body as Handle<{ proof: unknown }>;
	step("upload", uploadProof, { proof: body.proof });
});
