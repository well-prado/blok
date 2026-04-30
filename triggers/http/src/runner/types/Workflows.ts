import type { HelperResponse, WorkflowV2Builder } from "@blokjs/helper";

/**
 * Manual workflow registry — maps workflow keys to their builder
 * instances. Accepts both legacy v1 builders (HelperResponse from
 * `Workflow().addTrigger()...`) and v2 builders (from the lowercase
 * `workflow({...})` factory). Both expose a `_config` field and a
 * `.toJson()` method, which is the contract `LocalStorage.get`'s
 * fallback path consumes.
 */
type Workflows = {
	[key: string]: HelperResponse | WorkflowV2Builder;
};

export default Workflows;
