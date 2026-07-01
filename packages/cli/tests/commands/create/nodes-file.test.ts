import { describe, expect, it } from "vitest";
import { generateSharedNodesFile } from "../../../src/commands/create/project";
import { node_file } from "../../../src/commands/create/utils/Examples";

/**
 * Regression: a default `blokctl create project` (HTTP trigger, no --examples)
 * must register @blokjs/helpers in the generated src/Nodes.ts. `create workflow`
 * emits a step using `@blokjs/respond`, so without HELPER_NODES the freshly
 * scaffolded workflow 500s at runtime with "Node @blokjs/respond not found".
 * HELPER_NODES was previously only spread when sse/websocket was selected.
 */
describe("generateSharedNodesFile — HELPER_NODES is always registered", () => {
	it("registers HELPER_NODES for a plain HTTP scaffold (so @blokjs/respond et al. resolve)", () => {
		const out = generateSharedNodesFile(["http"], "");
		expect(out).toContain('import { HELPER_NODES } from "@blokjs/helpers";');
		expect(out).toContain("...(Object.values(HELPER_NODES) as unknown as NodeBase[])");
	});

	it("registers HELPER_NODES regardless of the trigger set (not just sse/websocket)", () => {
		for (const triggers of [["http"], ["worker"], ["cron"], ["pubsub"], ["sse"], ["websocket"], ["http", "worker"]]) {
			const out = generateSharedNodesFile(triggers, "");
			expect(out, `triggers=${triggers.join(",")}`).toContain("HELPER_NODES");
			expect(out, `triggers=${triggers.join(",")}`).toContain("Object.values(HELPER_NODES)");
		}
	});

	it("still registers the explicit published nodes + local auto-discovery", () => {
		const out = generateSharedNodesFile(["http"], "");
		expect(out).toContain('import ApiCall from "@blokjs/api-call";');
		expect(out).toContain('import IfElse from "@blokjs/if-else";');
		expect(out).toContain('await discoverNodes(join(here, "nodes"))');
	});
});

/**
 * Regression (#640): the `--examples` scaffold writes the static `node_file`
 * template verbatim. It must register HELPER_NODES so the example + SSE/WS/MCP
 * demo workflows resolve their helper-node deps (@blokjs/respond, sse-publish,
 * ws-reply, expr, …) instead of 500ing with "Node @blokjs/<name> not found".
 * The prior code tried to patch HELPER_NODES in via a string-replace that no
 * longer matched the refactored template — it imported HELPER_NODES but never
 * registered it, and would have double-imported once the template was fixed.
 */
describe("examples node_file template registers HELPER_NODES (#640)", () => {
	it("imports HELPER_NODES exactly once (no duplicate import from the removed patch)", () => {
		const importLines = node_file.split("\n").filter((l) => l.includes('from "@blokjs/helpers"'));
		expect(importLines).toEqual(['import { HELPER_NODES } from "@blokjs/helpers";']);
	});

	it("spreads Object.values(HELPER_NODES) into the registered set", () => {
		expect(node_file).toContain("...(Object.values(HELPER_NODES) as unknown as NodeBase[])");
	});

	it("still registers api-call, if-else, and the example bundle", () => {
		expect(node_file).toContain('import ApiCall from "@blokjs/api-call";');
		expect(node_file).toContain('import IfElse from "@blokjs/if-else";');
		expect(node_file).toContain('import ExampleNodes from "./nodes/examples/index";');
	});
});
