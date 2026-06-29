/**
 * @blokjs/core — the published author import surface for Blok's typed-handle DSL.
 *
 * The `.` entry is the ergonomic authoring surface: workflow DSL plus
 * `defineNode`. The strict workflow-only bundle boundary lives at `./dsl`,
 * which avoids the node execution graph entirely. The full engine and test
 * utilities live at the heavier sibling subpaths:
 *
 *   import { workflow, step, branch, http, tpl, gt } from "@blokjs/core";        // authoring (light)
 *   import { Runner, Configuration, TriggerBase }   from "@blokjs/core/runtime"; // engine (heavy)
 *   import { NodeTestHarness, WorkflowTestRunner }  from "@blokjs/core/testing";
 */

export {
	workflow,
	step,
	subworkflow,
	branch,
	forEach,
	switchOn,
	tryCatch,
	tpl,
	js,
	// Typed handle comparators (ADR 0003/0004)
	eq,
	ne,
	gt,
	gte,
	lt,
	lte,
	not,
	$,
	http,
} from "./dsl";

// Node authoring lives on the root authoring surface, but stays out of the
// pure `@blokjs/core/dsl` subpath so workflow-only bundles can tree-shake the
// node execution graph.
export { defineNode } from "@blokjs/runner/defineNode";

// Type-only foundation (handles + runtime stub). `runtimeNode` is a type-only
// declared signature in the runner, so it rides the type re-export.
export type {
	Handle,
	EphemeralHandle,
	ErrorHandle,
	Refable,
	RuntimeNode,
	runtimeNode,
	TriggerHandle,
	SubworkflowOptions,
} from "./dsl";
export type { HttpTriggerBlock } from "./http";
