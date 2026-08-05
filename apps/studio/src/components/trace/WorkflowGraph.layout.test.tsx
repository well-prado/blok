import { describe, expect, it } from "vitest";
import { layoutDag } from "./WorkflowGraph";

// Regression: dagre 0.8.5 NaNs the x-coordinate pass when any edge has
// weight 0. Back-edges (forEach/loop returns) used weight 0 to stay out of
// ranking, which silently broke layout for every workflow containing a
// forEach/loop — all nodes rendered stacked at the origin. Back-edges are
// now excluded from the dagre graph entirely.
describe("layoutDag with back-edges", () => {
	it("assigns finite positions to a forEach workflow", () => {
		const def = {
			name: "loop-layout",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/loop-layout" } },
			steps: [
				{ id: "prep", use: "@blokjs/expr", type: "module", inputs: { expression: "1" } },
				{
					id: "each",
					forEach: {
						in: "js/ctx.state.prep",
						as: "item",
						do: [{ id: "inner", use: "@blokjs/expr", type: "module", inputs: { expression: "2" } }],
					},
				},
				{ id: "done", use: "@blokjs/expr", type: "module", inputs: { expression: "3" } },
			],
		};
		const { nodes, edges } = layoutDag(def);
		expect(nodes.length).toBeGreaterThan(3);
		expect(edges.some((e) => e.type === "default")).toBe(true); // back-edge still rendered
		const broken = nodes.filter((n) => !Number.isFinite(n.position.x) || !Number.isFinite(n.position.y));
		expect(broken.map((n) => ({ id: n.id, ...n.position }))).toEqual([]);
	});
});
