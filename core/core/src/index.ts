/**
 * @blokjs/core — the published author import surface for Blok's typed-handle DSL.
 *
 * Thin barrel: the authoring runtime lives in @blokjs/runner; this package
 * re-exports it under the names the design's headline example uses, plus the
 * one piece of new code — the `http` trigger-config helper (see ./http).
 *
 *   import { workflow, step, branch, http, tpl, gt } from "@blokjs/core";
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
} from "@blokjs/runner";

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
} from "@blokjs/runner";

// The HTTP trigger-config helper — the design's `http.post("/orders")`.
export { http } from "./http";
export type { HttpTriggerBlock } from "./http";
