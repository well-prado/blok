import { describe, expect, it } from "vitest";
import { loop } from "../src/index";
import { isLoopStep } from "../src/internal";

describe("loop()", () => {
	it("returns a v0.5 loop step shape", () => {
		const step = loop({
			id: "poll",
			while: '$.state.status !== "done"',
			do: [
				{ id: "wait", wait: { for: "1s" } },
				{ id: "check", use: "api-call" },
			],
		});
		expect(step).toMatchObject({
			id: "poll",
			loop: {
				while: '$.state.status !== "done"',
				do: [{ id: "wait" }, { id: "check" }],
			},
		});
		expect(isLoopStep(step)).toBe(true);
	});

	it("preserves maxIterations when set", () => {
		const step = loop({
			id: "x",
			while: "$.state.x < 5",
			maxIterations: 5,
			do: [{ id: "step1", use: "noop" }],
		});
		expect(step.loop.maxIterations).toBe(5);
	});

	it("omits maxIterations from output when unset", () => {
		const step = loop({
			id: "x",
			while: "true",
			do: [{ id: "step1", use: "noop" }],
		});
		expect(step.loop.maxIterations).toBeUndefined();
	});

	it("hoists active:false + stop:true to top level", () => {
		const step = loop({
			id: "x",
			while: "true",
			active: false,
			stop: true,
			do: [{ id: "step1", use: "noop" }],
		});
		expect(step.active).toBe(false);
		expect(step.stop).toBe(true);
	});

	it("rejects missing id", () => {
		// @ts-expect-error — missing required id
		expect(() => loop({ while: "true", do: [{ id: "x" }] })).toThrow(/non-empty `id`/);
	});

	it("rejects missing while", () => {
		// @ts-expect-error — missing required while
		expect(() => loop({ id: "x", do: [{ id: "x" }] })).toThrow(/while/);
	});

	it("rejects empty while string", () => {
		expect(() => loop({ id: "x", while: "", do: [{ id: "x", use: "noop" }] })).toThrow(/non-empty/);
	});

	it("rejects empty do", () => {
		expect(() => loop({ id: "x", while: "true", do: [] })).toThrow(/non-empty array/);
	});

	it("rejects non-integer maxIterations", () => {
		expect(() => loop({ id: "x", while: "true", maxIterations: 1.5, do: [{ id: "x", use: "noop" }] })).toThrow(
			/positive integer/,
		);
	});
});
