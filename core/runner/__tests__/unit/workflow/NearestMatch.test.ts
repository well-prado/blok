import { describe, expect, it } from "vitest";
import { levenshteinDistance, nearestMatches } from "../../../src/workflow/NearestMatch";

describe("levenshteinDistance", () => {
	it("is 0 for identical strings", () => {
		expect(levenshteinDistance("orders", "orders")).toBe(0);
	});

	it("counts a single substitution as distance 1", () => {
		expect(levenshteinDistance("orders", "orers")).toBe(1); // dropped a char too, still small
		expect(levenshteinDistance("orders", "ordars")).toBe(1); // one substitution
	});

	it("handles empty strings", () => {
		expect(levenshteinDistance("", "abc")).toBe(3);
		expect(levenshteinDistance("abc", "")).toBe(3);
	});
});

describe("nearestMatches", () => {
	const candidates = [
		{ key: "GET /orders", label: "GET /orders", source: "workflows/json/orders.json" },
		{ key: "GET /users", label: "GET /users", source: "workflows/json/users.json" },
		{ key: "POST /orders", label: "POST /orders", source: "workflows/json/orders-create.json" },
	];

	it("ranks a one-character typo of a registered route as the closest match", () => {
		const ranked = nearestMatches("GET /orers", candidates);
		expect(ranked[0].key).toBe("GET /orders");
		expect(ranked[0].distance).toBe(1);
		expect(ranked[0].source).toBe("workflows/json/orders.json");
	});

	it("returns at most `limit` results, closest first", () => {
		const ranked = nearestMatches("GET /orders", candidates, 2);
		expect(ranked).toHaveLength(2);
		expect(ranked[0].distance).toBeLessThanOrEqual(ranked[1].distance);
	});
});
