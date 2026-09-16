/**
 * The suite's control surface. Every route here is an ORDINARY workflow with a
 * real side effect — the adapter carries no test hooks.
 *
 * Only `bumpVersion` is the default export (the TS scanner routes a file's
 * default export only); the rest are registered by name in `src/Workflows.ts`.
 */
import { http, step, workflow } from "@blokjs/core";
import { boom, bumpVersion, externalRedirect, fragmentRedirect, pythonCalls } from "#app/nodes/e2e/index";

/** Publish a new asset version, exactly as a redeploy does (scenarios 10, 42). */
export default workflow("e2e-bump-version", { version: "1.0.0", trigger: http.post("/__e2e/bump-version") }, () => {
	step("bump", bumpVersion, {});
});

/** How many times the Python node actually ran (scenario 8's server-side assertion). */
export const pythonCallsWorkflow = workflow(
	"e2e-python-calls",
	{ version: "1.0.0", trigger: http.get("/__e2e/python-calls") },
	() => {
		step("calls", pythonCalls, {});
	},
);

/** A thrown step: the production error page, or the dev error modal (scenario 34). */
export const errorWorkflow = workflow("e2e-error", { version: "1.0.0", trigger: http.get("/__e2e/error") }, () => {
	step("boom", boom, {});
});

/** 409 + `X-Inertia-Location`: the browser leaves the app (scenario 35). */
export const externalWorkflow = workflow(
	"e2e-external",
	{ version: "1.0.0", trigger: http.get("/__e2e/external") },
	() => {
		step("external", externalRedirect, {});
	},
);

/** 409 + `X-Inertia-Redirect`: land on `/orders#c` with the fragment (scenario 35). */
export const fragmentWorkflow = workflow(
	"e2e-fragment",
	{ version: "1.0.0", trigger: http.get("/__e2e/fragment") },
	() => {
		step("fragment", fragmentRedirect, {});
	},
);
