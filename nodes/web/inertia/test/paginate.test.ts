/**
 * Issue #1010 — the `paginate()` / `cursorPaginate()` envelopes.
 *
 * Pure functions, so these are pure assertions: the cursor arithmetic and the
 * two input modes (slice an in-memory collection vs trust a database page).
 * Their behaviour THROUGH a page step lives in `page-scroll.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cursorPaginate, cursorPaginatedSchema, paginate, paginatedSchema } from "../src/paginate.js";

const ROWS = Array.from({ length: 20 }, (_, i) => `p-${i + 1}`);

describe("paginate", () => {
	it("slices an in-memory collection and derives the cursors", () => {
		expect(paginate(ROWS, { page: 1, perPage: 10 })).toEqual({
			data: ROWS.slice(0, 10),
			pageName: "page",
			currentPage: 1,
			previousPage: null,
			nextPage: 2,
			perPage: 10,
			total: 20,
		});
	});

	it("the last page has no next, and a middle page has both", () => {
		expect(paginate(ROWS, { page: 2, perPage: 10 })).toMatchObject({
			data: ROWS.slice(10),
			previousPage: 1,
			nextPage: null,
			currentPage: 2,
		});
		expect(paginate(ROWS, { page: 2, perPage: 5 })).toMatchObject({ previousPage: 1, nextPage: 3, total: 20 });
	});

	it("`total` means the caller already paged — the items pass through untouched", () => {
		expect(paginate(ROWS.slice(0, 10), { page: 3, perPage: 10, total: 95 })).toMatchObject({
			data: ROWS.slice(0, 10),
			currentPage: 3,
			previousPage: 2,
			nextPage: 4,
			total: 95,
		});
	});

	it("reads a query-string page, and falls back to page 1 on junk", () => {
		expect(paginate(ROWS, { page: "2", perPage: 10 }).currentPage).toBe(2);
		expect(paginate(ROWS, { page: "banana", perPage: 10 })).toMatchObject({ currentPage: 1, nextPage: 2 });
		expect(paginate(ROWS, { page: 0, perPage: 10 }).currentPage).toBe(1);
	});

	it("an empty collection has no pages either side", () => {
		expect(paginate([], { page: 1, perPage: 10 })).toMatchObject({
			data: [],
			previousPage: null,
			nextPage: null,
			total: 0,
		});
	});

	it("`pageName` rides the envelope, and the output satisfies its own schema", () => {
		const page = paginate(ROWS, { page: 1, perPage: 10, pageName: "users" });
		expect(page.pageName).toBe("users");
		expect(paginatedSchema(z.string()).parse(page)).toEqual(page);
	});
});

describe("cursorPaginate", () => {
	it("carries the cursor strings through as the page identifiers", () => {
		const page = cursorPaginate(ROWS.slice(0, 3), { cursor: "eyJpZCI6MTB9", next: "eyJpZCI6MjB9", prev: null });
		expect(page).toEqual({
			data: ROWS.slice(0, 3),
			pageName: "cursor",
			currentPage: "eyJpZCI6MTB9",
			previousPage: null,
			nextPage: "eyJpZCI6MjB9",
		});
		expect(cursorPaginatedSchema(z.string()).parse(page)).toEqual(page);
	});

	it("defaults every cursor to null, and takes a custom pageName", () => {
		expect(cursorPaginate([], { pageName: "after" })).toEqual({
			data: [],
			pageName: "after",
			currentPage: null,
			previousPage: null,
			nextPage: null,
		});
	});
});
