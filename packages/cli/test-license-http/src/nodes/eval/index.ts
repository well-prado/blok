/**
 * Eval-harness nodes — a faithful, minimal version of the tetrix-blok eval
 * pipeline (load → retrieve → normalize → score → aggregate). In-process
 * `defineNode`s so the harness runs on the HTTP trigger alone, but the shape
 * is identical to a `runtime.python3` retrieval setup.
 *
 * These nodes also serve as the canonical "correct context usage" example for
 * the docs: every node RETURNS its output and lets the runner persist it to
 * `ctx.state[<step-id>]`. None of them writes `ctx.state` directly.
 */

import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/** Returns the list of items to evaluate. Output lands at `ctx.state.<id>`. */
export const EvalLoadItems = defineNode({
	name: "eval-load-items",
	description: "Eval harness — produce the list of items to evaluate",
	input: z.object({}),
	output: z.object({
		items: z.array(z.object({ id: z.number(), query: z.string() })),
	}),
	async execute() {
		return {
			items: [
				{ id: 1, query: "how does context flow between steps" },
				{ id: 2, query: "what does ephemeral mean" },
				{ id: 3, query: "how do I share a value across arms" },
			],
		};
	},
});

/** Retrieval — given a query, return ranked hits. Pure, deterministic. */
export const EvalSearch = defineNode({
	name: "eval-search",
	description: "Eval harness — retrieve ranked hits for a query",
	input: z.object({ query: z.string() }),
	output: z.object({
		query: z.string(),
		hits: z.array(z.object({ doc: z.string(), rank: z.number() })),
	}),
	async execute(_ctx, input) {
		const hits = [0, 1, 2].map((i) => ({ doc: `${input.query} :: doc-${i}`, rank: i }));
		return { query: input.query, hits };
	},
});

/** Score a retrieved+normalized item. */
export const EvalScore = defineNode({
	name: "eval-score",
	description: "Eval harness — score normalized hits",
	input: z.object({
		id: z.number(),
		hitCount: z.number(),
	}),
	output: z.object({ id: z.number(), score: z.number() }),
	async execute(_ctx, input) {
		return { id: input.id, score: input.hitCount * 10 };
	},
});

const EvalNodes = {
	"eval-load-items": EvalLoadItems,
	"eval-search": EvalSearch,
	"eval-score": EvalScore,
};

export default EvalNodes;
