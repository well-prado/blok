import { describe, expect, it } from "vitest";
import { type StructuredCondition, lowerCondition, parseCondition, stripJsPrefix } from "./branchCondition";

describe("stripJsPrefix", () => {
	it("strips a js/ prefix", () => {
		expect(stripJsPrefix("js/ctx.state.a")).toBe("ctx.state.a");
	});

	it("leaves unprefixed input alone", () => {
		expect(stripJsPrefix("ctx.state.a")).toBe("ctx.state.a");
		expect(stripJsPrefix('"active"')).toBe('"active"');
	});
});

describe("lowerCondition — ADR 0004 lowering table", () => {
	it("boolean field of step stock -> inStock", () => {
		expect(lowerCondition({ left: "ctx.state.stock.inStock" })).toBe("ctx.state.stock.inStock");
	});

	it("whole-output boolean of step isOk", () => {
		expect(lowerCondition({ left: "ctx.state.isOk" })).toBe("ctx.state.isOk");
	});

	it("eq(a.field, 'x')", () => {
		expect(lowerCondition({ left: "ctx.state.a.field", comparator: "===", right: "x" })).toBe(
			'ctx.state.a.field === "x"',
		);
	});

	it("gt(a.count, b.limit)", () => {
		expect(lowerCondition({ left: "ctx.state.a.count", comparator: ">", right: "ctx.state.b.limit" })).toBe(
			"ctx.state.a.count > ctx.state.b.limit",
		);
	});

	it("not(a.ok)", () => {
		expect(lowerCondition({ left: "ctx.state.a.ok", negated: true })).toBe("!(ctx.state.a.ok)");
	});

	it("negates a comparison as a whole: !(a.count > b.limit)", () => {
		expect(
			lowerCondition({ left: "ctx.state.a.count", comparator: ">", right: "ctx.state.b.limit", negated: true }),
		).toBe("!(ctx.state.a.count > ctx.state.b.limit)");
	});
});

describe("lowerCondition — js/ prefix stripping", () => {
	it("strips js/ off the left operand", () => {
		expect(lowerCondition({ left: "js/ctx.state.a.ok" })).toBe("ctx.state.a.ok");
	});

	it("strips js/ off the right operand", () => {
		expect(lowerCondition({ left: "ctx.state.a.count", comparator: ">", right: "js/ctx.state.b.limit" })).toBe(
			"ctx.state.a.count > ctx.state.b.limit",
		);
	});
});

describe("lowerCondition — right-operand literal quoting rules", () => {
	const left = "ctx.state.a.value";
	const cases: Array<[string, string, string]> = [
		["number", "42", "42"],
		["negative number", "-1.5", "-1.5"],
		["true", "true", "true"],
		["false", "false", "false"],
		["null", "null", "null"],
		["already-quoted string", '"hello"', '"hello"'],
		["ctx expression", "ctx.state.b.limit", "ctx.state.b.limit"],
		["bracketed ctx expression", "ctx.state['book-car']", "ctx.state['book-car']"],
		["bare word gets quoted", "active", '"active"'],
	];
	for (const [label, right, expected] of cases) {
		it(label, () => {
			expect(lowerCondition({ left, comparator: "===", right })).toBe(`${left} === ${expected}`);
		});
	}
});

describe("parseCondition — simple shape round-trips (parse then re-lower to the identical string)", () => {
	const roundTrips: Array<[string, StructuredCondition]> = [
		["ctx.state.stock.inStock", { left: "ctx.state.stock.inStock" }],
		['ctx.state["is-ok"]', { left: 'ctx.state["is-ok"]' }],
		["!(ctx.state.a.ok)", { left: "ctx.state.a.ok", negated: true }],
		['ctx.state.a.field === "x"', { left: "ctx.state.a.field", comparator: "===", right: '"x"' }],
		[
			"ctx.state.a.count > ctx.state.b.limit",
			{ left: "ctx.state.a.count", comparator: ">", right: "ctx.state.b.limit" },
		],
		[
			"!(ctx.state.a.count > ctx.state.b.limit)",
			{ left: "ctx.state.a.count", comparator: ">", right: "ctx.state.b.limit", negated: true },
		],
		// Real condition from triggers/http/workflows/json/v05-nested-control-flow.json.
		["ctx.state.item.required === true", { left: "ctx.state.item.required", comparator: "===", right: "true" }],
	];
	for (const [when, expected] of roundTrips) {
		it(`parses "${when}"`, () => {
			expect(parseCondition(when)).toEqual(expected);
		});

		it(`re-lowers "${when}" to itself`, () => {
			const parsed = parseCondition(when);
			expect(parsed).not.toBeNull();
			expect(lowerCondition(parsed as StructuredCondition)).toBe(when);
		});
	}

	// Hand-written unparenthesized negation is accepted on parse, but our own
	// lowering always emits the parenthesized form (matching `not()` in
	// core/workflow-helper) — so this one normalizes rather than round-tripping
	// byte-for-byte, which is expected structural-editor behavior, not a bug.
	it("accepts unparenthesized negation and normalizes it to the parenthesized form", () => {
		expect(parseCondition("!ctx.state.a.ok")).toEqual({ left: "ctx.state.a.ok", negated: true });
		expect(lowerCondition({ left: "ctx.state.a.ok", negated: true })).toBe("!(ctx.state.a.ok)");
	});
});

describe("parseCondition — returns null for anything structurally too complex", () => {
	const rejected: Array<[string, string]> = [
		// Real condition from triggers/http/workflows/json/db-manager.json: && plus a method call.
		["&& and a method call", 'ctx.request.method.toLowerCase() === "get" && ctx.request.params.function === undefined'],
		["||", "ctx.state.a.ok || ctx.state.b.ok"],
		["ternary", "ctx.state.a.ok ? true : false"],
		["template literal", "`${ctx.state.a.ok}`"],
		["bare function call", "ctx.state.a.isReady()"],
		[
			// Real condition from triggers/http/workflows/json/v05-travel-booking.json: right operand
			// `undefined` isn't a JSON literal or a ctx expression — re-lowering it would silently
			// turn it into the STRING "undefined", corrupting the condition. Conservatively bail.
			"comparison against the bare keyword undefined",
			"ctx.state['book-car'] !== undefined",
		],
		[
			// Real condition from triggers/http/workflows/json/v07-ws-echo.json: single-quoted JS
			// string literal isn't valid JSON — same corruption risk as above.
			"single-quoted string literal",
			"ctx.request.body.event === 'connect'",
		],
		["empty string", ""],
		["whitespace only", "   "],
	];
	for (const [label, when] of rejected) {
		it(label, () => {
			expect(parseCondition(when)).toBeNull();
		});
	}
});
