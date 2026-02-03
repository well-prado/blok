import ApiCall from "@blokjs/api-call";
import IfElse from "@blokjs/if-else";
import type { BlokService } from "@blokjs/runner";

const nodes: Record<string, BlokService<unknown>> = {
	"@blokjs/api-call": ApiCall,
	"@blokjs/if-else": IfElse,
};

export default nodes;
