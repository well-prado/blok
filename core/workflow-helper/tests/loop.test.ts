import { describe, expect, it } from "vitest";
import { $, gt, loop, lt, not } from "../src/index";
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

	it("turns a bare $ proxy while into a raw ctx truthiness check", () => {
		const step = loop({
			id: "poll",
			while: $.state.keepGoing,
			do: [{ id: "step1", use: "noop" }],
		});
		expect(step.loop.while).toBe("ctx.state.keepGoing");
	});

	it("accepts raw comparator and negated proxy while expressions", () => {
		expect(
			loop({
				id: "poll",
				while: lt($.state["poll-loopIndex"], 3),
				do: [{ id: "step1", use: "noop" }],
			}).loop.while,
		).toBe('ctx.state["poll-loopIndex"] < 3');

		expect(
			loop({
				id: "until-ready",
				while: not($.state.ready),
				do: [{ id: "step1", use: "noop" }],
			}).loop.while,
		).toBe("!(ctx.state.ready)");
	});

	it("keeps both handle operands raw in loop comparators", () => {
		const step = loop({
			id: "quota",
			while: gt($.state.used, $.state.limit),
			do: [{ id: "step1", use: "noop" }],
		});
		expect(step.loop.while).toBe("ctx.state.used > ctx.state.limit");
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
