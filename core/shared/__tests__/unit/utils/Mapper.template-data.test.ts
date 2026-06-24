/**
 * Bug 2 verification — the report claimed the mapper interpolates `${...}`
 * found inside DATA VALUES that flow between steps (e.g. a retrieved code
 * snippet containing `const u = `${path}/x``), throwing `path is not defined`.
 *
 * This proves that is NOT how the mapper behaves:
 *   1. A `js/ctx.state.x` reference returns the resolved value VERBATIM — the
 *      mapper does NOT re-walk that value looking for `${...}`. So data carried
 *      between steps via `$.state.x` / `js/ctx.state.x` is safe even when it
 *      contains a literal `${...}`.
 *   2. `${...}` interpolation only fires on AUTHORED input strings. On an
 *      unresolvable one it leaves the literal in place in warn (default) mode
 *      and only throws in strict mode — matching the code's own comment.
 *
 * Conclusion: the report's repro (`inputs: { value: "js/ctx.state.data" }`
 * where the data contains `${path}`) does not reproduce. Documented & closed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Context from "../../../src/types/Context";
import type ParamsDictionary from "../../../src/types/ParamsDictionary";
import mapper from "../../../src/utils/Mapper";
import { MapperResolutionError } from "../../../src/utils/MapperResolutionError";

function createMockContext(overrides: Partial<Context> = {}): Context {
	return {
		id: "test-id",
		workflow_name: "test-workflow",
		request: { body: {}, headers: {}, query: {}, params: {} },
		response: { data: null, error: null, success: true },
		error: { message: "" },
		logger: { log: vi.fn(), logLevel: vi.fn(), error: vi.fn() },
		config: {},
		func: {},
		vars: {},
		state: {},
		eventLogger: null,
		_PRIVATE_: null,
		...overrides,
	} as Context;
}

describe("Mapper — ${...} in data values flowing between steps (Bug 2)", () => {
	beforeEach(() => {
		process.env.BLOK_MAPPER_MODE = undefined;
	});
	afterEach(() => {
		process.env.BLOK_MAPPER_MODE = undefined;
	});

	it("does NOT re-interpolate ${...} found inside a js/-resolved value", () => {
		// Upstream step output landed in state.data; it contains a literal ${path}.
		const poison = { code: "const u = `${path}/x`", symbolName: "render" };
		const ctx = createMockContext({ state: { data: poison } } as Partial<Context>);

		const inputs: ParamsDictionary = { value: "js/ctx.state.data" } as unknown as ParamsDictionary;
		// Resolve the step's authored inputs the way blueprintMapper does.
		expect(() => mapper.replaceObjectStrings(inputs, ctx, {} as ParamsDictionary)).not.toThrow();
		// The value is returned verbatim — the inner ${path} is untouched.
		expect((inputs as Record<string, unknown>).value).toEqual(poison);
	});

	it("does NOT re-interpolate ${...} even in strict mode for js/-resolved values", () => {
		process.env.BLOK_MAPPER_MODE = "strict";
		const poison = { code: "x = `${path}`" };
		const ctx = createMockContext({ state: { data: poison } } as Partial<Context>);
		const inputs: ParamsDictionary = { value: "js/ctx.state.data" } as unknown as ParamsDictionary;
		expect(() => mapper.replaceObjectStrings(inputs, ctx, {} as ParamsDictionary)).not.toThrow();
		expect((inputs as Record<string, unknown>).value).toEqual(poison);
	});

	it("a LITERAL authored ${path} is left in place in warn mode — no throw", () => {
		process.env.BLOK_MAPPER_MODE = "warn";
		const ctx = createMockContext();
		const inputs: ParamsDictionary = { tmpl: "before-${path}-after" } as unknown as ParamsDictionary;
		expect(() => mapper.replaceObjectStrings(inputs, ctx, {} as ParamsDictionary)).not.toThrow();
		// Unresolved placeholder is preserved verbatim (matches the code comment).
		expect((inputs as Record<string, unknown>).tmpl).toBe("before-${path}-after");
	});

	it("a LITERAL authored ${path} throws ONLY in strict mode (documents the real trigger)", () => {
		process.env.BLOK_MAPPER_MODE = "strict";
		const ctx = createMockContext();
		const inputs: ParamsDictionary = { tmpl: "x-${path}" } as unknown as ParamsDictionary;
		expect(() => mapper.replaceObjectStrings(inputs, ctx, {} as ParamsDictionary)).toThrow(MapperResolutionError);
	});
});
