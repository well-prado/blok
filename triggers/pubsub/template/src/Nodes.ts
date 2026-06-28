import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ApiCall from "@blokjs/api-call";
import IfElse from "@blokjs/if-else";
import { discoverNodes } from "@blokjs/runner";
import type { NodeBase } from "@blokjs/shared";

// Published nodes (npm) are registered explicitly. Your OWN nodes under
// 'nodes/<name>/index.ts' are AUTO-DISCOVERED and registered by their
// defineNode({ name }) — you never edit this file to add a node.
const here = dirname(fileURLToPath(import.meta.url));
const local = await discoverNodes(join(here, "nodes"));

// Map keys are cosmetic — the runner registers each node under its own node.name.
const nodes: { [key: string]: NodeBase } = {};
for (const node of [ApiCall as unknown as NodeBase, IfElse as unknown as NodeBase, ...local]) {
	nodes[(node as { name: string }).name] = node;
}

export default nodes;
