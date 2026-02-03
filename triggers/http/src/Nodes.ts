import ApiCall from "@blokjs/api-call";
import IfElse from "@blokjs/if-else";
import type { NodeBase } from "@blokjs/shared";
import ChainInit from "./nodes/chain-init/index";
import ChainVerify from "./nodes/chain-verify/index";
import ExampleNodes from "./nodes/examples/index";
import RuntimeBridge from "./nodes/runtime-bridge/index";

const nodes: {
	[key: string]: NodeBase;
} = {
	"@blokjs/api-call": ApiCall,
	"@blokjs/if-else": IfElse,
	"chain-init": ChainInit,
	"chain-verify": ChainVerify,
	"runtime-bridge": RuntimeBridge,
	...ExampleNodes,
};

export default nodes;
