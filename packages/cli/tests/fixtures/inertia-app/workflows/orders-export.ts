/** A workflow with no page — its route entry must carry no `component`. */
import { http, step, workflow } from "@blokjs/core";
import { exportOrders } from "../nodes.js";

export default workflow("orders.export", { version: "1.0.0", trigger: http.get("/orders/export") }, () => {
	step("export", exportOrders, {});
});
