import ApiCall from "@blokjs/api-call";
import IfElse from "@blokjs/if-else";
import type { NodeBase } from "@blokjs/shared";

const nodes: {
	[key: string]: NodeBase;
} = {
	"@blokjs/api-call": ApiCall,
	"@blokjs/if-else": IfElse,
};

export default nodes;
