import { describe, expect, it } from "vitest";
import { isTryCatchStep, tryCatch } from "../src/index";

describe("tryCatch()", () => {
	it("returns a v0.5 tryCatch step shape", () => {
		const step = tryCatch({
			id: "saga",
			try: [{ id: "create", use: "user-create" }],
			catch: [{ id: "rollback", use: "user-delete" }],
		});
		expect(step).toMatchObject({
			id: "saga",
			tryCatch: {
				try: [{ id: "create", use: "user-create" }],
				catch: [{ id: "rollback", use: "user-delete" }],
			},
		});
		expect(isTryCatchStep(step)).toBe(true);
	});

	it("includes `finally` block when provided", () => {
		const step = tryCatch({
			id: "x",
			try: [{ id: "a", use: "x" }],
			catch: [{ id: "b", use: "y" }],
			finally: [{ id: "c", use: "@blokjs/metrics-emit", inputs: { event: "saga" } }],
		});
		expect(step.tryCatch.finally).toEqual([{ id: "c", use: "@blokjs/metrics-emit", inputs: { event: "saga" } }]);
	});

	it("omits `finally` from output when unset", () => {
		const step = tryCatch({
			id: "x",
			try: [{ id: "a", use: "x" }],
			catch: [{ id: "b", use: "y" }],
		});
		expect(step.tryCatch.finally).toBeUndefined();
	});

	it("hoists active:false and stop:true to top level", () => {
		const step = tryCatch({
			id: "x",
			try: [{ id: "a", use: "x" }],
			catch: [{ id: "b", use: "y" }],
			active: false,
			stop: true,
		});
		expect(step.active).toBe(false);
		expect(step.stop).toBe(true);
	});

	it("rejects missing id", () => {
		// @ts-expect-error — missing required id
		expect(() => tryCatch({ try: [{ id: "a" }], catch: [{ id: "b" }] })).toThrow(/non-empty `id`/);
	});

	it("rejects empty try", () => {
		expect(() => tryCatch({ id: "x", try: [], catch: [{ id: "b", use: "noop" }] })).toThrow(/`try`/);
	});

	it("rejects empty catch", () => {
		expect(() => tryCatch({ id: "x", try: [{ id: "a", use: "noop" }], catch: [] })).toThrow(/`catch`/);
	});

	it("rejects non-array finally when set", () => {
		expect(() =>
			tryCatch({
				id: "x",
				try: [{ id: "a", use: "noop" }],
				catch: [{ id: "b", use: "noop" }],
				// @ts-expect-error — finally must be array
				finally: "oops",
			}),
		).toThrow(/non-empty array/);
	});

	it("rejects empty finally array when set", () => {
		expect(() =>
			tryCatch({
				id: "x",
				try: [{ id: "a", use: "noop" }],
				catch: [{ id: "b", use: "noop" }],
				finally: [],
			}),
		).toThrow(/non-empty array/);
	});
});
