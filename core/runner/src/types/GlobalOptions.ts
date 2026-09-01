import type { WorkflowV2Builder } from "@blokjs/helper";
import type NodeMap from "../NodeMap";
import type { EnforcementSettings } from "../enforcement/EnforcementProfile";

type GlobalOptions = {
	nodes: NodeMap;
	workflows: WorkflowLocator;
	/** Trusted deployment/task metadata used to bind agent workflows. */
	enforcement?: EnforcementSettings;
};

/**
 * A workflow locator entry — a `WorkflowV2Builder` from the `workflow({...})`
 * factory. Exposes a `_config` field and a `.toJson()` method, which is the
 * contract LocalStorage's fallback path consumes.
 */
type WorkflowLocator = { [key: string]: WorkflowV2Builder };

export default GlobalOptions;
export type { WorkflowLocator };
