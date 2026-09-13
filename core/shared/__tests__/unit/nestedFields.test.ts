/**
 * #1016 — bracket-key expansion for form bodies (the shape the stock Inertia
 * client puts on the wire) plus its two guard rails: the depth cap and the
 * prototype-key filter.
 */

import { describe, expect, it } from "vitest";
import { parseHttpRequest } from "../../src/utils/httpRequestBody";
import { MAX_FIELD_DEPTH, UNSAFE_KEY_SEGMENTS, expandFormEntries } from "../../src/utils/nestedFields";

const urlencoded = (body: string): Promise<Record<string, unknown>> =>
	parseHttpRequest(
		new Request("http://localhost/f", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		}),
	).then((parsed) => parsed.body as Record<string, unknown>);

describe("expandFormEntries", () => {
	it("builds nested objects from `a[b][c]`", () => {
		expect(expandFormEntries([["user[address][city]", "Lisbon"]])).toEqual({
			user: { address: { city: "Lisbon" } },
		});
	});

	it("builds arrays from numeric and empty brackets, in order", () => {
		expect(
			expandFormEntries([
				["tags[0]", "x"],
				["tags[1]", "y"],
			]),
		).toEqual({ tags: ["x", "y"] });
		expect(
			expandFormEntries([
				["tags[]", "x"],
				["tags[]", "y"],
			]),
		).toEqual({ tags: ["x", "y"] });
	});

	it("keeps plain keys flat and applies last-wins to duplicates", () => {
		expect(
			expandFormEntries([
				["name", "first"],
				["name", "second"],
			]),
		).toEqual({ name: "second" });
	});

	it(`keeps keys deeper than ${MAX_FIELD_DEPTH} segments flat`, () => {
		const deep = "a[b][c][d][e]"; // 5 segments — still expanded
		const deeper = "a2[b][c][d][e][f]"; // 6 — kept flat
		const out = expandFormEntries([
			[deep, 1],
			[deeper, 2],
		]);
		expect(out).toEqual({ a: { b: { c: { d: { e: 1 } } } }, "a2[b][c][d][e][f]": 2 });
	});

	it("falls back to the flat key on mixed usage", () => {
		// `a` is a leaf, then used as a container — and the reverse.
		expect(
			expandFormEntries([
				["a", "scalar"],
				["a[b]", "nested"],
			]),
		).toEqual({ a: "scalar", "a[b]": "nested" });
		expect(
			expandFormEntries([
				["b[c]", "nested"],
				["b[c][d]", "deeper"],
			]),
		).toEqual({ b: { c: "nested" }, "b[c][d]": "deeper" });
	});

	it("drops every prototype key segment", () => {
		for (const unsafe of UNSAFE_KEY_SEGMENTS) {
			const out = expandFormEntries([
				[unsafe, "x"],
				[`a[${unsafe}][b]`, "y"],
				["kept", "z"],
			]);
			expect(out).toEqual({ kept: "z" });
		}
		expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
	});
});

describe("urlencoded bodies get the same expansion", () => {
	it("expands nested objects and arrays", async () => {
		expect(await urlencoded("user%5Bname%5D=a&tags%5B0%5D=x&tags%5B1%5D=y")).toEqual({
			user: { name: "a" },
			tags: ["x", "y"],
		});
	});

	it("refuses `constructor[prototype][polluted]=1`", async () => {
		const body = await urlencoded("constructor%5Bprototype%5D%5Bpolluted%5D=1&ok=2");

		expect(body).toEqual({ ok: "2" });
		expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
		expect(({} as Record<string, unknown>).constructor).toBe(Object);
	});
});
