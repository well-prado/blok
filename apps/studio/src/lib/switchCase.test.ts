import { describe, expect, it } from "vitest";
import { formatCaseLiteral, parseCaseLiteral } from "./switchCase";

describe("formatCaseLiteral", () => {
	it("shows a plain string unquoted", () => {
		expect(formatCaseLiteral("physical")).toBe("physical");
	});

	it("JSON-stringifies a number", () => {
		expect(formatCaseLiteral(42)).toBe("42");
	});

	it("JSON-stringifies a boolean", () => {
		expect(formatCaseLiteral(true)).toBe("true");
	});

	it("JSON-stringifies an array (array.includes grouping)", () => {
		expect(formatCaseLiteral(["a", "b"])).toBe('["a","b"]');
	});

	it("shows an empty string for undefined", () => {
		expect(formatCaseLiteral(undefined)).toBe("");
	});
});

describe("parseCaseLiteral", () => {
	it("keeps a bare word as a plain string", () => {
		expect(parseCaseLiteral("physical")).toBe("physical");
	});

	it("parses a number", () => {
		expect(parseCaseLiteral("42")).toBe(42);
	});

	it("parses a boolean", () => {
		expect(parseCaseLiteral("true")).toBe(true);
	});

	it("parses an array", () => {
		expect(parseCaseLiteral('["a","b"]')).toEqual(["a", "b"]);
	});

	it("dequotes an explicitly-quoted string", () => {
		expect(parseCaseLiteral('"hello"')).toBe("hello");
	});

	it("keeps an empty string as-is (invalid JSON, falls back to raw text)", () => {
		expect(parseCaseLiteral("")).toBe("");
	});
});

describe("formatCaseLiteral/parseCaseLiteral round-trip", () => {
	const values: unknown[] = ["physical", "digital", 42, true, false, ["a", "b"]];
	for (const value of values) {
		it(`round-trips ${JSON.stringify(value)}`, () => {
			expect(parseCaseLiteral(formatCaseLiteral(value))).toEqual(value);
		});
	}
});
