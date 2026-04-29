/**
 * VarsContext — accumulated step outputs for a single workflow run.
 *
 * **Legacy alias for {@link StateContext}.** The two types describe the
 * same underlying object (`ctx.state` and `ctx.vars` are aliases). v2
 * code should prefer `ctx.state` / `StateContext`.
 *
 * Values can be any JSON-serializable shape — a step's output is whatever
 * its node returned. The strict `ParamsDictionary` shape from earlier
 * versions of Blok was inaccurate; real workflows have always stored
 * arbitrary objects, arrays, primitives, etc. here.
 *
 * @deprecated Prefer {@link StateContext}.
 */
type VarsContext = {
	[key: string]: unknown;
};

export default VarsContext;
