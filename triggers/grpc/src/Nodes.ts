import ApiCall from "@blok/api-call";
import IfElse from "@blok/if-else";
import type { NodeBase } from "@blok/shared";

const nodes: {
	[key: string]: NodeBase;
} = {
	"@blok/api-call": new ApiCall(),
	"@blok/if-else": new IfElse(),
};

export default nodes;
