import type { Context } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import Configuration from "../src/Configuration";
import NodeMap from "../src/NodeMap";
import type RunnerNode from "../src/RunnerNode";
import { RuntimeRegistry } from "../src/RuntimeRegistry";
import { defineNode } from "../src/defineNode";
import type GlobalOptions from "../src/types/GlobalOptions";
import { createMockContext } from "../test/helpers/test-utils";

const portableNode = defineNode({
	name: "portable-runtime-fixture",
	input: z.object({ value: z.string() }),
	output: z.object({ value: z.string() }),
	execute: async (_ctx, input) => input,
});

class TestConfiguration extends Configuration {
	setNodes(nodes: NodeMap): void {
		this.globalOptions = { nodes } as GlobalOptions;
	}

	resolve(node: RunnerNode): Promise<RunnerNode> {
		return this.runtimeResolver(node);
	}
}

function context(): Context {
	return createMockContext({
		config: { run: { inputs: { value: "portable" } } },
	});
}

async function execute(kind: "nodejs" | "bun"): Promise<unknown> {
	const nodes = new NodeMap();
	nodes.addNode(portableNode.name, portableNode);
	const config = new TestConfiguration();
	config.setNodes(nodes);
	const step = {
		name: "run",
		node: portableNode.name,
		type: `runtime.${kind}`,
	} as RunnerNode;
	return (await config.resolve(step)).run(context());
}

describe("JavaScript runtime resolution", () => {
	beforeEach(() => RuntimeRegistry.getInstance().clear());
	afterEach(() => vi.unstubAllGlobals());

	it("executes a registered portable node through runtime.nodejs", async () => {
		await expect(execute("nodejs")).resolves.toMatchObject({ success: true, data: { value: "portable" } });
	});

	it("registers and executes runtime.bun only on a Bun host", async () => {
		vi.stubGlobal("Bun", {});
		await expect(execute("bun")).resolves.toMatchObject({ success: true, data: { value: "portable" } });
		expect(RuntimeRegistry.getInstance().has("nodejs")).toBe(false);
	});
});
