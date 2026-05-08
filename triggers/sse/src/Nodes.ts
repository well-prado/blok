import ApiCall from "@blokjs/api-call";
import IfElse from "@blokjs/if-else";
import type { BlokService } from "@blokjs/runner";
import WelcomeMessage from "./nodes/welcome-message/index";

const nodes: Record<string, BlokService<unknown>> = {
	"@blokjs/api-call": ApiCall,
	"@blokjs/if-else": IfElse,
	"welcome-message": WelcomeMessage,
};

export default nodes;
