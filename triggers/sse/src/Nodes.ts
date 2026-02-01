import ApiCall from "@blok/api-call";
import IfElse from "@blok/if-else";
import type { BlokService } from "@blok/runner";
import WelcomeMessage from "./nodes/welcome-message/index";

const nodes: Record<string, BlokService<unknown>> = {
	"@blok/api-call": ApiCall,
	"@blok/if-else": IfElse,
	"welcome-message": WelcomeMessage,
};

export default nodes;
