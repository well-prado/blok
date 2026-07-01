import { http, node, step, workflow } from "@blokjs/core";

/**
 * Unrelated workflow registered in the SAME process as `eval.run`. It carries
 * the exact `js/ctx.state.uid.userId` expression the bug report claims "leaks"
 * into the forEach of eval.run. If Bug 1 is real, running eval.run will fail
 * resolving THIS workflow's expression. If the registry/config is correctly
 * isolated per workflow, eval.run is unaffected and this resolves fine on its
 * own endpoint.
 */
export default workflow(
	"foreign.auth",
	{
		version: "1.0.0",
		description: "Unrelated workflow — owns the js/ctx.state.uid.userId expression",
		trigger: http.post("/foreign/auth"),
	},
	() => {
		step("uid", node("@blokjs/expr"), {
			expression: "({ userId: (ctx.req.body && ctx.req.body.id) || 'anon' })",
		});
		step("useUid", node("@blokjs/expr"), { expression: "js/ctx.state.uid.userId" });
	},
);
