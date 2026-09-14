/**
 * @blokjs/core/testing — node + workflow test harnesses.
 *
 * Re-exports the testing utilities (NodeTestHarness, WorkflowTestRunner) from
 * `@blokjs/runner/testing` so tests can import them from the same `@blokjs/core`
 * package they author against.
 */
export * from "@blokjs/runner/testing";

// --- Inertia page workflows (#1002) ------------------------------------------
// Lives here, not in @blokjs/runner/testing: it is authored against the page
// contract `@blokjs/inertia` builds on top of `@blokjs/core`, and the runner
// must not know about the Inertia protocol.
export { runPage, runPrecognition } from "./testing-page.js";
export type {
	AssertablePage,
	AssertableRedirect,
	PageResult,
	PageScope,
	PrecognitionResult,
	RunPageOptions,
	RunPrecognitionOptions,
} from "./testing-page.js";
