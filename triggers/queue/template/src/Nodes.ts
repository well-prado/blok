import ApiCall from "@blok/api-call";
import IfElse from "@blok/if-else";
import type { BlokService } from "@blok/runner";

const nodes: Record<string, BlokService<unknown>> = {
	"@blok/api-call": ApiCall,
	"@blok/if-else": IfElse,
};

export default nodes;
