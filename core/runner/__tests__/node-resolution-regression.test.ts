/**
 * Regression net for the import-registration keying (#352, part of #349).
 *
 * The keying change registers every node under its OWN `node.name` (the
 * canonical `use:` ref per ADR 0002) instead of the cosmetic `Nodes.ts` map
 * key — see `HttpTrigger.loadNodes()`:
 *
 *   this.nodeMap.nodes = new NodeMap();
 *   this.nodeMap.nodes.addNodes(Object.values(nodes));   // keyed by node.name
 *
 * This test loads the EXACT corpus a deployed HTTP trigger ships
 * (`triggers/http/src/Nodes.ts` — which spreads in `HELPER_NODES` and
 * `ExampleNodes`), registers it through that same production path, and proves
 * every `use:` string an existing workflow references still resolves through
 * the REAL `Configuration.nodeResolver` → `moduleResolver`. If a future commit
 * makes any corpus node unresolvable under its current key, a row here fails.
 *
 * The 3 keying-divergence patterns the recon flagged are pinned by name so the
 * net visibly covers each shape (the informal node identity — import-var name,
 * source folder — can diverge arbitrarily from the registered key; what MUST
 * hold is `mapKey === node.name === what resolves`):
 *   (a) name == key                : "@blokjs/audit-log"
 *   (b) bare short name surfaces fully-qualified : "api-call" → "@blokjs/api-call"
 *   (c) arbitrary divergence       : folder base64-pdf / import Base64ToPDF → "base64-pdf";
 *                                     folder save-base64-image / import SaveImageBase64 → "save-image"
 */

import { HELPER_NODES } from "@blokjs/helpers";
import type { NodeBase } from "@blokjs/shared";
import { beforeAll, describe, expect, it } from "vitest";
// The corpus EXACTLY as a deployed HTTP trigger ships it — `Nodes.ts` already
// spreads `HELPER_NODES` and `ExampleNodes` in, so this is the single source of
// truth for what `use:` strings workflows may reference.
import corpus from "../../../triggers/http/src/Nodes.ts";
import ExampleNodes from "../../../triggers/http/src/nodes/examples/index.ts";
import Configuration from "../src/Configuration";
import NodeMap from "../src/NodeMap";
import type RunnerNode from "../src/RunnerNode";
import type GlobalOptions from "../src/types/GlobalOptions";

// Expose the protected resolver chain without re-implementing the dispatch.
// `nodeResolver` is the real entry that routes `type: "module"` →
// `moduleResolver` and `type: "runtime.*"` → `runtimeResolver`.
class TestConfiguration extends Configuration {
	public resolve(node: RunnerNode): Promise<RunnerNode> {
		return this.nodeResolver(node);
	}
}

const step = (use: string, type = "module"): RunnerNode => ({ node: use, name: use, type }) as unknown as RunnerNode;

describe("node-resolution regression net (#352)", () => {
	let config: TestConfiguration;
	const corpusKeys = Object.keys(corpus);

	beforeAll(() => {
		// Production registration path (HttpTrigger.loadNodes): register each
		// node under its OWN `node.name`, with the addNode collision guard.
		const nodes = new NodeMap();
		nodes.addNodes(Object.values(corpus) as unknown as NodeBase[]);
		config = new TestConfiguration();
		(config as unknown as { globalOptions: GlobalOptions }).globalOptions = {
			nodes,
		} as unknown as GlobalOptions;
	});

	it("registers a non-trivial corpus (guards against an empty/partial import)", () => {
		// 26 helper nodes + api-call + if-else + 3 local + 3 eval + 20 examples.
		expect(corpusKeys.length).toBeGreaterThanOrEqual(50);
		// Every HELPER_NODES key + every ExampleNodes name is present in the
		// shipped corpus — the spreads in Nodes.ts didn't silently drop any.
		for (const key of Object.keys(HELPER_NODES)) {
			expect(corpusKeys).toContain(key);
		}
		for (const node of Object.values(ExampleNodes) as Array<{ name?: string }>) {
			expect(corpusKeys).toContain(node.name);
		}
	});

	it.each(corpusKeys.map((key) => [key] as const))("resolves %s under its registered key", async (key) => {
		const resolved = await config.resolve(step(key));
		expect(resolved).toBeDefined();
		// `moduleResolver` stamps the step ref back onto the clone.
		expect((resolved as RunnerNode).node).toBe(key);
	});

	// The corpus loop already covers each of these — pinned individually so the
	// net's intent (each divergence shape resolves) is legible and a deletion of
	// any one example fails loudly here, not just as a missing row above.
	describe("keying-divergence patterns resolve", () => {
		it("(a) name == key  →  @blokjs/audit-log", async () => {
			const r = await config.resolve(step("@blokjs/audit-log"));
			expect((r as RunnerNode).node).toBe("@blokjs/audit-log");
		});

		it("(b) bare short name surfaces fully-qualified  →  @blokjs/api-call", async () => {
			const r = await config.resolve(step("@blokjs/api-call"));
			expect((r as RunnerNode).node).toBe("@blokjs/api-call");
			// The bare "api-call" is NOT a registry key — only the qualified ref.
			await expect(config.resolve(step("api-call"))).rejects.toThrow(/Node api-call not found/);
		});

		it("(c) arbitrary divergence  →  base64-pdf and save-image", async () => {
			// folder base64-pdf / import Base64ToPDF, folder save-base64-image / import SaveImageBase64.
			const pdf = await config.resolve(step("base64-pdf"));
			expect((pdf as RunnerNode).node).toBe("base64-pdf");
			const img = await config.resolve(step("save-image"));
			expect((img as RunnerNode).node).toBe("save-image");
		});
	});

	it("THROWS on a non-existent key (negative)", async () => {
		await expect(config.resolve(step("@blokjs/does-not-exist"))).rejects.toThrow(
			/Node @blokjs\/does-not-exist not found/,
		);
	});

	it("leaves a runtime.* ref alone (not routed through the module registry)", async () => {
		// A `runtime.go` ref must NOT hit `moduleResolver` — even though no Go
		// sidecar is up, resolution itself succeeds (it builds a RuntimeAdapterNode
		// stub), proving the dispatch bypasses the in-process node map entirely.
		const resolved = await config.resolve(step("some-go-node", "runtime.go"));
		expect(resolved).toBeDefined();
		expect((resolved as RunnerNode).type).toBe("runtime.go");
	});
});
