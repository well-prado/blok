import ApiCall from "@blokjs/api-call";
import { HELPER_NODES } from "@blokjs/helpers";
import IfElse from "@blokjs/if-else";
import type { BlokService } from "@blokjs/runner";
import ChainInit from "./nodes/chain-init/index";
import ChainVerify from "./nodes/chain-verify/index";
import ExampleNodes from "./nodes/examples/index";
import RuntimeBridge from "./nodes/runtime-bridge/index";

const nodes: Record<string, BlokService<unknown>> = {
	"@blokjs/api-call": ApiCall,
	"@blokjs/if-else": IfElse,
	// v0.5 generic helpers: expr, ctx-publish, throw, log, audit-log,
	// in-memory-kv, json-schema, etc. Registered globally so any workflow
	// can use them via `use: "@blokjs/<name>"`.
	...(HELPER_NODES as unknown as Record<string, BlokService<unknown>>),
	"chain-init": ChainInit,
	"chain-verify": ChainVerify,
	"runtime-bridge": RuntimeBridge,
	...ExampleNodes,
};

export default nodes;
