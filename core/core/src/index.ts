/**
 * @blokjs/core — the published author import surface for Blok's typed-handle DSL.
 *
 * The `.` entry is the LIGHT authoring surface. It re-exports from
 * `@blokjs/runner/dsl` (not the `@blokjs/runner` barrel), so
 * `import { workflow } from "@blokjs/core"` never evaluates the runner's
 * grpc/otel/sqlite graph — only the clean DSL modules. The full engine and
 * test utilities live at the heavier sibling subpaths:
 *
 *   import { workflow, step, branch, http, tpl, gt } from "@blokjs/core";        // authoring (light)
 *   import { Runner, Configuration, TriggerBase }   from "@blokjs/core/runtime"; // engine (heavy)
 *   import { NodeTestHarness, WorkflowTestRunner }  from "@blokjs/core/testing";
 */

// Callback-style `workflow()` — the new DSL surface (runner exports it as
// `workflowCallback`; here it IS `workflow`).
export {
	workflowCallback as workflow,
	step,
	branch,
	forEach,
	switchOn,
	tryCatch,
	tpl,
	// Typed handle comparators (ADR 0003/0004)
	eq,
	ne,
	gt,
	gte,
	lt,
	lte,
	not,
	// Node authoring
	defineNode,
} from "@blokjs/runner/dsl";

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
} from "@blokjs/runner/dsl";

// The HTTP trigger-config helper — the design's `http.post("/orders")`.
export { http } from "./http";
export type { HttpTriggerBlock } from "./http";
