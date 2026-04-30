import type { HelperResponse, WorkflowV2Builder } from "@blokjs/helper";
import type NodeMap from "../NodeMap";

type GlobalOptions = {
	nodes: NodeMap;
	workflows: WorkflowLocator;
};

/**
 * A workflow locator entry — either a legacy v1 `HelperResponse` from
 * `Workflow().addTrigger()...` or a v2 `WorkflowV2Builder` from the
 * lowercase `workflow({...})` factory. Both expose a `_config` field
 * and a `.toJson()` method, which is the contract LocalStorage's
 * fallback path consumes.
 */
type WorkflowLocator = { [key: string]: HelperResponse | WorkflowV2Builder };

export default GlobalOptions;
export type { WorkflowLocator };
