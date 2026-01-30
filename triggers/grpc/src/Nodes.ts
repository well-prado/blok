import ApiCall from "@blok/api-call";
import IfElse from "@blok/if-else";
import type { NodeBase } from "@blok/shared";

const nodes: {
	[key: string]: NodeBase;
} = {
	"@blok/api-call": ApiCall,
	"@blok/if-else": IfElse,
};

export default nodes;
