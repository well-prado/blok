import { fileURLToPath } from "node:url";
import ApiCall from "@blokjs/api-call";
import { HELPER_NODES } from "@blokjs/helpers";
import IfElse from "@blokjs/if-else";
import { discoverNodes } from "@blokjs/runner";
import type { BlokService } from "@blokjs/runner";
import type { NodeBase } from "@blokjs/shared";

// THIRD-PARTY nodes are npm packages — not locally scannable, so they stay
// explicitly imported + registered here. Each is keyed by its own `node.name`
// (the canonical `use:` ref per ADR 0002); the map keys are cosmetic and the
// `NodeMap.addNode` collision guard catches two nodes claiming one ref.
const thirdParty: Record<string, BlokService<unknown>> = {
	"@blokjs/api-call": ApiCall,
	"@blokjs/if-else": IfElse,
	// v0.5 generic helpers: expr, ctx-publish, throw, log, audit-log,
	// in-memory-kv, json-schema, etc. Registered globally so any workflow
	// can use them via `use: "@blokjs/<name>"`.
	...(HELPER_NODES as unknown as Record<string, BlokService<unknown>>),
};

// LOCAL nodes live under `src/nodes/<name>/index.*` — discovered at module-eval
// (import = registration, #360/#349, ADR 0002) instead of hand-listed. The
// `eval/` and `examples/` bundles are map-export barrels, which `discoverNodes`
// flattens. Resolve the dir relative to THIS file so it's correct regardless of
// `process.cwd()` (tests, blokctl, deployed app all differ).
const localNodesDir = fileURLToPath(new URL("./nodes", import.meta.url));
const local = await discoverNodes(localNodesDir);

// One flat map keyed by `node.name` — the same shape `HttpTrigger.loadNodes()`
// + the HMR path consume via `Object.values(nodes)`, and the corpus the
// node-resolution-regression test loads.
const nodes: Record<string, BlokService<unknown>> = { ...thirdParty };
for (const node of local) {
	nodes[(node as NodeBase).name] = node as unknown as BlokService<unknown>;
}

export default nodes;
