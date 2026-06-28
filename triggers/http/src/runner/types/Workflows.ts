import type { WorkflowV2Builder } from "@blokjs/helper";

/**
 * Manual workflow registry — maps workflow keys to their `WorkflowV2Builder`
 * instances (from the object-style `workflow({...})` factory) or promises of
 * instances (from the callback-style `workflow("name", opts, build)` factory).
 * Once resolved, each exposes a `_config` field and a `.toJson()` method, which
 * is the contract `LocalStorage.get`'s fallback path consumes.
 */
type Workflows = {
	[key: string]: WorkflowV2Builder | Promise<WorkflowV2Builder>;
};

export default Workflows;
