import { $, forEach, workflow } from "@blokjs/helper";

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
export default workflow({
	name: "eval.run",
	version: "1.0.0",
	description: "Eval harness — load, retrieve per item via subworkflow, score, aggregate",
	trigger: { http: { method: "POST", path: "/eval/run" } },
	steps: [
		{ id: "load", use: "eval-load-items", inputs: {} },
		forEach({
			id: "scoreItems",
			in: $.state.load.items,
			as: "item",
			mode: "sequential",
			do: [
				{
					id: "retrieve",
					subworkflow: "eval-retrieve",
					wait: true,
					inputs: { query: $.state.item.query },
				},
				{
					id: "normalize",
					use: "@blokjs/expr",
					inputs: {
						expression: "({ id: ctx.state.item.id, hitCount: (ctx.state.retrieve?.data?.hits || []).length })",
					},
				},
				{
					id: "score",
					use: "eval-score",
					inputs: { id: $.state.normalize.id, hitCount: $.state.normalize.hitCount },
				},
			],
		}),
		{
			id: "respond",
			use: "@blokjs/respond",
			inputs: { body: { results: $.state.scoreItems } },
			ephemeral: true,
		},
	],
});
