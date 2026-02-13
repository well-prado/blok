import ApiCall from "@blokjs/api-call";
import IfElse from "@blokjs/if-else";
import type { BlokService } from "@blokjs/runner";
import ChainInit from "./nodes/chain-init/index";
import ChainVerify from "./nodes/chain-verify/index";
import ExampleNodes from "./nodes/examples/index";
import RuntimeBridge from "./nodes/runtime-bridge/index";

const nodes: Record<string, BlokService<unknown>> = {
	"@blokjs/api-call": ApiCall,
	"@blokjs/if-else": IfElse,
	"chain-init": ChainInit,
	"chain-verify": ChainVerify,
	"runtime-bridge": RuntimeBridge,
	...ExampleNodes,
};

export default nodes;
