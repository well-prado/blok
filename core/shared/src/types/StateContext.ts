/**
 * StateContext — accumulated step outputs for a single workflow run.
 *
 * Every step's `result.data` lands here under the step's `id` (or its
 * `as` override) automatically. Steps marked `ephemeral: true` skip
 * persistence; steps marked `spread: true` shallow-merge their result
 * keys into state.
 *
 * Read via `ctx.state[stepId]` or `$.state[stepId]` from a workflow's
 * `inputs`. Always initialized to `{}` at run start — never undefined.
 *
 * Aliased by `ctx.vars` for backward compatibility with v1 workflows.
 *
 * @example
 *   ctx.state["fetch-users"]   // the data returned by the fetch-users step
 *   ctx.state.user             // when a step has `as: "user"`
 */
type StateContext = {
	[key: string]: unknown;
};

export default StateContext;
