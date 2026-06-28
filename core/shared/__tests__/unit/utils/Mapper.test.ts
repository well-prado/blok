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
		eventLogger: null,
		_PRIVATE_: null,
		...overrides,
	} as Context;
}

/**
 * Test helper — set the resolution mode for the duration of one test.
 * Resets to the default (`"strict"` — fail-fast) after each case.
 */
function setMode(mode: "warn" | "strict" | "silent"): void {
	process.env.BLOK_MAPPER_MODE = mode;
}

describe("Mapper", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// Reset to the default. Assigning undefined makes process.env.X read
		// back as the string "undefined" in Node; readMode() treats anything
		// that isn't "warn"/"silent" as the default — now "strict" (fail-fast).
		process.env.BLOK_MAPPER_MODE = undefined;
	});

	afterEach(() => {
		process.env.BLOK_MAPPER_MODE = undefined;
	});

	// =========================================================================
	// Pre-existing behavior — replaceString happy paths (preserved across rewrite)
	// =========================================================================

	describe("replaceString() — happy paths", () => {
		it("replaces ${key} with data value", () => {
			const ctx = createMockContext();
			const data = { name: "John" };
			const result = mapper.replaceString("Hello ${name}", ctx, data);
			expect(result).toBe("Hello John");
		});

		it("replaces multiple placeholders", () => {
			const ctx = createMockContext();
			const data = { first: "John", last: "Doe" };
			const result = mapper.replaceString("${first} ${last}", ctx, data);
			expect(result).toBe("John Doe");
		});

		it("handles nested data access via lodash.get", () => {
			const ctx = createMockContext();
			const data = { user: { name: "Alice" } };
			const result = mapper.replaceString("Hi ${user.name}", ctx, data as unknown as ParamsDictionary);
			expect(result).toBe("Hi Alice");
		});

		it("handles no matches (no ${})", () => {
			const ctx = createMockContext();
			const result = mapper.replaceString("plain text", ctx, {});
			expect(result).toBe("plain text");
		});

		it("executes js/ prefix expressions", () => {
			const ctx = createMockContext();
			const result = mapper.replaceString("js/1 + 2", ctx, {});
			expect(result).toBe(3);
		});

		it("passes through non-js strings", () => {
			const ctx = createMockContext();
			const result = mapper.replaceString("hello world", ctx, {});
			expect(result).toBe("hello world");
		});
	});

	// =========================================================================
	// Bug fixes shipped with the rewrite (v0.3.x)
	// =========================================================================

	describe("replaceString() — bug fixes (v0.3.x)", () => {
		it("preserves falsy-but-valid lookup values (was: || fell through to runJs)", () => {
			const ctx = createMockContext();
			// Pre-v0.3.x: `_.get(data, key) || runJs(key)` — when lookup
			// returned 0, the `||` fell through to runJs (which would throw
			// for "count" not being in scope). Now `=== undefined` check
			// preserves the 0.
			expect(mapper.replaceString("${count}", ctx, { count: 0 } as unknown as ParamsDictionary)).toBe("0");
			expect(mapper.replaceString("${flag}", ctx, { flag: false } as unknown as ParamsDictionary)).toBe("false");
			expect(mapper.replaceString("${empty}", ctx, { empty: "" } as unknown as ParamsDictionary)).toBe("");
		});

		it("JSON-encodes object values in interpolation (was: '[object Object]')", () => {
			const ctx = createMockContext();
			const data = { user: { id: 1, name: "Alice" } };
			const result = mapper.replaceString("payload=${user}", ctx, data as unknown as ParamsDictionary);
			// Pre-v0.3.x: `value as string` → "[object Object]". Now JSON.
			expect(result).toBe('payload={"id":1,"name":"Alice"}');
		});

		it("renders null/undefined interpolation values as empty string", () => {
			const ctx = createMockContext();
			const result = mapper.replaceString("v=${x}", ctx, { x: null } as unknown as ParamsDictionary);
			expect(result).toBe("v=");
		});

		it("strips only the `js/` prefix (slice(3) vs replace('js/', ''))", () => {
			const ctx = createMockContext();
			// A fabricated edge case — an expression that contains the
			// substring "js/" later. Pre-v0.3.x's `replace("js/", "")`
			// would strip the wrong occurrence and break the eval.
			// (The expression here evaluates safely; we just check
			// the prefix-stripping doesn't double-strip.)
			const result = mapper.replaceString('js/"prefix:" + "js/inside"', ctx, {});
			expect(result).toBe("prefix:js/inside");
		});

		it("provides symmetric scope (func + vars) inside ${...} expressions", () => {
			// Pre-v0.3.x: `${func.X}` threw because runJs was called with
			// only 3 args. Now func/vars are bound in both syntaxes for
			// consistency with `js/...`.
			const ctx = createMockContext({ vars: { count: 7 } });
			const result = mapper.replaceString("${vars.count}", ctx, {});
			expect(result).toBe("7");
		});
	});

	// =========================================================================
	// Failure modes (BLOK_MAPPER_MODE)
	// =========================================================================

	describe('mode = "warn" — log + pass-through', () => {
		beforeEach(() => setMode("warn"));
		it("logs an actionable warning via ctx.logger.logLevel", () => {
			const logLevel = vi.fn();
			const ctx = createMockContext({
				logger: { log: vi.fn(), logLevel, error: vi.fn() } as unknown as Context["logger"],
				workflow_name: "wf-X",
			});
			(ctx as Record<string, unknown>)._stepInfo = { name: "step-Y" };

			const result = mapper.replaceString("js/ctx.req.body.bad.path", ctx, {});

			// Original literal passes through (back-compat).
			expect(result).toBe("js/ctx.req.body.bad.path");
			// Single warn call with the structured message.
			expect(logLevel).toHaveBeenCalledTimes(1);
			expect(logLevel.mock.calls[0][0]).toBe("warn");
			const message = logLevel.mock.calls[0][1] as string;
			expect(message).toContain('step "step-Y"');
			expect(message).toContain('workflow "wf-X"');
			expect(message).toContain("ctx.req.body.bad.path");
			expect(message).toContain("hint:");
			expect(message).toContain("BLOK_MAPPER_MODE=strict");
		});

		it("falls back to console.warn when ctx.logger has neither logLevel nor log", () => {
			const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
			// Logger object lacking logLevel + log methods.
			const ctx = createMockContext({
				logger: { error: vi.fn() } as unknown as Context["logger"],
			});
			mapper.replaceString("js/ctx.bad.access", ctx, {});
			expect(consoleWarn).toHaveBeenCalledTimes(1);
			expect(consoleWarn.mock.calls[0][0] as string).toContain("[blok][mapper]");
		});

		it("returns the literal placeholder for failed ${...} interpolation", () => {
			const ctx = createMockContext({
				logger: { log: vi.fn(), logLevel: vi.fn(), error: vi.fn() } as unknown as Context["logger"],
			});
			const result = mapper.replaceString("hi ${ctx.req.body.bad.path}", ctx, {});
			// Pre-v0.3.x also did this — we preserve the back-compat.
			expect(result).toBe("hi ${ctx.req.body.bad.path}");
		});
	});

	describe('mode = "strict" — throws MapperResolutionError', () => {
		it("throws on failed js/ expression with full context", () => {
			setMode("strict");
			const ctx = createMockContext({ workflow_name: "wf-strict" });
			(ctx as Record<string, unknown>)._stepInfo = { name: "step-A" };

			let thrown: unknown = null;
			try {
				mapper.replaceString("js/ctx.req.body.bad.path", ctx, {});
			} catch (e) {
				thrown = e;
			}
			expect(thrown).toBeInstanceOf(MapperResolutionError);
			const err = thrown as MapperResolutionError;
			expect(err.context.expression).toBe("ctx.req.body.bad.path");
			expect(err.context.syntax).toBe("js");
			expect(err.context.workflowName).toBe("wf-strict");
			expect(err.context.stepName).toBe("step-A");
			expect(err.context.cause).toBeInstanceOf(TypeError);
		});

		it("throws on failed ${...} expression", () => {
			setMode("strict");
			const ctx = createMockContext();
			expect(() => mapper.replaceString("${ctx.req.body.bad.path}", ctx, {})).toThrow(MapperResolutionError);
		});

		it("does NOT throw when expression resolves successfully", () => {
			setMode("strict");
			const ctx = createMockContext();
			expect(mapper.replaceString("js/1 + 2", ctx, {})).toBe(3);
			expect(mapper.replaceString("${name}", ctx, { name: "ok" } as unknown as ParamsDictionary)).toBe("ok");
		});
	});

	describe("default mode (BLOK_MAPPER_MODE unset) — fail-fast", () => {
		// beforeEach resets the env to unset, so these test the DEFAULT.
		it("throws on a failed js/ expression by default — no opt-in needed", () => {
			const ctx = createMockContext();
			expect(() => mapper.replaceString("js/ctx.req.body.bad.path", ctx, {})).toThrow(MapperResolutionError);
		});

		it("does NOT throw when the expression resolves successfully", () => {
			const ctx = createMockContext();
			expect(mapper.replaceString("js/1 + 2", ctx, {})).toBe(3);
		});
	});

	describe('mode = "silent" — full suppression (pre-v0.3.x behavior)', () => {
		it("does not log via ctx.logger", () => {
			setMode("silent");
			const logLevel = vi.fn();
			const log = vi.fn();
			const ctx = createMockContext({
				logger: { log, logLevel, error: vi.fn() } as unknown as Context["logger"],
			});
			const result = mapper.replaceString("js/ctx.req.body.bad.path", ctx, {});
			expect(result).toBe("js/ctx.req.body.bad.path");
			expect(logLevel).not.toHaveBeenCalled();
			expect(log).not.toHaveBeenCalled();
		});

		it("does not log via console.warn", () => {
			setMode("silent");
			const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const ctx = createMockContext({ logger: undefined as unknown as Context["logger"] });
			mapper.replaceString("js/ctx.bad", ctx, {});
			expect(consoleWarn).not.toHaveBeenCalled();
		});
	});

	// =========================================================================
	// MapperResolutionError diagnostic content
	// =========================================================================

	describe("MapperResolutionError — diagnostic message quality", () => {
		it("includes a hint for 'Cannot read properties of undefined' errors", () => {
			setMode("strict");
			const ctx = createMockContext();
			let thrown: MapperResolutionError | null = null;
			try {
				mapper.replaceString("js/ctx.req.body.deeply.nested.value", ctx, {});
			} catch (e) {
				thrown = e as MapperResolutionError;
			}
			expect(thrown?.message).toMatch(/hint: the path/);
			expect(thrown?.message).toMatch(/check the trigger payload/i);
		});

		it("includes a hint for ReferenceError ('not defined')", () => {
			setMode("strict");
			const ctx = createMockContext();
			let thrown: MapperResolutionError | null = null;
			try {
				mapper.replaceString("js/unknownIdentifier.foo", ctx, {});
			} catch (e) {
				thrown = e as MapperResolutionError;
			}
			expect(thrown?.message).toMatch(/`unknownIdentifier` is not in scope/);
			expect(thrown?.message).toMatch(/ctx, data, func, vars/);
		});

		it("includes a hint for syntax errors", () => {
			setMode("strict");
			const ctx = createMockContext();
			let thrown: MapperResolutionError | null = null;
			try {
				mapper.replaceString("js/ctx.req.body.+", ctx, {});
			} catch (e) {
				thrown = e as MapperResolutionError;
			}
			expect(thrown?.message).toMatch(/not valid JavaScript/);
		});

		it("works with `instanceof` after JSON round-trip preservation (Object.setPrototypeOf)", () => {
			setMode("strict");
			const ctx = createMockContext();
			let thrown: unknown = null;
			try {
				mapper.replaceString("js/ctx.req.body.x.y", ctx, {});
			} catch (e) {
				thrown = e;
			}
			expect(thrown instanceof MapperResolutionError).toBe(true);
			expect(thrown instanceof Error).toBe(true);
		});

		it("attaches Error.cause for native cause-chain support", () => {
			setMode("strict");
			const ctx = createMockContext();
			let thrown: MapperResolutionError | null = null;
			try {
				mapper.replaceString("js/ctx.req.body.x.y", ctx, {});
			} catch (e) {
				thrown = e as MapperResolutionError;
			}
			const e = thrown as Error & { cause?: unknown };
			expect(e.cause).toBeDefined();
			expect(e.cause).toBe(thrown?.context.cause);
		});
	});

	// =========================================================================
	// replaceObjectStrings — recursion + mutation contract
	// =========================================================================

	describe("replaceObjectStrings()", () => {
		it("replaces string values in flat object", () => {
			const ctx = createMockContext();
			const data = { greeting: "World" };
			const obj: Record<string, unknown> = { msg: "Hello ${greeting}" };
			mapper.replaceObjectStrings(obj as Record<string, string>, ctx, data);
			expect(obj.msg).toBe("Hello World");
		});

		it("recursively replaces nested objects", () => {
			const ctx = createMockContext();
			const data = { val: "replaced" };
			const obj: Record<string, unknown> = {
				level1: { level2: "value is ${val}" },
			};
			mapper.replaceObjectStrings(obj as Record<string, string>, ctx, data);
			expect((obj.level1 as Record<string, unknown>).level2).toBe("value is replaced");
		});

		it("skips non-string, non-object values (null, primitives untouched)", () => {
			const ctx = createMockContext();
			const obj: Record<string, unknown> = { num: 42, bool: true, str: "keep", nullish: null };
			mapper.replaceObjectStrings(obj as Record<string, string>, ctx, {});
			expect(obj.num).toBe(42);
			expect(obj.bool).toBe(true);
			expect(obj.str).toBe("keep");
			expect(obj.nullish).toBe(null);
		});

		it("preserves the actual resolved type when assigning back to the dictionary slot", () => {
			// `obj.count` ends up as the NUMBER 5, not the string "5",
			// because js/ expressions return their actual evaluated type.
			const ctx = createMockContext({ vars: { count: 5 } });
			const obj: Record<string, unknown> = { count: "js/ctx.vars.count" };
			mapper.replaceObjectStrings(obj as Record<string, string>, ctx, {});
			expect(obj.count).toBe(5);
			expect(typeof obj.count).toBe("number");
		});
	});

	// =========================================================================
	// jsMapper via replaceString
	// =========================================================================

	describe("jsMapper via replaceString", () => {
		it("accesses ctx in js/ expressions", () => {
			const ctx = createMockContext({ vars: { count: 5 } });
			const result = mapper.replaceString("js/ctx.vars.count", ctx, {});
			expect(result).toBe(5);
		});

		it("handles js/ errors in warn mode by passing through the literal", () => {
			setMode("warn");
			const ctx = createMockContext({
				logger: { log: vi.fn(), logLevel: vi.fn(), error: vi.fn() } as unknown as Context["logger"],
			});
			const result = mapper.replaceString('js/throw new Error("fail")', ctx, {});
			// In warn mode the original literal passes through (back-compat).
			expect(result).toBe('js/throw new Error("fail")');
		});

		it("returns the actual evaluated type (number, object, array) — not a string", () => {
			const ctx = createMockContext();
			expect(mapper.replaceString("js/[1, 2, 3]", ctx, {})).toEqual([1, 2, 3]);
			expect(mapper.replaceString('js/({hello: "world"})', ctx, {})).toEqual({ hello: "world" });
			expect(mapper.replaceString("js/true", ctx, {})).toBe(true);
		});

		it("caches compiled js/ expressions by source string", () => {
			const NativeFunction = globalThis.Function;
			const compiledBodies: string[] = [];
			vi.spyOn(globalThis, "Function").mockImplementation(((...args: string[]) => {
				const body = args.at(-1);
				if (typeof body === "string" && body.includes("cache426")) compiledBodies.push(body);
				return NativeFunction(...args);
			}) as unknown as FunctionConstructor);

			const input = {
				a: "js/ctx.state.cache426Same + 1",
				b: "js/ctx.state.cache426Same + 1",
				c: "js/ctx.state.cache426Different + 1",
				d: "js/`cache426Label=${ctx.state.cache426Same}`",
			};

			for (let i = 0; i < 12; i++) {
				const ctx = createMockContext({
					state: { cache426Same: i, cache426Different: i * 10 } as unknown as Context["state"],
				});
				const copy = { ...input };
				mapper.replaceObjectStrings(copy as Record<string, string>, ctx, {});
				expect(copy).toEqual({ a: i + 1, b: i + 1, c: i * 10 + 1, d: `cache426Label=${i}` });
			}

			expect(compiledBodies).toHaveLength(3);
		});
	});
});
