import { http, forEach, node, step, subworkflow, workflow } from "@blokjs/core";

/**
 * Parent eval workflow — the tetrix-blok shape:
 *   load → forEach(item) { retrieve(subworkflow) → normalize → score } → respond
 *
 * Demonstrates the ONE correct context pattern:
 *   - every step's output auto-persists to `ctx.state[<id>]` on success
 *   - later steps read it via `$.state.<id>` (compiles to `js/ctx.state.<id>`)
 *   - inside a forEach, the per-iteration item is `ctx.state.item`
 *   - the subworkflow's response lands at `ctx.state.retrieve.data`
 *
 * This file is also the Bug 1 reproduction vehicle: a `subworkflow` step
 * nested inside a `forEach`, run in a process that ALSO has an unrelated
 * workflow (foreign.auth) carrying a `js/ctx.state.uid.userId` expression.
 */
export default workflow(
	"eval.run",
	{
		version: "1.0.0",
		description: "Eval harness — load, retrieve per item via subworkflow, score, aggregate",
		trigger: http.post("/eval/run"),
	},
	() => {
		const load = step("load", node<{ items: { query: string }[] }>("eval-load-items"), {});
		const scoreItems = forEach(
			load.items,
			(item) => {
				subworkflow("retrieve", "eval-retrieve", { query: item.query }, { wait: true });
				const normalize = step("normalize", node<{ id: unknown; hitCount: number }>("@blokjs/expr"), {
					expression: "({ id: ctx.state.item.id, hitCount: (ctx.state.retrieve?.data?.hits || []).length })",
				});
				step("score", node("eval-score"), { id: normalize.id, hitCount: normalize.hitCount });
			},
			{ as: "item", mode: "sequential" },
		);
		step("respond", node("@blokjs/respond"), { body: { results: scoreItems } }, { ephemeral: true });
	},
);
