import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Context from "../../../src/types/Context";
import mapper from "../../../src/utils/Mapper";
import { MapperResolutionError } from "../../../src/utils/MapperResolutionError";
import { NamedMissingStateError } from "../../../src/utils/NamedMissingStateError";

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

function setMode(mode: "warn" | "strict" | "silent"): void {
	process.env.BLOK_MAPPER_MODE = mode;
}

describe("NamedMissingStateError", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		process.env.BLOK_MAPPER_MODE = undefined;
	});
	afterEach(() => {
		process.env.BLOK_MAPPER_MODE = undefined;
	});

	describe("class shape", () => {
		it("subclasses MapperResolutionError (instanceof both)", () => {
			const e = new NamedMissingStateError("msg", "doesNotExist", {
				expression: "ctx.state.doesNotExist.x",
				syntax: "js",
			});
			expect(e).toBeInstanceOf(NamedMissingStateError);
			expect(e).toBeInstanceOf(MapperResolutionError);
			expect(e).toBeInstanceOf(Error);
			expect(e.name).toBe("NamedMissingStateError");
			expect(e.missingStateId).toBe("doesNotExist");
		});
	});

	describe("strict mode — named, loud failure", () => {
		it("throws NamedMissingStateError naming the missing id AND the referencing step/workflow", () => {
			setMode("strict");
			const ctx = createMockContext({ workflow_name: "wf-orders", state: {} as Context["state"] });
			(ctx as Record<string, unknown>)._stepInfo = { name: "respond" };

			let thrown: unknown = null;
			try {
				mapper.replaceString("js/ctx.state.doesNotExist.field", ctx, {});
			} catch (e) {
				thrown = e;
			}
			expect(thrown).toBeInstanceOf(NamedMissingStateError);
			const err = thrown as NamedMissingStateError;
			expect(err.missingStateId).toBe("doesNotExist");
			expect(err.context.stepName).toBe("respond");
			expect(err.context.workflowName).toBe("wf-orders");
			// Message names the missing id, the step, and the workflow.
			expect(err.message).toContain("doesNotExist");
			expect(err.message).toContain('"respond"');
			expect(err.message).toContain('"wf-orders"');
			expect(err.message).toContain("never persisted");
		});

		it("names the id via the bare `state.<id>` form too (no ctx. prefix)", () => {
			setMode("strict");
			const ctx = createMockContext({ state: {} as Context["state"] });
			let thrown: unknown = null;
			try {
				mapper.replaceString("js/state.missing.value", ctx, {});
			} catch (e) {
				thrown = e;
			}
			expect(thrown).toBeInstanceOf(NamedMissingStateError);
			expect((thrown as NamedMissingStateError).missingStateId).toBe("missing");
		});

		it("names the id via the `vars` alias (vars points at state)", () => {
			setMode("strict");
			const ctx = createMockContext({ state: {} as Context["state"], vars: {} as Context["vars"] });
			let thrown: unknown = null;
			try {
				mapper.replaceString("js/ctx.vars.missing.value", ctx, {});
			} catch (e) {
				thrown = e;
			}
			expect(thrown).toBeInstanceOf(NamedMissingStateError);
			expect((thrown as NamedMissingStateError).missingStateId).toBe("missing");
		});

		it("works for ${...} template syntax too", () => {
			setMode("strict");
			const ctx = createMockContext({ state: {} as Context["state"] });
			let thrown: unknown = null;
			try {
				mapper.replaceString("${ctx.state.absent.x}", ctx, {});
			} catch (e) {
				thrown = e;
			}
			expect(thrown).toBeInstanceOf(NamedMissingStateError);
			expect((thrown as NamedMissingStateError).missingStateId).toBe("absent");
		});

		it("ref to a step that ran but ERRORED (no-op persist) is named correctly", () => {
			// An errored step never writes ctx.state[id] — same missing-state path.
			setMode("strict");
			const ctx = createMockContext({ state: { ok: { data: 1 } } as unknown as Context["state"] });
			let thrown: unknown = null;
			try {
				mapper.replaceString("js/ctx.state.erroredStep.data", ctx, {});
			} catch (e) {
				thrown = e;
			}
			expect(thrown).toBeInstanceOf(NamedMissingStateError);
			expect((thrown as NamedMissingStateError).missingStateId).toBe("erroredStep");
		});
	});

	describe("DOES NOT regress the success path — falsy-but-present still resolves", () => {
		it("a state slot holding 0 / false / '' resolves without throwing (strict)", () => {
			setMode("strict");
			const ctx = createMockContext({
				state: { zero: 0, no: false, empty: "" } as unknown as Context["state"],
			});
			expect(mapper.replaceString("js/ctx.state.zero", ctx, {})).toBe(0);
			expect(mapper.replaceString("js/ctx.state.no", ctx, {})).toBe(false);
			expect(mapper.replaceString("js/ctx.state.empty", ctx, {})).toBe("");
		});

		it("a present slot whose nested field is undefined resolves to undefined (NOT an error)", () => {
			// The slot exists; an optional nested field that is undefined is a
			// legitimate undefined, not a dangling ref. Reading it does not throw.
			setMode("strict");
			const ctx = createMockContext({
				state: { user: { name: "Alice" } } as unknown as Context["state"],
			});
			expect(mapper.replaceString("js/ctx.state.user.middleName", ctx, {})).toBeUndefined();
		});

		it("a present slot that holds null resolves to null (slot exists)", () => {
			setMode("strict");
			const ctx = createMockContext({ state: { maybe: null } as unknown as Context["state"] });
			expect(mapper.replaceString("js/ctx.state.maybe", ctx, {})).toBeNull();
		});
	});

	describe("nested-field failure on a PRESENT slot stays a generic MapperResolutionError", () => {
		it("does NOT upgrade to NamedMissingStateError when the root slot exists", () => {
			// ctx.state.user exists but user.profile is undefined → reading
			// user.profile.name throws. The state ROOT is present, so this is a
			// nested-access bug, not a dangling state ref. Generic error stands.
			setMode("strict");
			const ctx = createMockContext({
				state: { user: { name: "Alice" } } as unknown as Context["state"],
			});
			let thrown: unknown = null;
			try {
				mapper.replaceString("js/ctx.state.user.profile.name", ctx, {});
			} catch (e) {
				thrown = e;
			}
			expect(thrown).toBeInstanceOf(MapperResolutionError);
			expect(thrown).not.toBeInstanceOf(NamedMissingStateError);
		});

		it("a non-state failure (bad ctx.req path) stays a generic MapperResolutionError", () => {
			setMode("strict");
			const ctx = createMockContext({ state: {} as Context["state"] });
			let thrown: unknown = null;
			try {
				mapper.replaceString("js/ctx.req.body.deep.nested.value", ctx, {});
			} catch (e) {
				thrown = e;
			}
			expect(thrown).toBeInstanceOf(MapperResolutionError);
			expect(thrown).not.toBeInstanceOf(NamedMissingStateError);
		});
	});

	describe("warn / silent modes — unchanged routing (no throw)", () => {
		it("warn mode logs the named context and passes the literal through", () => {
			setMode("warn");
			const logLevel = vi.fn();
			const ctx = createMockContext({
				logger: { log: vi.fn(), logLevel, error: vi.fn() } as unknown as Context["logger"],
				workflow_name: "wf-warn",
				state: {} as Context["state"],
			});
			(ctx as Record<string, unknown>)._stepInfo = { name: "step-W" };

			const result = mapper.replaceString("js/ctx.state.gone.x", ctx, {});
			// Pass-through unchanged.
			expect(result).toBe("js/ctx.state.gone.x");
			expect(logLevel).toHaveBeenCalledTimes(1);
			const message = logLevel.mock.calls[0][1] as string;
			expect(message).toContain("gone");
			expect(message).toContain('"step-W"');
			expect(message).toContain('"wf-warn"');
		});

		it("silent mode neither logs nor throws", () => {
			setMode("silent");
			const logLevel = vi.fn();
			const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const ctx = createMockContext({
				logger: { log: vi.fn(), logLevel, error: vi.fn() } as unknown as Context["logger"],
				state: {} as Context["state"],
			});
			const result = mapper.replaceString("js/ctx.state.gone.x", ctx, {});
			expect(result).toBe("js/ctx.state.gone.x");
			expect(logLevel).not.toHaveBeenCalled();
			expect(consoleWarn).not.toHaveBeenCalled();
		});
	});

	describe("no state container — no fabricated named error", () => {
		it("falls back to a generic MapperResolutionError when ctx has no state object", () => {
			setMode("strict");
			// Hand-rolled ctx with no state/vars at all.
			const ctx = createMockContext({
				state: undefined as unknown as Context["state"],
				vars: undefined as unknown as Context["vars"],
			});
			let thrown: unknown = null;
			try {
				mapper.replaceString("js/ctx.state.whatever.x", ctx, {});
			} catch (e) {
				thrown = e;
			}
			// Still a resolution error, but not the named one (we can't prove the
			// slot is "missing" when there's no state container to inspect).
			expect(thrown).toBeInstanceOf(MapperResolutionError);
			expect(thrown).not.toBeInstanceOf(NamedMissingStateError);
		});
	});
});
