import {
	type SavedFilter,
	clearSavedFilters,
	deleteSavedFilter,
	loadSavedFilters,
	saveFilter,
} from "@/lib/savedFilters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("savedFilters (Tier 2 follow-up)", () => {
	beforeEach(() => {
		// jsdom provides a localStorage; clear before each test for isolation.
		window.localStorage.clear();
	});

	afterEach(() => {
		window.localStorage.clear();
	});

	const filter: SavedFilter = {
		name: "premium-tenants",
		status: "running",
		tagsInput: "premium",
		metadataInput: "tier=premium",
	};

	it("loadSavedFilters returns empty array when storage is empty", () => {
		expect(loadSavedFilters()).toEqual([]);
	});

	it("saveFilter persists a filter and returns the new list", () => {
		const next = saveFilter(filter);
		expect(next).toHaveLength(1);
		expect(loadSavedFilters()).toEqual([filter]);
	});

	it("saveFilter overwrites an existing filter with the same name", () => {
		saveFilter(filter);
		const updated = { ...filter, status: "failed" };
		const next = saveFilter(updated);
		expect(next).toHaveLength(1);
		expect(next[0]?.status).toBe("failed");
	});

	it("deleteSavedFilter removes a filter by name", () => {
		saveFilter(filter);
		const f2 = { ...filter, name: "free-tier" };
		saveFilter(f2);
		const next = deleteSavedFilter("premium-tenants");
		expect(next).toHaveLength(1);
		expect(next[0]?.name).toBe("free-tier");
	});

	it("deleteSavedFilter on unknown name is a no-op", () => {
		saveFilter(filter);
		const next = deleteSavedFilter("ghost");
		expect(next).toHaveLength(1);
	});

	it("clearSavedFilters removes everything", () => {
		saveFilter(filter);
		clearSavedFilters();
		expect(loadSavedFilters()).toEqual([]);
	});

	it("loadSavedFilters silently drops malformed entries", () => {
		// Hand-write a corrupt blob.
		window.localStorage.setItem(
			"blok.studio.savedFilters",
			JSON.stringify([filter, { name: "broken" /* missing fields */ }, "not an object"]),
		);
		const loaded = loadSavedFilters();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.name).toBe("premium-tenants");
	});

	it("loadSavedFilters returns [] when JSON is invalid", () => {
		window.localStorage.setItem("blok.studio.savedFilters", "not-json");
		expect(loadSavedFilters()).toEqual([]);
	});
});
