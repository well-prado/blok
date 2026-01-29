import ApiCall from "@nanoservice-ts/api-call";
import IfElse from "@nanoservice-ts/if-else";
import type { NodeBase } from "@nanoservice-ts/shared";
import ChainInit from "./nodes/chain-init/index";
import ChainVerify from "./nodes/chain-verify/index";
import RuntimeBridge from "./nodes/runtime-bridge/index";

const nodes: {
	[key: string]: NodeBase;
} = {
	"@nanoservice-ts/api-call": new ApiCall(),
	"@nanoservice-ts/if-else": new IfElse(),
	"chain-init": new ChainInit(),
	"chain-verify": new ChainVerify(),
	"runtime-bridge": new RuntimeBridge(),
};

export default nodes;
