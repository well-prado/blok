/**
 * @blokjs/core/dsl — the light authoring-only surface.
 *
 * This subpath intentionally avoids `defineNode`: node authoring currently
 * extends runner node classes, which pulls the node metrics shim. Workflow
 * authors who only need the DSL should get step-builder + helper proxy code,
 * not the runtime/node execution graph.
 */

export {
	workflowCallback as workflow,
	step,
	subworkflow,
	state,
	branch,
	forEach,
	switchOn,
	tryCatch,
	tpl,
	js,
	eq,
	ne,
	gt,
	gte,
	lt,
	lte,
	not,
} from "@blokjs/runner/stepBuilder";

export type { SubworkflowOptions, TriggerHandle } from "@blokjs/runner/stepBuilder";
export type { Handle, EphemeralHandle, ErrorHandle, Refable, RuntimeNode, ModuleNode } from "@blokjs/runner/handles";
// `runtimeNode` / `node` are REAL values — `step()` lowers them to runtime /
// module steps respectively (#424; node() = the typed-handle counterpart of a
// bare `use: "<name>"` string for published/named nodes).
export { runtimeNode, node } from "@blokjs/runner/handles";

export { $ } from "@blokjs/helper";
export { http } from "./http";
export type { HttpTriggerBlock } from "./http";
