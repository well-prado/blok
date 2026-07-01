import { http, node, step, workflow } from "@blokjs/core";
import type { Handle } from "@blokjs/core";

/**
 * Child workflow dispatched per-item by `eval.run`'s forEach. Mirrors the
 * tetrix-blok retrieval seam. The parent step's `inputs` become this
 * workflow's `ctx.request.body` (function-call semantics).
 *
 * Last step's output IS the workflow's response — so the parent reads it at
 * `ctx.state.retrieve.data` (the child's ResponseContext envelope).
 */
export default workflow(
	"eval.retrieve",
	{
		version: "1.0.0",
		description: "Eval harness — retrieve hits for one item's query",
		trigger: http.post("/eval/retrieve"),
	},
	(req) => {
		const body = req.body as Handle<{ query: string }>;
		step("search", node("eval-search"), { query: body.query });
	},
);
