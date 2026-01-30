import ApiCall from "@blok/api-call";
import IfElse from "@blok/if-else";
import type { NodeBase } from "@blok/shared";
import ChainInit from "./nodes/chain-init/index";
import ChainVerify from "./nodes/chain-verify/index";
import ExampleNodes from "./nodes/examples/index";
import RuntimeBridge from "./nodes/runtime-bridge/index";

const nodes: {
	[key: string]: NodeBase;
} = {
	"@blok/api-call": ApiCall,
	"@blok/if-else": IfElse,
	"chain-init": ChainInit,
	"chain-verify": ChainVerify,
	"runtime-bridge": RuntimeBridge,
	...ExampleNodes,
};

export default nodes;
