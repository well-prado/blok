import type { Context } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { applyStepOutput } from "../../../src/workflow/PersistenceHelper";

function ctx(state: Record<string, unknown> = {}): Context {
	return { state } as unknown as Context;
}

describe("PersistenceHelper.applyStepOutput", () => {
	describe("default-store rule", () => {
		it("stores result.data at state[name]", () => {
			const c = ctx();
			applyStepOutput(c, { name: "fetch" }, { data: { id: 1, name: "Alice" } });
			expect(c.state).toEqual({ fetch: { id: 1, name: "Alice" } });
		});

		it("stores arrays as-is", () => {
			const c = ctx();
			applyStepOutput(c, { name: "list" }, { data: [1, 2, 3] });
			expect(c.state).toEqual({ list: [1, 2, 3] });
		});

		it("stores primitive data", () => {
			const c = ctx();
			applyStepOutput(c, { name: "n" }, { data: 42 });
			applyStepOutput(c, { name: "s" }, { data: "hello" });
			applyStepOutput(c, { name: "b" }, { data: true });
			expect(c.state).toEqual({ n: 42, s: "hello", b: true });
		});

		it("skips when data is undefined", () => {
			const c = ctx({ existing: "keep" });
			applyStepOutput(c, { name: "step" }, {});
			expect(c.state).toEqual({ existing: "keep" });
		});

		it("stores null data (null is a valid output)", () => {
			const c = ctx();
			applyStepOutput(c, { name: "step" }, { data: null });
			expect(c.state).toEqual({ step: null });
		});
	});

	describe("`as` alias", () => {
		it("stores at state[as] instead of state[name]", () => {
			const c = ctx();
			applyStepOutput(c, { name: "fetch-from-postgres", as: "users" }, { data: [1, 2] });
			expect(c.state).toEqual({ users: [1, 2] });
		});

		it("does not also store at state[name] when `as` is set", () => {
			const c = ctx();
			applyStepOutput(c, { name: "raw-step", as: "user" }, { data: { id: 1 } });
			expect(c.state).not.toHaveProperty("raw-step");
			expect(c.state).toEqual({ user: { id: 1 } });
		});
	});

	describe("`spread` flatten", () => {
		it("merges keys of result.data into state", () => {
			const c = ctx();
			applyStepOutput(c, { name: "load", spread: true }, { data: { user: { id: 1 }, profile: { bio: "..." } } });
			expect(c.state).toEqual({ user: { id: 1 }, profile: { bio: "..." } });
			expect(c.state).not.toHaveProperty("load");
		});

		it("preserves existing state keys when merging", () => {
			const c = ctx({ keep: "this" });
			applyStepOutput(c, { name: "load", spread: true }, { data: { add: "that" } });
			expect(c.state).toEqual({ keep: "this", add: "that" });
		});

		it("ignores non-object data silently", () => {
			const c = ctx();
			applyStepOutput(c, { name: "n", spread: true }, { data: 42 });
			applyStepOutput(c, { name: "a", spread: true }, { data: [1, 2, 3] });
			expect(c.state).toEqual({});
		});
	});

	describe("`ephemeral` opt-out", () => {
		it("skips persistence entirely", () => {
			const c = ctx({ existing: "keep" });
			applyStepOutput(c, { name: "log", ephemeral: true }, { data: { ignored: true } });
			expect(c.state).toEqual({ existing: "keep" });
		});
	});

	describe("defensive ctx.state init", () => {
		it("creates state when missing", () => {
			const c = { state: undefined } as unknown as Context;
			applyStepOutput(c, { name: "step" }, { data: 1 });
			expect(c.state).toEqual({ step: 1 });
		});

		it("creates state when not an object", () => {
			const c = { state: "garbage" } as unknown as Context;
			applyStepOutput(c, { name: "step" }, { data: 1 });
			expect(c.state).toEqual({ step: 1 });
		});
	});

	// Rule 0 — error guard. Errored steps must NOT write state. This is what
	// makes `ctx.state[<step.id>] !== undefined` a truthful "did this step
	// succeed?" check inside a tryCatch.catch arm. Three distinct error
	// indicators are accepted: `success: false`, a non-null `error`
	// (ResponseContext / BlokResponse shape), and a non-null `errors`
	// (ExecutionResult shape from runtime adapters). All three must skip
	// persistence equally.
	describe("error guard (Rule 0)", () => {
		it("skips when result.success === false", () => {
			const c = ctx({ existing: "keep" });
			applyStepOutput(c, { name: "step" }, { data: { kept: false }, success: false });
			expect(c.state).toEqual({ existing: "keep" });
		});

		it("skips when result.error is set (BlokResponse shape)", () => {
			const c = ctx({ existing: "keep" });
			applyStepOutput(c, { name: "step" }, { data: {}, error: new Error("kaboom") });
			expect(c.state).toEqual({ existing: "keep" });
		});

		it("skips when result.errors is set (ExecutionResult shape)", () => {
			const c = ctx({ existing: "keep" });
			applyStepOutput(c, { name: "step" }, { data: { partial: true }, errors: "runtime fail" });
			expect(c.state).toEqual({ existing: "keep" });
		});

		it("skips even when ephemeral was about to skip too (defense in depth)", () => {
			// Belt-and-braces: error guard must precede ephemeral check so
			// callers can't accidentally rely on ephemeral to mask a state
			// pollution bug.
			const c = ctx({ existing: "keep" });
			applyStepOutput(c, { name: "step", ephemeral: true }, { data: {}, error: new Error("kaboom") });
			expect(c.state).toEqual({ existing: "keep" });
		});

		it("skips with `as` alias on errored step (no spurious state[as] write)", () => {
			const c = ctx({ existing: "keep" });
			applyStepOutput(c, { name: "raw", as: "renamed" }, { data: { kept: false }, success: false });
			expect(c.state).toEqual({ existing: "keep" });
		});

		it("skips with `spread: true` on errored step (no spurious key merge)", () => {
			const c = ctx({ existing: "keep" });
			applyStepOutput(c, { name: "step", spread: true }, { data: { foo: 1, bar: 2 }, error: new Error("kaboom") });
			expect(c.state).toEqual({ existing: "keep" });
		});

		it("treats null error as success (errored only when error is non-null)", () => {
			const c = ctx();
			applyStepOutput(c, { name: "step" }, { data: { ok: true }, error: null });
			expect(c.state).toEqual({ step: { ok: true } });
		});

		it("treats null errors as success (ExecutionResult success path)", () => {
			const c = ctx();
			applyStepOutput(c, { name: "step" }, { data: { ok: true }, errors: null });
			expect(c.state).toEqual({ step: { ok: true } });
		});

		it("treats success: true with empty data as success (no-op via Rule 4)", () => {
			const c = ctx({ existing: "keep" });
			applyStepOutput(c, { name: "step" }, { success: true });
			// No write — data was undefined, but state is preserved.
			expect(c.state).toEqual({ existing: "keep" });
		});
	});
});
