import type { WorkflowV2Builder } from "@blokjs/helper";
import type NodeMap from "../NodeMap";

type GlobalOptions = {
	nodes: NodeMap;
	workflows: WorkflowLocator;
};

/**
 * A workflow locator entry — a `WorkflowV2Builder` from the `workflow({...})`
 * factory. Exposes a `_config` field and a `.toJson()` method, which is the
 * contract LocalStorage's fallback path consumes.
 */
type WorkflowLocator = { [key: string]: WorkflowV2Builder };

export default GlobalOptions;
export type { WorkflowLocator };
