import type { WorkflowV2Builder } from "@blokjs/helper";

/**
 * Manual workflow registry — maps workflow keys to their `WorkflowV2Builder`
 * instances (from the `workflow({...})` factory). Each exposes a `_config`
 * field and a `.toJson()` method, which is the contract `LocalStorage.get`'s
 * fallback path consumes.
 */
type Workflows = {
	[key: string]: WorkflowV2Builder;
};

export default Workflows;
