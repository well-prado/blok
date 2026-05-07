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

	describe("legacy set_var: false (back-compat)", () => {
		it("treats set_var: false as ephemeral", () => {
			const c = ctx({ existing: "keep" });
			applyStepOutput(c, { name: "step", set_var: false }, { data: { ignored: true } });
			expect(c.state).toEqual({ existing: "keep" });
		});

		it("set_var: true is a no-op (default already persists)", () => {
			const c = ctx();
			applyStepOutput(c, { name: "step", set_var: true }, { data: { kept: true } });
			expect(c.state).toEqual({ step: { kept: true } });
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
});
