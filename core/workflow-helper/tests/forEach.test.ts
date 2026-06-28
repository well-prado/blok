import { describe, expect, it } from "vitest";
import { forEach } from "../src/index";
import { isForEachStep } from "../src/internal";

describe("forEach()", () => {
	it("returns a v0.5 forEach step shape", () => {
		const step = forEach({
			id: "process",
			in: "$.req.body.items",
			as: "item",
			do: [{ id: "echo", use: "@blokjs/api-call", inputs: { url: "https://httpbin.org/post" } }],
		});
		expect(step).toMatchObject({
			id: "process",
			forEach: {
				in: "$.req.body.items",
				as: "item",
				do: [{ id: "echo", use: "@blokjs/api-call" }],
			},
		});
		expect(isForEachStep(step)).toBe(true);
	});

	it("preserves mode + concurrency when set", () => {
		const step = forEach({
			id: "x",
			in: "$.state.urls",
			as: "url",
			mode: "parallel",
			concurrency: 5,
			do: [{ id: "post", use: "@blokjs/api-call" }],
		});
		expect(step.forEach.mode).toBe("parallel");
		expect(step.forEach.concurrency).toBe(5);
	});

	it("omits mode + concurrency from output when unset", () => {
		const step = forEach({
			id: "x",
			in: "$.state.items",
			as: "item",
			do: [{ id: "x", use: "noop" }],
		});
		expect(step.forEach.mode).toBeUndefined();
		expect(step.forEach.concurrency).toBeUndefined();
	});

	it("hoists active:false to top level", () => {
		const step = forEach({
			id: "x",
			in: "$.state.items",
			as: "item",
			active: false,
			do: [{ id: "x", use: "noop" }],
		});
		expect(step.active).toBe(false);
	});

	it("hoists stop:true to top level", () => {
		const step = forEach({
			id: "x",
			in: "$.state.items",
			as: "item",
			stop: true,
			do: [{ id: "x", use: "noop" }],
		});
		expect(step.stop).toBe(true);
	});

	it("rejects missing id", () => {
		// @ts-expect-error — missing required id
		expect(() => forEach({ in: "$.x", as: "item", do: [{ id: "x" }] })).toThrow(/non-empty `id`/);
	});

	it("rejects missing in", () => {
		// @ts-expect-error — missing required in
		expect(() => forEach({ id: "x", as: "item", do: [{ id: "x" }] })).toThrow(/`in`/);
	});

	it("rejects missing as", () => {
		// @ts-expect-error — missing required as
		expect(() => forEach({ id: "x", in: "$.x", do: [{ id: "x" }] })).toThrow(/`as`/);
	});

	it("rejects invalid as identifier", () => {
		expect(() => forEach({ id: "x", in: "$.x", as: "1bad", do: [{ id: "x", use: "noop" }] })).toThrow(
			/valid JS identifier/,
		);
		expect(() => forEach({ id: "x", in: "$.x", as: "bad-name", do: [{ id: "x", use: "noop" }] })).toThrow(
			/valid JS identifier/,
		);
	});

	it("rejects an `as` name that collides with an inner step id", () => {
		expect(() => forEach({ id: "x", in: "$.x", as: "item", do: [{ id: "item", use: "noop" }] })).toThrow(
			/forEach state key "item".*collides with step id "item"/,
		);
	});

	it("rejects an `as + Index` name that collides with an inner step id", () => {
		expect(() => forEach({ id: "x", in: "$.x", as: "item", do: [{ id: "itemIndex", use: "noop" }] })).toThrow(
			/forEach state key "itemIndex".*collides with step id "itemIndex"/,
		);
	});

	it("rejects nested forEach aliases that collide with surrounding aliases", () => {
		expect(() =>
			forEach({
				id: "outer",
				in: "$.rows",
				as: "row",
				do: [
					forEach({
						id: "inner",
						in: "$.state.row.items",
						as: "row",
						do: [{ id: "read", use: "noop" }],
					}),
				],
			}),
		).toThrow(/forEach state key "row".*collides with surrounding forEach state key/);
	});

	it("rejects empty do", () => {
		expect(() => forEach({ id: "x", in: "$.x", as: "item", do: [] })).toThrow(/non-empty array/);
	});

	it("rejects non-integer concurrency", () => {
		expect(() => forEach({ id: "x", in: "$.x", as: "item", concurrency: 2.5, do: [{ id: "x", use: "noop" }] })).toThrow(
			/positive integer/,
		);
	});
});
