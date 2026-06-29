import { describe, expect, it } from "vitest";
import { generateSharedNodesFile } from "../../../src/commands/create/project";

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
